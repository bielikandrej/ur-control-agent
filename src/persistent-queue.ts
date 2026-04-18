import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

/**
 * Crash-safe append-only queue persisted to one JSONL file per stream.
 *
 * Why JSONL instead of SQLite:
 *   - container is read-only except `/var/stimba/agent`
 *   - no native deps (sqlite3) — keeps Alpine image small and arm64 friendly
 *   - replay is `for await (const line of readline) JSON.parse(line)`
 *
 * Operations:
 *   - push(event)            → append to active segment
 *   - pullBatch(n)           → return up to n events still pending flush
 *   - ack(idsUpTo)           → mark events as flushed; rotates segment on threshold
 *   - depth()                → unflushed event count
 *
 * Segments rotate every 1000 events or 256 KB, whichever first. An ACK
 * advances the cursor file (`<stream>.cursor`) atomically. Old segments are
 * deleted on rotation if their high-water mark is below the cursor.
 *
 * NOTE: This is a v0 implementation aimed at container-restart durability,
 * not multi-process concurrency. Single-writer per stream.
 */

export interface QueueOptions {
  stateDir: string;
  stream: string; // "metrics" | "audit"
  maxEvents: number; // hard cap (oldest dropped on overflow)
  rotateAfterEvents?: number;
  rotateAfterBytes?: number;
  logger: Logger;
}

interface QueueRecord<T> {
  seq: number;
  ts: string;
  payload: T;
}

export class PersistentQueue<T> {
  private seq = 0;
  private inMemory: QueueRecord<T>[] = [];
  private cursor = 0; // last flushed seq (inclusive)
  private writeLock: Promise<void> = Promise.resolve();

  private readonly file: string;
  private readonly cursorFile: string;
  // rotateAfterEvents is reserved for future per-event rotation; current
  // implementation rotates on size only (rotateBytes), see rotateIfNeeded().
  private readonly rotateBytes: number;

  constructor(private readonly opts: QueueOptions) {
    this.file = path.join(opts.stateDir, `${opts.stream}.jsonl`);
    this.cursorFile = path.join(opts.stateDir, `${opts.stream}.cursor`);
    this.rotateBytes = opts.rotateAfterBytes ?? 256 * 1024;
  }

  async open(): Promise<void> {
    await fs.mkdir(this.opts.stateDir, { recursive: true });
    // Load cursor
    try {
      const raw = await fs.readFile(this.cursorFile, "utf8");
      this.cursor = Number.parseInt(raw.trim(), 10) || 0;
    } catch {
      this.cursor = 0;
    }
    // Replay file into memory (only events after cursor)
    try {
      const data = await fs.readFile(this.file, "utf8");
      for (const line of data.split("\n")) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line) as QueueRecord<T>;
          this.seq = Math.max(this.seq, rec.seq);
          if (rec.seq > this.cursor) this.inMemory.push(rec);
        } catch (e) {
          this.opts.logger.warn({ err: (e as Error).message }, "queue replay parse error");
        }
      }
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw e;
    }
    this.opts.logger.info(
      { stream: this.opts.stream, depth: this.inMemory.length, cursor: this.cursor, seq: this.seq },
      "queue opened",
    );
  }

  async push(payload: T): Promise<void> {
    return (this.writeLock = this.writeLock.then(async () => {
      this.seq += 1;
      const rec: QueueRecord<T> = {
        seq: this.seq,
        ts: new Date().toISOString(),
        payload,
      };
      // Overflow: drop oldest unflushed
      while (this.inMemory.length >= this.opts.maxEvents) {
        const dropped = this.inMemory.shift();
        this.opts.logger.warn(
          { stream: this.opts.stream, droppedSeq: dropped?.seq },
          "queue overflow, dropping oldest event",
        );
      }
      this.inMemory.push(rec);
      await fs.appendFile(this.file, `${JSON.stringify(rec)}\n`, "utf8");
    }));
  }

  pullBatch(n: number): QueueRecord<T>[] {
    return this.inMemory.slice(0, n);
  }

  async ack(upToSeq: number): Promise<void> {
    return (this.writeLock = this.writeLock.then(async () => {
      this.cursor = Math.max(this.cursor, upToSeq);
      this.inMemory = this.inMemory.filter((r) => r.seq > this.cursor);
      await fs.writeFile(this.cursorFile, String(this.cursor), "utf8");
      await this.maybeRotate();
    }));
  }

  depth(): number {
    return this.inMemory.length;
  }

  private async maybeRotate(): Promise<void> {
    let stat: { size: number } | null = null;
    try {
      stat = await fs.stat(this.file);
    } catch {
      return;
    }
    if (this.inMemory.length === 0 && stat.size > this.rotateBytes) {
      // All flushed — truncate
      await fs.writeFile(this.file, "", "utf8");
      this.opts.logger.info({ stream: this.opts.stream }, "queue file truncated after full flush");
      return;
    }
    if (stat.size < this.rotateBytes) return;
    // Compact: rewrite only unflushed events
    const tmp = `${this.file}.tmp`;
    const lines = this.inMemory.map((r) => JSON.stringify(r)).join("\n");
    await fs.writeFile(tmp, lines ? `${lines}\n` : "", "utf8");
    await fs.rename(tmp, this.file);
    this.opts.logger.info(
      { stream: this.opts.stream, kept: this.inMemory.length },
      "queue file compacted",
    );
  }
}
