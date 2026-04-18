# Portal API Contract — `portal.stimba.sk` ⇄ `@stimba/ur-control-agent`

> **Status:** DRAFT for Sprint 6 (URCapX pre-kickoff). Normative for both sides.
> Agent client: [`src/portal-client.ts`](../src/portal-client.ts). Portal implementation: `portal-stimba-sk` repo.
> Changes here require a matching PR in **both** repos.

This document defines the five HTTP endpoints the Universal Robots control agent
calls on `portal.stimba.sk`. It is the contract the portal team implements in
Sprint 6 Week 1–2, and the contract the agent already targets in code.

---

## 1. Transport & auth

| Concern | Value |
|---|---|
| Base URL (prod) | `https://portal.stimba.sk` |
| Base URL (dev) | configurable via `STIMBA_PORTAL_URL` on the agent |
| Transport | HTTPS (TLS 1.2+). Agent pins leaf cert SHA-256 via `STIMBA_PORTAL_TLS_PIN` |
| Auth | `Authorization: Bearer <device-scoped opaque token>` — today `ptk_<hex>` stored hashed in `device_credentials`. JWT refactor planned Sprint 6 W3 pairing flow |
| Device id | `X-Stimba-Device-Id: <deviceId>` on every request |
| User agent | `stimba-ur-control-agent/<semver>` |
| Content type | `application/json; charset=utf-8` for all JSON endpoints |
| Time | Server clocks in UTC. All timestamps ISO 8601 with `Z` suffix |

### 1.1 Bearer token lifecycle

- Format is **opaque to the agent** — today `ptk_<lower-hex>`, issued once at
  URCap install/pair and stored in URCapX `secureStorage.stimbaPortalToken`,
  surfaced to the container as `STIMBA_PORTAL_TOKEN` env var via
  `valueFrom.secureStorage`.
- Portal verifies by `sha256(token)` lookup in the `device_credentials` table.
- **Today**: long-lived, revoked server-side by setting
  `device_credentials.revoked_at`. Agent treats `401` as fatal (rotate via
  re-pair).
- **Planned Sprint 6 W3**: migrate to short-lived JWT (≤ 24 h) with a separate
  refresh path. Wire format stays `Authorization: Bearer <token>`, so the
  agent won't need code changes beyond token renewal logic. Contract version
  will bump in §5 when this lands.

### 1.2 Idempotency

Endpoints that accept event batches (`/metrics/ingest`, `/agent/audit`) honour
an `Idempotency-Key` header. Replaying the same key within 24 h MUST return
the original `202 { accepted: N }` response without re-inserting rows.

Key derivation on the agent (see `src/pusher.ts`):

```
sha256(`${deviceId}:${stream}:${firstSeq}:${lastSeq}`).slice(0, 32)
```

### 1.3 Rate limits & backoff

- Agent will back off exponentially (1s → 60s cap) on `429`, `408`, and `5xx`.
- Portal SHOULD return `Retry-After` (seconds) on `429` when possible.
- Non-retryable `4xx` (400, 401, 403, 404, 413, 422) cause the agent to drop
  the offending batch after logging, not retry in a loop.

### 1.4 Error shape

Non-2xx responses SHOULD return:

```json
{ "error": { "code": "invalid_ticket", "message": "ticket expired" } }
```

The agent logs the body (first 256 bytes) but does not parse the error shape
today. Portal is free to evolve this as long as `Content-Type` stays
`application/json`.

---

## 2. Endpoint reference

### 2.1 `POST /api/agent/heartbeat`

Sent every `STIMBA_HEARTBEAT_INTERVAL_SEC` (default 30 s) while the agent is
running. Lightweight liveness + UR state snapshot.

**Request**

```json
{
  "ts": "2026-04-18T12:34:56.789Z",
  "agentVersion": "1.0.0-alpha.1",
  "uptimeS": 3612,
  "robotMode": "RUNNING",
  "safetyStatus": "NORMAL",
  "loadedProgram": "palletize.urp",
  "programRunning": true,
  "rtdeConnected": false,
  "dashboardConnected": true,
  "queueDepth": { "metrics": 0, "audit": 2 }
}
```

`robotMode`, `safetyStatus`, `loadedProgram`, `programRunning` MAY be `null`
when the Dashboard Server read fails (agent degrades gracefully — heartbeat
still fires).

**Response** — `204 No Content`

**Notes**
- Missing heartbeats for > 3× interval MUST mark the device `offline` in the
  portal UI.
- The portal SHOULD NOT infer anything about tickets or policy from a single
  heartbeat — those are separate endpoints.

---

### 2.2 `POST /api/agent/metrics/ingest`

> Namespaced under `/api/agent/*` to keep the URCapX agent contract fully
> separate from the legacy `/api/metrics/ingest` endpoint used by the PS5
> URCap v3 agent (different auth + payload shape, both remain live during
> parallel rollout).

High-cadence telemetry batch. Default batch size 500, flush every 10 s (agent
side config: `STIMBA_METRICS_FLUSH_INTERVAL_SEC`, `batchSize` in
`src/pusher.ts`).

**Request**

```json
{
  "events": [
    {
      "ts": "2026-04-18T12:34:56.789Z",
      "metricKey": "robot_mode",
      "kind": "text",
      "valueText": "RUNNING",
      "labels": { "source": "dashboard" }
    },
    {
      "ts": "2026-04-18T12:34:56.789Z",
      "metricKey": "actual_q.0",
      "kind": "num",
      "valueNum": 1.5707,
      "labels": { "joint": "base" }
    }
  ]
}
```

**Headers:** `Idempotency-Key: <32 hex chars>`

**Event shape** (see `MetricEvent` in `portal-client.ts`):

| Field | Type | Required | Notes |
|---|---|---|---|
| `ts` | ISO 8601 string | yes | server should NOT reject future timestamps within clock skew tolerance (±5 min) |
| `metricKey` | string | yes | snake-case identifier, ≤ 64 chars. See `portal-stimba-sk/wiki/05-metrics-catalog.md` |
| `kind` | `"num"` \| `"text"` \| `"bool"` | yes | determines which `value*` field is consulted |
| `valueNum` | number | if `kind="num"` | finite; ±∞/NaN MUST be rejected |
| `valueText` | string | if `kind="text"` | ≤ 256 chars |
| `valueBool` | boolean | if `kind="bool"` | |
| `labels` | map<string,string> | no | ≤ 8 keys, keys ≤ 32 chars, values ≤ 64 chars |

**Response** — `202 Accepted`

```json
{ "accepted": 2 }
```

`accepted` MAY be less than `events.length` if the portal partially accepts
(e.g., schema-rejected the last event). In that case `accepted` is the prefix
length — the agent ACKs up to `lastSeq` regardless, so the portal MUST log
and drop rejects, not reorder.

**Errors**
- `413 Payload Too Large` → agent halves batch size and retries
- `422 Unprocessable Entity` → agent drops the batch (schema violation)

---

### 2.3 `POST /api/agent/audit`

Audit event stream. Smaller batches (default 100), less frequent (30 s
default). Every command execution, tunnel transition, policy refresh, and
lifecycle event ends up here.

**Request**

```json
{
  "events": [
    {
      "ts": "2026-04-18T12:34:56.789Z",
      "kind": "command.dashboard",
      "actor": "portal:user_42",
      "detail": {
        "command": "play",
        "tier": "SAFE_WRITE",
        "result": "ok",
        "responseMs": 42
      },
      "ticketId": null
    },
    {
      "ts": "2026-04-18T12:35:01.000Z",
      "kind": "tunnel.up",
      "actor": "agent",
      "detail": { "hostname": "ur15-ikea-01.portal.stimba.sk" }
    }
  ]
}
```

**Headers:** `Idempotency-Key: <32 hex chars>`

**AuditEventKind enum** (closed set):

| Kind | Emitted by | When |
|---|---|---|
| `command.dashboard` | agent | every Dashboard Server command |
| `command.api` | agent | every local `/v1/command` HTTP call |
| `policy.refresh` | agent | after `GET /api/agent/policy` succeeds |
| `tunnel.up` / `tunnel.down` | agent (via cloudflared sidecar) | tunnel state change |
| `agent.boot` / `agent.shutdown` | agent | lifecycle |
| `rtde.connected` / `rtde.disconnected` | agent | RTDE socket transitions |
| `ticket.consumed` / `ticket.rejected` | agent | HITL ticket validation outcome |
| `killswitch.engaged` | agent | received `killSwitch=true` from policy |

**`actor` format**

| Value | Meaning |
|---|---|
| `"agent"` | the agent itself, no user attribution |
| `"portal:<userId>"` | command originated from a portal UI session |
| `"ui:<sessionId>"` | command originated from the local URCap panel |

**Response** — `202 Accepted`

```json
{ "accepted": 2 }
```

**Retention**: portal SHOULD retain audit events ≥ 2 years (CE MD / compliance
hook). Not the agent's concern.

---

### 2.4 `GET /api/agent/policy`

Policy snapshot. Fetched on boot and every `refreshIntervalSec` thereafter
(server-controlled, agent floors at 30 s).

**Request** — no body.

**Response** — `200 OK`

```json
{
  "policyVersion": 7,
  "allowedTiers": ["READ", "SAFE_WRITE", "APPROVE"],
  "hitlRequiredTiers": ["APPROVE", "DANGEROUS"],
  "killSwitch": false,
  "refreshIntervalSec": 120
}
```

**Semantics**
- `allowedTiers` — commands at any tier NOT in this list are refused locally
  with HTTP `403` and an `audit.command.*` event (`detail.result = "denied"`).
- `hitlRequiredTiers` — commands at these tiers require a valid ticket
  (see 2.5). `APPROVE` should always be here; `DANGEROUS` is Sprint 7+.
- `killSwitch: true` — agent refuses ALL non-READ commands until the next
  policy poll shows `false`. Emits `killswitch.engaged` audit event on the
  transition.
- `refreshIntervalSec` — the agent uses `max(30, refreshIntervalSec)`.
- `policyVersion` — monotonic. Portal increments on every policy change.
  Agent logs version changes; repeated same-version responses are cache-hits.

**Caching**: agent does NOT set `If-None-Match` today. Portal MAY add
`ETag`/`304` support later — agent ignores `304` and falls back to its cached
copy (documented future work).

---

### 2.5 `GET /api/agent/tickets/:ticketId`

HITL (human-in-the-loop) approval ticket validation. Called synchronously
right before executing an `APPROVE`-tier command.

**Request** — `ticketId` is URL-encoded; no body.

**Response** — `200 OK`

```json
{
  "ticketId": "tkt_01HQX...",
  "approved": true,
  "expiresAt": "2026-04-18T12:40:00.000Z",
  "scope": { "command": "play", "tier": "APPROVE" },
  "approvedBy": "user_42"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `ticketId` | string | yes | echoed for sanity |
| `approved` | boolean | yes | `false` → command is refused, audit emits `ticket.rejected` |
| `expiresAt` | ISO 8601 | yes | agent rejects if `expiresAt < now + 2s` (clock skew) |
| `scope.command` | string | yes | MUST match the command the agent is about to execute. Mismatch → reject + `ticket.rejected` with `detail.reason = "scope_mismatch"` |
| `scope.tier` | string | yes | ditto |
| `approvedBy` | string | no | surfaced in `audit.command.*` `detail.approvedBy` |

**Response codes**
- `200` → validate the body as above.
- `404` → ticket unknown or already consumed. Agent treats as rejection.
- `410 Gone` → ticket expired server-side. Agent treats as rejection.
- Network / `5xx` → command is refused (fail-closed). Agent does NOT retry
  the validation — the user must request a new ticket.

**One-shot semantics**: the agent considers a ticket consumed after a
successful validation + command execution. Portal MAY enforce single-use
server-side (recommended), but the agent does not re-call `GET /tickets/:id`
for the same ticket after consumption.

---

## 3. Not yet wired (Sprint 7+)

These appear in `portal-client.ts` as jsdoc but have no agent code path yet:

| Endpoint | Purpose | Planned sprint |
|---|---|---|
| `POST /api/agent/log-upload` | multipart bundle upload (Sprint 7 §2 "Download logs") | Sprint 7 W2 |
| `POST /api/agent/pair` | URCap install pairing (mints the bearer token) | Sprint 6 W3 — covered separately in `docs/PAIRING-FLOW.md` (TODO) |
| `WS /api/agent/live` | WebSocket live metrics (PSX UI panel, replace polling) | Sprint 7+ |

Portal implementers SHOULD NOT gold-plate these ahead of the agent wiring —
the shape will be finalised when we ship the agent side.

---

## 4. Test vectors

A portal implementation is considered contract-compatible if it passes the
smoke tests in `docs/CLOUDFLARED-RUNBOOK.md` §4 (device shows online in
portal UI within one heartbeat interval, metrics arrive, audit arrives,
`APPROVE` command with a valid ticket executes, same command with expired
ticket is rejected).

**Fixture payloads** for portal-side tests live at
`portal-stimba-sk/test/fixtures/agent-*.json` (to be added by portal
implementer; the payloads in §2 are normative starting points).

---

## 5. Change log

| Date | Change | Driver |
|---|---|---|
| 2026-04-18 | Initial draft extracted from `src/portal-client.ts` during Sprint 6 pre-kickoff scaffold | Sprint 6 §6 item (g) |

