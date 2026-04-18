import type { Logger } from "pino";
import type { DashboardClient } from "./dashboard-client.js";
import type { PersistentQueue } from "./persistent-queue.js";
import type { MetricEvent } from "./portal-client.js";

/**
 * v0 metrics collector — polls Dashboard at 1 Hz and enqueues coarse metrics.
 *
 * For v1 (Sprint 6 Week 2) this will be replaced by RTDE subscription at
 * 10-125 Hz, providing actual_q / actual_qd / actual_current / TCP pose.
 *
 * Metric key convention matches portal-stimba-sk/wiki/05-metrics-catalog.md:
 *   - robot.mode              text
 *   - robot.safety_status     text
 *   - robot.program_running   bool
 *   - robot.loaded_program    text  (emitted only on change to avoid churn)
 */

export interface MetricsCollectorOptions {
  intervalSec: number;
  dashboard: DashboardClient;
  queue: PersistentQueue<MetricEvent>;
  logger: Logger;
}

export class MetricsCollector {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private lastLoadedProgram: string | null = null;

  constructor(private readonly opts: MetricsCollectorOptions) {}

  start(): void {
    const tick = async () => {
      if (this.stopping) return;
      try {
        await this.collectOnce();
      } catch (err) {
        this.opts.logger.warn(
          { err: (err as Error).message },
          "metrics collect failed",
        );
      } finally {
        if (!this.stopping) {
          this.timer = setTimeout(tick, this.opts.intervalSec * 1000);
        }
      }
    };
    this.timer = setTimeout(tick, this.opts.intervalSec * 1000);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async collectOnce(): Promise<void> {
    const ts = new Date().toISOString();
    const [modeR, safetyR, runningR, loadedR] = await Promise.allSettled([
      this.opts.dashboard.getRobotMode(),
      this.opts.dashboard.getSafetyStatus(),
      this.opts.dashboard.isProgramRunning(),
      this.opts.dashboard.getLoadedProgram(),
    ]);

    const events: MetricEvent[] = [];

    if (modeR.status === "fulfilled") {
      events.push({ ts, metricKey: "robot.mode", kind: "text", valueText: modeR.value });
    }
    if (safetyR.status === "fulfilled") {
      events.push({
        ts,
        metricKey: "robot.safety_status",
        kind: "text",
        valueText: safetyR.value,
      });
    }
    if (runningR.status === "fulfilled") {
      events.push({
        ts,
        metricKey: "robot.program_running",
        kind: "bool",
        valueBool: runningR.value,
      });
    }
    if (loadedR.status === "fulfilled" && loadedR.value !== this.lastLoadedProgram) {
      events.push({
        ts,
        metricKey: "robot.loaded_program",
        kind: "text",
        valueText: loadedR.value ?? "",
      });
      this.lastLoadedProgram = loadedR.value;
    }

    for (const ev of events) {
      await this.opts.queue.push(ev);
    }
  }
}
