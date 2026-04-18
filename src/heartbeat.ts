import type { Logger } from "pino";
import type { DashboardClient } from "./dashboard-client.js";
import type { PortalClient, HeartbeatPayload } from "./portal-client.js";
import type { PersistentQueue } from "./persistent-queue.js";

/**
 * Periodic heartbeat task — fires every `intervalSec` after startup.
 * Reports liveness + last-known robot state + local queue depths.
 *
 * Failures are logged and swallowed — portal treats a missing heartbeat as
 * "device offline" after 2 * intervalSec (see portal-stimba-sk §alerts).
 */

export interface HeartbeatRunnerOptions {
  intervalSec: number;
  agentVersion: string;
  startedAt: number;
  portal: PortalClient;
  dashboard: DashboardClient;
  metricsQueue: PersistentQueue<unknown>;
  auditQueue: PersistentQueue<unknown>;
  logger: Logger;
}

export class HeartbeatRunner {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly opts: HeartbeatRunnerOptions) {}

  start(): void {
    const tick = async () => {
      if (this.stopping) return;
      try {
        const payload = await this.buildPayload();
        await this.opts.portal.heartbeat(payload);
        this.opts.logger.debug({ payload }, "heartbeat sent");
      } catch (err) {
        this.opts.logger.warn(
          { err: (err as Error).message },
          "heartbeat failed",
        );
      } finally {
        if (!this.stopping) {
          this.timer = setTimeout(tick, this.opts.intervalSec * 1000);
        }
      }
    };
    // Fire first one immediately (gives portal quick presence signal after boot)
    tick();
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async buildPayload(): Promise<HeartbeatPayload> {
    // Best-effort Dashboard reads. If connection is down, fields are null.
    let robotMode: string | null = null;
    let safetyStatus: string | null = null;
    let loadedProgram: string | null = null;
    let programRunning: boolean | null = null;
    let dashboardConnected = false;

    try {
      robotMode = await this.opts.dashboard.getRobotMode();
      dashboardConnected = true;
    } catch {
      /* ignore — reported as null */
    }
    try {
      safetyStatus = await this.opts.dashboard.getSafetyStatus();
    } catch { /* */ }
    try {
      loadedProgram = await this.opts.dashboard.getLoadedProgram();
    } catch { /* */ }
    try {
      programRunning = await this.opts.dashboard.isProgramRunning();
    } catch { /* */ }

    return {
      ts: new Date().toISOString(),
      agentVersion: this.opts.agentVersion,
      uptimeS: Math.round((Date.now() - this.opts.startedAt) / 1000),
      robotMode,
      safetyStatus,
      loadedProgram,
      programRunning,
      rtdeConnected: false, // TODO(sprint-6-w2) wire from RtdeClient status
      dashboardConnected,
      queueDepth: {
        metrics: this.opts.metricsQueue.depth(),
        audit: this.opts.auditQueue.depth(),
      },
    };
  }
}
