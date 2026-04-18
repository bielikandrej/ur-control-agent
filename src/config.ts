/**
 * Agent configuration — resolved from environment variables at startup.
 *
 * All env vars are expected to be injected by URCapX runtime via manifest.yaml:
 *   - Static strings:   `value: "..."`
 *   - Secrets:          `valueFrom: { secureStorage: { key: "..." } }`
 *   - Device identity:  `valueFrom: { device: { field: "serialNumber" } }`
 *
 * For PS5 parity (Sprint 7), the URCap Java runtime writes the same env
 * bindings into `/etc/default/stimba-ur-control-agent` which systemd reads
 * before starting the service. See Sprint 7 §3 "Backward compatibility".
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// `z.coerce.boolean()` is a trap — it only checks truthiness of the string,
// so "false", "0", "no", "off" all become `true`. Operators expect the
// common strings to work. This helper treats the env-var-style negatives as
// false, and anything else follows JS truthiness.
const envBoolean = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["false", "0", "no", "off", "n"].includes(s)) return false;
  if (["true", "1", "yes", "on", "y"].includes(s)) return true;
  return v; // let zod complain — it's not a recognised bool string
}, z.boolean());

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  // --- Identity --------------------------------------------------------------
  deviceId: z.string().uuid().describe("Assigned by portal during pairing"),
  deviceSerial: z.string().min(3).describe("UR robot serial, read from URControl"),
  polyscope: z.enum(["ps5", "psx"]).default("psx"),
  urcapVersion: z.string().default("unknown"),

  // --- Portal target ---------------------------------------------------------
  portalBaseUrl: z.string().url().default("https://portal.stimba.sk"),
  portalToken: z.string().min(20).describe("Device-scoped JWT issued by pairing flow"),
  portalTlsPinSha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional()
    .describe("Optional TLS cert SHA-256 pin (Sprint 7 §2 security hardening)"),

  // --- UR endpoints ----------------------------------------------------------
  urcontrolHost: z.string().default("urcontrol-primary"),
  urcontrolDashboardPort: z.coerce.number().int().positive().default(29999),
  urcontrolRtdePort: z.coerce.number().int().positive().default(30004),
  urcontrolPrimaryPort: z.coerce.number().int().positive().default(30001),

  // --- Local HTTP listener (URCap UI panel → agent backchannel) --------------
  listenHost: z.string().default("127.0.0.1"),
  listenPort: z.coerce.number().int().positive().default(8787),
  listenAuthToken: z.string().min(16)
    .describe("Shared secret with URCap UI panel; generated at install"),

  // --- Persistence -----------------------------------------------------------
  stateDir: z.string().default("/var/stimba/agent"),
  auditQueueMax: z.coerce.number().int().positive().default(10_000),
  metricBufferMax: z.coerce.number().int().positive().default(5_000),

  // --- Cadence ---------------------------------------------------------------
  heartbeatIntervalSec: z.coerce.number().int().positive().default(30),
  auditFlushIntervalSec: z.coerce.number().int().positive().default(60),
  metricsFlushIntervalSec: z.coerce.number().int().positive().default(10),
  rtdePollHz: z.coerce.number().int().positive().max(125).default(10),

  // --- Ops -------------------------------------------------------------------
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  enableDashboard: envBoolean.default(true),
  // RTDE decoder is a stub until Sprint 6 Week 2 — default OFF so we don't
  // spam "not implemented" logs on first boot.
  enableRtde: envBoolean.default(false),
  enableMetricsPush: envBoolean.default(true),
  enableAuditPush: envBoolean.default(true),
});

export type AgentConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Env var mapping
// ---------------------------------------------------------------------------
// We keep env var names stable across PSX (container env) and PS5 (systemd
// EnvironmentFile) — changing them breaks Sprint 7 parity.

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const raw = {
    deviceId: env.STIMBA_DEVICE_ID,
    deviceSerial: env.STIMBA_DEVICE_SERIAL,
    polyscope: env.STIMBA_POLYSCOPE_VARIANT,
    urcapVersion: env.STIMBA_URCAP_VERSION,

    portalBaseUrl: env.STIMBA_PORTAL_URL,
    portalToken: env.STIMBA_PORTAL_TOKEN,
    portalTlsPinSha256: env.STIMBA_PORTAL_TLS_PIN,

    urcontrolHost: env.STIMBA_URCONTROL_HOST,
    urcontrolDashboardPort: env.STIMBA_URCONTROL_DASHBOARD_PORT,
    urcontrolRtdePort: env.STIMBA_URCONTROL_RTDE_PORT,
    urcontrolPrimaryPort: env.STIMBA_URCONTROL_PRIMARY_PORT,

    listenHost: env.STIMBA_AGENT_LISTEN_HOST,
    listenPort: env.STIMBA_AGENT_LISTEN_PORT,
    listenAuthToken: env.STIMBA_AGENT_LISTEN_TOKEN,

    stateDir: env.STIMBA_AGENT_STATE_DIR,
    auditQueueMax: env.STIMBA_AUDIT_QUEUE_MAX,
    metricBufferMax: env.STIMBA_METRIC_BUFFER_MAX,

    heartbeatIntervalSec: env.STIMBA_HEARTBEAT_SEC,
    auditFlushIntervalSec: env.STIMBA_AUDIT_FLUSH_SEC,
    metricsFlushIntervalSec: env.STIMBA_METRICS_FLUSH_SEC,
    rtdePollHz: env.STIMBA_RTDE_POLL_HZ,

    logLevel: env.LOG_LEVEL,
    enableDashboard: env.STIMBA_ENABLE_DASHBOARD,
    enableRtde: env.STIMBA_ENABLE_RTDE,
    enableMetricsPush: env.STIMBA_ENABLE_METRICS_PUSH,
    enableAuditPush: env.STIMBA_ENABLE_AUDIT_PUSH,
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid agent configuration:\n${detail}`);
  }
  return parsed.data;
}
