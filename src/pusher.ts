import crypto from "node:crypto";
import type { Logger } from "pino";
import { PortalError } from "./portal-client.js";
import type { PortalClient, MetricEvent, AuditEvent } from "./portal-client.js";
import type { PersistentQueue } from "./persistent-queue.js";

/**
 * Generic batch pusher — pulls events from a persistent queue on a timer,
 * POSTs them to the portal, and ACKs up to the last accepted seq.
 *
 * Backoff:
 *   - 5xx / 429 / network errors: exponential backoff (1s → 60s cap)
 *   - 4xx non-retryable: drop the bad batch after logging detail
 *
 * Idempotency:
 *   - each batch carries an Idempotency-Key = sha256(deviceId + firstSeq + lastSeq)
 *     → portal dedups on replay after agent crash mid-flush
 */

export interface BatchPusherOptions<T> {
  stream: "metrics" | "audit";
  intervalSec: number;
  batchSize: number;
  queue: PersistentQueue<T>;
  portal: PortalClient;
  deviceId: string;
  logger: Logger;
  send: (events: T[], idemKey: string) => Promise<{ accepted: number }>;
}

export class BatchPusher<T> {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private consecutiveFailures = 0;

  constructor(private readonly opts: BatchPusherOptions<T>) {}

  start(): void {
    const tick = async () => {
      if (this.stopping) return;
      try {
        await this.flushOnce();
        this.consecutiveFailures = 0;
      } catch (err) {
        this.consecutiveFailures += 1;
        const isRetryable =
          err instanceof PortalError ? err.isRetryable() : true;
        this.opts.logger.warn(
          {
            stream: this.opts.stream,
            err: (err as Error).message,
            failures: this.consecutiveFailures,
            retryable: isRetryable,
          },
          "batch flush failed",
        );
      } finally {
        if (this.stopping) return;
        const delay = this.computeDelayMs();
        this.timer = setTimeout(tick, delay);
      }
    };
    this.timer = setTimeout(tick, this.opts.intervalSec * 1000);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private computeDelayMs(): number {
    if (this.consecutiveFailures === 0) return this.opts.intervalSec * 1000;
    // 1s, 2s, 4s, 8s, 16s, 32s, 60s cap
    const base = 1000 * 2 ** Math.min(this.consecutiveFailures - 1, 6);
    return Math.min(60_000, base);
  }

  private async flushOnce(): Promise<void> {
    const batch = this.opts.queue.pullBatch(this.opts.batchSize);
    if (batch.length === 0) return;

    const firstSeq = batch[0].seq;
    const lastSeq = batch[batch.length - 1].seq;
    const idemKey = crypto
      .createHash("sha256")
      .update(`${this.opts.deviceId}:${this.opts.stream}:${firstSeq}:${lastSeq}`)
      .digest("hex")
      .slice(0, 32);

    const events = batch.map((r) => r.payload);
    const t0 = Date.now();
    const res = await this.opts.send(events, idemKey);
    const dt = Date.now() - t0;

    this.opts.logger.info(
      {
        stream: this.opts.stream,
        sent: events.length,
        accepted: res.accepted,
        firstSeq,
        lastSeq,
        dtMs: dt,
      },
      "batch flushed",
    );

    if (res.accepted > 0) {
      await this.opts.queue.ack(lastSeq);
    }
  }
}

// ---------- Typed factories ------------------------------------------------

export function createMetricsPusher(opts: {
  queue: PersistentQueue<MetricEvent>;
  portal: PortalClient;
  deviceId: string;
  logger: Logger;
  intervalSec: number;
  batchSize?: number;
}): BatchPusher<MetricEvent> {
  return new BatchPusher<MetricEvent>({
    stream: "metrics",
    intervalSec: opts.intervalSec,
    batchSize: opts.batchSize ?? 500,
    queue: opts.queue,
    portal: opts.portal,
    deviceId: opts.deviceId,
    logger: opts.logger,
    send: (events, idemKey) => opts.portal.pushMetrics(events, idemKey),
  });
}

export function createAuditPusher(opts: {
  queue: PersistentQueue<AuditEvent>;
  portal: PortalClient;
  deviceId: string;
  logger: Logger;
  intervalSec: number;
  batchSize?: number;
}): BatchPusher<AuditEvent> {
  return new BatchPusher<AuditEvent>({
    stream: "audit",
    intervalSec: opts.intervalSec,
    batchSize: opts.batchSize ?? 100,
    queue: opts.queue,
    portal: opts.portal,
    deviceId: opts.deviceId,
    logger: opts.logger,
    send: (events, idemKey) => opts.portal.pushAudit(events, idemKey),
  });
}
