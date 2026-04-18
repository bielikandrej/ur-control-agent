import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const baseEnv = {
  STIMBA_DEVICE_ID: "11111111-1111-4111-8111-111111111111",
  STIMBA_DEVICE_SERIAL: "20225500001",
  STIMBA_PORTAL_TOKEN: "abcdefghijklmnopqrstuvwxyzABCDEF01234567",
  STIMBA_AGENT_LISTEN_TOKEN: "0123456789abcdef0123456789abcdef",
};

test("loadConfig: happy path fills defaults", () => {
  const cfg = loadConfig(baseEnv);
  assert.equal(cfg.portalBaseUrl, "https://portal.stimba.sk");
  assert.equal(cfg.urcontrolHost, "urcontrol-primary");
  assert.equal(cfg.heartbeatIntervalSec, 30);
  assert.equal(cfg.polyscope, "psx");
});

test("loadConfig: rejects non-uuid device id", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, STIMBA_DEVICE_ID: "not-a-uuid" }),
    /deviceId/,
  );
});

test("loadConfig: rejects bad pin length", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, STIMBA_PORTAL_TLS_PIN: "DEADBEEF" }),
    /portalTlsPinSha256/,
  );
});

test("loadConfig: rate of rtdePollHz capped at 125", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, STIMBA_RTDE_POLL_HZ: "500" }),
    /rtdePollHz/,
  );
});

test("loadConfig: polyscope enum values", () => {
  const cfg5 = loadConfig({ ...baseEnv, STIMBA_POLYSCOPE_VARIANT: "ps5" });
  assert.equal(cfg5.polyscope, "ps5");
  assert.throws(
    () => loadConfig({ ...baseEnv, STIMBA_POLYSCOPE_VARIANT: "ps4" }),
    /polyscope/,
  );
});

// Regression: zod's z.coerce.boolean() coerces ANY non-empty string to true,
// so STIMBA_ENABLE_DASHBOARD=false would silently become true. envBoolean
// in config.ts must treat the conventional negatives correctly.
test("loadConfig: envBoolean handles 'false'/'0'/'no'/'off' as false", () => {
  for (const falsy of ["false", "0", "no", "off", "FALSE", "False"]) {
    const cfg = loadConfig({ ...baseEnv, STIMBA_ENABLE_DASHBOARD: falsy });
    assert.equal(cfg.enableDashboard, false, `expected ${falsy} → false`);
  }
  for (const truthy of ["true", "1", "yes", "on", "TRUE"]) {
    const cfg = loadConfig({ ...baseEnv, STIMBA_ENABLE_DASHBOARD: truthy });
    assert.equal(cfg.enableDashboard, true, `expected ${truthy} → true`);
  }
});

test("loadConfig: enableRtde defaults to false (RTDE decoder is stubbed)", () => {
  const cfg = loadConfig(baseEnv);
  assert.equal(cfg.enableRtde, false);
});

test("loadConfig: rejects unrecognised boolean string", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, STIMBA_ENABLE_AUDIT_PUSH: "maybe" }),
    /enableAuditPush/,
  );
});
