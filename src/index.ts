/**
 * STIMBA UR Control Agent — entrypoint.
 *
 * Bootstraps in this order:
 *   1. loadConfig()                      — parse + validate env
 *   2. createLogger()                    — structured pino
 *   3. open persistent queues            — replay unflushed events from disk
 *   4. connect Dashboard client          — TCP :29999 on urcontrol-primary
 *   5. connect RTDE client (skeleton)    — TCP :30004 (no-op in v0)
 *   6. start MetricsCollector            — 1 Hz polling
 *   7. start HeartbeatRunner             — every 30s default
 *   8. start metrics + audit pushers     — flush queues to portal
 *   9. start API server                  — 127.0.0.1:8787 for URCap UI
 *  10. wait for SIGTERM/SIGINT           — graceful shutdown
 *
 * Failure semantics:
 *   - missing/bad config           → exit(1) immediately (no retry)
 *   - portal unreachable           → log + retry forever (events buffered)
 *   - dashboard unreachable        → log + reconnect with backoff
 *   - api server bind error        → exit(1) (port collision is fatal)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { DashboardClient } from "./dashboard-client.js";
import { RtdeClient } from "./rtde-client.js";
import { PersistentQueue } from "./persistent-queue.js";
import { PortalClient, type MetricEvent, type AuditEvent } from "./portal-client.js";
import { HeartbeatRunner } from "./heartbeat.js";
import { MetricsCollector } from "./metrics-collector.js";
import { createMetricsPusher, createAuditPusher } from "./pusher.js";
import { buildApiServer } from "./api-server.js";

// Read version from package.json at runtime rather than via a JSON import,
// so that tsc's rootDir constraint (./src) doesn't complain about an import
// outside the source tree. The file sits next to dist/ in the container.
const PKG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
);
const VERSION: string = (() => {
  try {
    const raw = readFileSync(PKG_PATH, "utf8");
    const { version } = JSON.parse(raw) as { version?: string };
    return typeof version === "string" ? version : "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
})();

async function main(): Promise<void> {
  const startedAt = Date.now();
  const cfg = loadConfig();
  const log = createLogger({
    level: cfg.logLevel,
    deviceId: cfg.deviceId,
    deviceSerial: cfg.deviceSerial,
    polyscope: cfg.polyscope,
    urcapVersion: cfg.urcapVersion,
  });

  log.info(
    { version: VERSION, config: redactConfig(cfg) },
    "stimba-ur-control-agent starting",
  );

  // --- Persistent queues ---------------------------------------------------
  const metricsQueue = new PersistentQueue<MetricEvent>({
    stateDir: cfg.stateDir,
    stream: "metrics",
    maxEvents: cfg.metricBufferMax,
    logger: log.child({ component: "queue.metrics" }),
  });
  const auditQueue = new PersistentQueue<AuditEvent>({
    stateDir: cfg.stateDir,
    stream: "audit",
    maxEvents: cfg.auditQueueMax,
    logger: log.child({ component: "queue.audit" }),
  });
  await metricsQueue.open();
  await auditQueue.open();

  // --- Boot audit ----------------------------------------------------------
  await auditQueue.push({
    ts: new Date().toISOString(),
    kind: "agent.boot",
    actor: "agent",
    detail: { version: VERSION, polyscope: cfg.polyscope, urcapVersion: cfg.urcapVersion },
  });

  // --- Portal client -------------------------------------------------------
  const portal = new PortalClient({
    baseUrl: cfg.portalBaseUrl,
    token: cfg.portalToken,
    pinSha256: cfg.portalTlsPinSha256,
    deviceId: cfg.deviceId,
    logger: log.child({ component: "portal" }),
  });

  // --- Dashboard client ----------------------------------------------------
  const dashboard = new DashboardClient({
    host: cfg.urcontrolHost,
    port: cfg.urcontrolDashboardPort,
    logger: log.child({ component: "dashboard" }),
  });
  if (cfg.enableDashboard) {
    try {
      await dashboard.connect();
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        "initial dashboard connect failed; will retry in background",
      );
      // The DashboardClient's onClose handler doesn't fire if we never
      // connected. Start a one-shot delayed retry.
      setTimeout(() => {
        dashboard.connect().catch((e) =>
          log.warn({ err: e.message }, "dashboard delayed retry failed; entering reconnect loop"),
        );
      }, 2_000);
    }
  } else {
    log.warn("STIMBA_ENABLE_DASHBOARD=false — dashboard client disabled");
  }

  // --- RTDE client (skeleton) ---------------------------------------------
  const rtde = new RtdeClient({
    host: cfg.urcontrolHost,
    port: cfg.urcontrolRtdePort,
    pollHz: cfg.rtdePollHz,
    logger: log.child({ component: "rtde" }),
  });
  if (cfg.enableRtde) {
    await rtde.connect();
  }

  // --- Metrics collector --------------------------------------------------
  const metricsCollector = new MetricsCollector({
    intervalSec: 1,
    dashboard,
    queue: metricsQueue,
    logger: log.child({ component: "metrics-collector" }),
  });
  metricsCollector.start();

  // --- Heartbeat ----------------------------------------------------------
  const heartbeat = new HeartbeatRunner({
    intervalSec: cfg.heartbeatIntervalSec,
    agentVersion: VERSION,
    startedAt,
    portal,
    dashboard,
    metricsQueue,
    auditQueue,
    logger: log.child({ component: "heartbeat" }),
  });
  heartbeat.start();

  // --- Pushers ------------------------------------------------------------
  const metricsPusher = cfg.enableMetricsPush
    ? createMetricsPusher({
        queue: metricsQueue,
        portal,
        deviceId: cfg.deviceId,
        logger: log.child({ component: "pusher.metrics" }),
        intervalSec: cfg.metricsFlushIntervalSec,
      })
    : null;
  const auditPusher = cfg.enableAuditPush
    ? createAuditPusher({
        queue: auditQueue,
        portal,
        deviceId: cfg.deviceId,
        logger: log.child({ component: "pusher.audit" }),
        intervalSec: cfg.auditFlushIntervalSec,
      })
    : null;
  metricsPusher?.start();
  auditPusher?.start();

  // --- API server ---------------------------------------------------------
  const api = await buildApiServer({
    host: cfg.listenHost,
    port: cfg.listenPort,
    authToken: cfg.listenAuthToken,
    agentVersion: VERSION,
    startedAt,
    logger: log.child({ component: "api" }),
    dashboard,
    portal,
    auditQueue,
  });

  // --- Shutdown handling --------------------------------------------------
  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutdown initiated");
    metricsCollector.stop();
    heartbeat.stop();
    metricsPusher?.stop();
    auditPusher?.stop();
    await auditQueue.push({
      ts: new Date().toISOString(),
      kind: "agent.shutdown",
      actor: "agent",
      detail: { signal, uptimeS: Math.round((Date.now() - startedAt) / 1000) },
    });
    await api.close().catch(() => {});
    await dashboard.close();
    await rtde.close();
    log.info("shutdown complete");
    // Allow pino transport to flush
    setTimeout(() => process.exit(0), 100).unref();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Unhandled errors — log loudly but keep process alive (URCap container
  // restart policy is `always`, but we prefer to surface the error first).
  process.on("unhandledRejection", (reason) => {
    log.fatal({ reason: String(reason) }, "unhandledRejection");
  });
  process.on("uncaughtException", (err) => {
    log.fatal({ err: err.message, stack: err.stack }, "uncaughtException");
    // Force exit so container runtime restarts us cleanly
    setTimeout(() => process.exit(1), 100).unref();
  });
}

function redactConfig(cfg: ReturnType<typeof loadConfig>): Record<string, unknown> {
  return {
    ...cfg,
    portalToken: "[REDACTED]",
    listenAuthToken: "[REDACTED]",
  };
}

main().catch((err) => {
  // Pre-logger startup failure (e.g. bad env)
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    level: "fatal",
    msg: "fatal startup error",
    err: (err as Error).message,
    stack: (err as Error).stack,
  }));
  process.exit(1);
});
