import pino, { type Logger } from "pino";

/**
 * Structured JSON logger. In production we emit one JSON line per log entry
 * (collected by URCapX log aggregation or `docker logs`). In dev we pretty-
 * print via `pino-pretty`.
 *
 * Convention:
 *   - `deviceId` + `deviceSerial` are ALWAYS in the base context
 *   - `component` identifies the caller (dashboard, rtde, metrics-pusher, …)
 *   - `correlationId` is attached per-request by api-server.ts
 */

export function createLogger(opts: {
  level: pino.LevelWithSilent;
  deviceId: string;
  deviceSerial: string;
  polyscope: string;
  urcapVersion: string;
}): Logger {
  const isDev = process.env.NODE_ENV !== "production";
  return pino({
    level: opts.level,
    base: {
      pid: process.pid,
      deviceId: opts.deviceId,
      deviceSerial: opts.deviceSerial,
      polyscope: opts.polyscope,
      urcapVersion: opts.urcapVersion,
      service: "stimba-ur-control-agent",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "portalToken",
        "listenAuthToken",
        "*.portalToken",
        "*.listenAuthToken",
        "req.headers.authorization",
        "req.headers['x-stimba-token']",
      ],
      censor: "[REDACTED]",
    },
    ...(isDev && {
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      },
    }),
  });
}
