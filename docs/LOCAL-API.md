# Local HTTP API contract (v1)

> The contract the URCap UI panel (PSX React, PS5 Swing) uses to talk to
> the local `stimba-ur-control-agent` container.

**Base URL (inside URCap):** `http://stimba-ur-control-agent:8787`
(service alias the PolyscopeX runtime sets up from the `ingress.name`
in `manifest.yaml`).

**Base URL (dev host network):** `http://127.0.0.1:8787`.

**Transport:** plain HTTP/1.1. The agent is listening on loopback inside
the URCap ingress scope; TLS is terminated by the URCap runtime when
the panel connects, not by the agent.

---

## Auth

Every non-health endpoint requires:

```http
Authorization: Bearer <STIMBA_AGENT_LISTEN_TOKEN>
```

- The token is ≥16 bytes, generated at URCap install and stored in URCap
  secure storage under key `stimbaAgentListenToken` (`manifest.yaml`
  line 34). Both the panel and the agent read the same value.
- The agent compares bytes with `crypto.timingSafeEqual` — constant-time,
  no early-exit on first mismatch.
- Missing/wrong token → `401 { "error": "unauthorized" }`.

---

## Rate limits

| Scope | Limit | Header on throttle |
|---|---|---|
| Global (every authenticated request) | 60 req / minute / token | `429` with `retry-after` (seconds) |
| `POST /v1/command` | 10 req / minute / token | same |

Limits mirror the portal-side ADR-008 §Q3 throttle so a panel bug can't
DoS the robot.

---

## Endpoints

### `GET /healthz` and `GET /v1/healthz`  &nbsp;(no auth)

Liveness probe. Returns `200` as soon as the Fastify listener is up.

```json
{
  "ok": true,
  "agentVersion": "1.0.0-alpha.1",
  "uptimeS": 412
}
```

Use from the URCap install lifecycle hook. Do **not** block a panel
render on this — hit `/v1/state` instead, which confirms the Dashboard
client is reachable too.

---

### `GET /v1/state`

Returns the current robot snapshot by fanning out five Dashboard
queries with `Promise.allSettled`, so a transient socket glitch
degrades a single field to `null` instead of failing the whole call.

```json
{
  "robotMode": "RUNNING",
  "safetyStatus": "NORMAL",
  "loadedProgram": "/programs/demo.urp",
  "programRunning": true,
  "polyscopeVersion": "PolyscopeX 10.9.0"
}
```

| Field | Source | Null when |
|---|---|---|
| `robotMode` | Dashboard `robotmode` → `NO_CONTROLLER` \| `DISCONNECTED` \| `CONFIRM_SAFETY` \| `BOOTING` \| `POWER_OFF` \| `POWER_ON` \| `IDLE` \| `RUNNING` | Dashboard TCP write/read errored |
| `safetyStatus` | Dashboard `safetystatus` | ditto |
| `loadedProgram` | Dashboard `get loaded program` | no program loaded — the agent maps both errors and "no program loaded" to `null` |
| `programRunning` | Dashboard `running` | Dashboard unreachable |
| `polyscopeVersion` | Dashboard `PolyscopeVersion` | Dashboard unreachable |

`GET /v1/state` always returns `200` — consumers check the specific
fields for `null` and decorate the UI (greyed-out status, spinner, etc.)
rather than retry.

---

### `POST /v1/command`

Execute a Dashboard command. Body (JSON):

```json
{
  "command": "power_on",
  "programPath": "/programs/demo.urp",
  "ticketId": "tk_01HN7...",
  "reason": "Operator requested from installation panel"
}
```

| Field | Required | Notes |
|---|---|---|
| `command` | yes | one of the enum below |
| `programPath` | only for `load_program` | must match `/^[A-Za-z0-9._\-/ ]+\.(urp\|script)$/i` — anti-traversal |
| `ticketId` | required for APPROVE-tier | ignored for SAFE_WRITE — harmless if sent |
| `reason` | optional | free text, appears in audit event |

#### Command enum and tier

| `command` | Tier | Needs ticket | What it calls |
|---|---|---|---|
| `power_off` | SAFE_WRITE | no | Dashboard `power off` |
| `stop` | SAFE_WRITE | no | Dashboard `stop` |
| `pause` | SAFE_WRITE | no | Dashboard `pause` |
| `power_on` | APPROVE | **yes** | Dashboard `power on` |
| `brake_release` | APPROVE | **yes** | Dashboard `brake release` |
| `play` | APPROVE | **yes** | Dashboard `play` |
| `load_program` | APPROVE | **yes** | Dashboard `load <programPath>` |

APPROVE flow, step-by-step:

1. Panel POSTs with `ticketId`.
2. Agent calls `portal.validateTicket(ticketId)` — if the portal is
   unreachable, the command is rejected with `502 ticket_validation_failed`.
   The agent does **not** ride a cached approval.
3. Agent compares the ticket scope to the requested command. A mismatch
   is `403 ticket_scope_mismatch`.
4. Agent issues the Dashboard command.
5. Regardless of success, agent enqueues a `command.api` audit event.

#### Success

```json
{
  "ok": true,
  "response": "Powering on"
}
```

`response` is the raw Dashboard reply line. The panel should treat it
as informational — the authoritative success signal is the subsequent
`/v1/state` showing the expected `robotMode`.

#### Error codes

| HTTP | `error` | When |
|---|---|---|
| 400 | `invalid_body` | Zod rejects the request body; `detail` has issues |
| 400 | `programPath_required` | `load_program` without `programPath` |
| 400 | `invalid_program_path` | `programPath` fails the regex |
| 400 | `ticket_required` | APPROVE-tier without `ticketId` |
| 401 | `unauthorized` | missing/wrong bearer |
| 403 | `ticket_not_approved` | portal returned `approved=false` |
| 403 | `ticket_scope_mismatch` | ticket was issued for a different command |
| 429 | (standard Fastify rate-limit payload) | over 10/min on `/v1/command` or 60/min global |
| 502 | `ticket_validation_failed` | portal unreachable / 5xx from portal |
| 502 | `dashboard_failed` | Dashboard write/read failed after auth |

All errors are JSON with a stable `error` code — panels should switch
on the code string and map to a localized message, never surface the
`detail` to end users verbatim.

---

## What the API deliberately does NOT do (v0)

- **No RTDE feed.** High-frequency telemetry lands in the agent's local
  metrics queue and flushes to the portal; the panel reads aggregate
  state via `/v1/state` instead. An RTDE-backed `/v1/telemetry`
  endpoint is a Sprint 6 Week 2 follow-up.
- **No program upload.** `load_program` only references a path that
  already exists on the controller. File transfer is a future
  `/v1/programs/:name` endpoint gated by a separate APPROVE tier.
- **No streaming.** No Server-Sent Events or websocket. Panels poll
  `/v1/state` at 1 Hz while visible; the heartbeat covers the
  panel-is-closed case.
- **No ticket pre-check.** There's no `POST /v1/command/dry-run`.
  Panels can surface the "needs approval" hint by inspecting the
  command enum locally.

---

## Example panel integration (TypeScript)

```ts
import { z } from "zod";

const StateSchema = z.object({
  robotMode: z.string().nullable(),
  safetyStatus: z.string().nullable(),
  loadedProgram: z.string().nullable(),
  programRunning: z.boolean().nullable(),
  polyscopeVersion: z.string().nullable(),
});

export class AgentClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
  }

  async state(): Promise<z.infer<typeof StateSchema>> {
    const r = await fetch(`${this.baseUrl}/v1/state`, { headers: this.headers() });
    if (!r.ok) throw new Error(`state ${r.status}`);
    return StateSchema.parse(await r.json());
  }

  async command(body: {
    command:
      | "power_off" | "stop" | "pause"
      | "power_on" | "brake_release" | "play" | "load_program";
    programPath?: string;
    ticketId?: string;
    reason?: string;
  }): Promise<{ ok: true; response: string }> {
    const r = await fetch(`${this.baseUrl}/v1/command`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw Object.assign(new Error(json.error ?? r.statusText), { status: r.status, body: json });
    return json;
  }
}
```

---

## Stability promise

The `/v1/*` paths are stable for the 1.x line. Breaking changes bump
to `/v2/*` and run in parallel for at least one release. Field
additions to response bodies are non-breaking; panels should ignore
unknown fields.

Contract changes are proposed via ADRs in
`portal-stimba-sk/wiki/decisions/` and cross-referenced from the agent
CHANGELOG before shipping.
