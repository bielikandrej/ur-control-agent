# stimba-ur-control-agent

> Device-side sidecar for STIMBA-managed Universal Robots cobots. Runs as a
> Docker **container artifact** inside a PolyscopeX URCapX package, or as a
> `systemd` unit alongside the PS5 `.urcap` (Sprint 7 parity).

---

## What it does

1. **Connects to the local UR controller** — Dashboard Server on `:29999`
   (and RTDE on `:30004`, Sprint 6 Week 2) via the URCapX
   `services: [urcontrol-primary]` grant.
2. **Pushes heartbeat + metrics + audit events** to `portal.stimba.sk` over a
   mutually-authenticated HTTPS channel with TLS certificate pinning.
3. **Buffers events to disk** (JSONL append-only queue with separate cursor
   file) so nothing is lost while the portal or the WAN link is unreachable.
4. **Exposes a local HTTP API** on `127.0.0.1:8787` (or the URCap ingress
   socket) for the URCap UI panel to read state and issue commands — APPROVE-
   tier commands require a portal-issued ticket.
5. **Runs as non-root** (`UID 10001`), with a read-only root filesystem and
   `CAP_DROP: [ALL]`. State lives on a dedicated volume mount.

It deliberately does **not** speak VNC — on PolyscopeX the remote-UI path is
a Cloudflare Tunnel to `:29998`, which is a sibling container artifact
(`cloudflare/cloudflared:<tag>`) managed by the URCapX runtime. The agent
only handles control-plane traffic.

---

## Repo layout

```
ur-control-agent/
├── package.json            # @stimba/ur-control-agent, ESM, Node 20
├── tsconfig.json
├── Dockerfile              # 3-stage build, tini PID 1, non-root stimba:10001
├── .dockerignore
├── README.md               # this file
├── CHANGELOG.md            # Keep-a-Changelog, SemVer
├── .github/
│   └── workflows/ci.yml    # build-test → multi-arch GHCR image → release
├── src/
│   ├── index.ts            # entrypoint (boot sequence + signal handlers)
│   ├── config.ts           # Zod schema over STIMBA_* env vars
│   ├── logger.ts           # pino + redact paths for secrets
│   ├── dashboard-client.ts # TCP :29999 with reconnect backoff + tiered commands
│   ├── rtde-client.ts      # TCP :30004 skeleton — protocol decoder TODO(w2)
│   ├── portal-client.ts    # undici-based HTTPS with TLS cert pinning
│   ├── persistent-queue.ts # JSONL append + cursor file, crash-safe replay
│   ├── heartbeat.ts        # periodic beat w/ best-effort dashboard read
│   ├── pusher.ts           # batched queue flush w/ exponential backoff
│   ├── metrics-collector.ts# 1Hz dashboard poll (v0 before RTDE)
│   └── api-server.ts       # Fastify + helmet + rate-limit + Zod bodies
├── test/
│   └── config.test.ts      # node:test — env validation cases
├── docs/
│   ├── URSIM-RUNBOOK.md    # agent-only smoke test against URsim PSX
│   ├── CLOUDFLARED-RUNBOOK.md  # tunnel + DNS + Access smoke test
│   └── LOCAL-API.md        # v1 HTTP API contract for the URCap UI panel
└── examples/
    └── manifest.yaml       # canonical URCapX manifest showing both container
                            # artifacts (agent + cloudflared) wired together
```

---

## Environment variables

All configuration is consumed from env; there is no on-disk config file. The
URCapX runtime populates these via `valueFrom: { device: ... }`,
`valueFrom: { urcap: ... }`, and `valueFrom: { secureStorage: ... }` bindings
(see `examples/manifest.yaml`).

| Key | Required | Default | Notes |
|---|---|---|---|
| `STIMBA_DEVICE_ID` | yes | — | URCap-assigned UUID v4 |
| `STIMBA_DEVICE_SERIAL` | yes | — | UR hardware serial |
| `STIMBA_POLYSCOPE_VARIANT` | yes | `psx` | `psx` or `ps5` |
| `STIMBA_URCAP_VERSION` | yes | — | injected from URCap manifest |
| `STIMBA_PORTAL_URL` | no | `https://portal.stimba.sk` | |
| `STIMBA_PORTAL_TOKEN` | yes | — | device-scoped JWT from pairing |
| `STIMBA_PORTAL_TLS_PIN` | no | — | SHA-256 of portal leaf cert (64 hex) |
| `STIMBA_URCONTROL_HOST` | no | `urcontrol-primary` | URCap service alias |
| `STIMBA_URCONTROL_DASHBOARD_PORT` | no | `29999` | |
| `STIMBA_URCONTROL_RTDE_PORT` | no | `30004` | |
| `STIMBA_AGENT_LISTEN_HOST` | no | `127.0.0.1` | set to `0.0.0.0` inside container for ingress |
| `STIMBA_AGENT_LISTEN_PORT` | no | `8787` | |
| `STIMBA_AGENT_LISTEN_TOKEN` | yes | — | shared secret w/ URCap UI (auto-generated at install) |
| `STIMBA_AGENT_STATE_DIR` | no | `/var/stimba/agent` | must be writable |
| `STIMBA_HEARTBEAT_SEC` | no | `30` | |
| `STIMBA_METRICS_FLUSH_SEC` | no | `10` | |
| `STIMBA_AUDIT_FLUSH_SEC` | no | `60` | |
| `STIMBA_METRIC_BUFFER_MAX` | no | `5000` | |
| `STIMBA_AUDIT_QUEUE_MAX` | no | `10000` | |
| `STIMBA_RTDE_POLL_HZ` | no | `10` | capped at 125 |
| `STIMBA_ENABLE_DASHBOARD` | no | `true` | accepts `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off` |
| `STIMBA_ENABLE_RTDE` | no | `false` | flip to `true` once decoder lands (Sprint 6 w2) |
| `STIMBA_ENABLE_METRICS_PUSH` | no | `true` | |
| `STIMBA_ENABLE_AUDIT_PUSH` | no | `true` | |
| `LOG_LEVEL` | no | `info` | `trace`/`debug`/`info`/`warn`/`error`/`fatal` |

Secrets (`STIMBA_PORTAL_TOKEN`, `STIMBA_AGENT_LISTEN_TOKEN`) are redacted from
logs by pino's `redact` config and from startup banners by `redactConfig()`.

---

## Local development

```bash
# 1. Install deps (generates package-lock.json the first time — commit it)
npm install

# 2. Export a dev-only set of env vars — easiest via a .env.dev file
export STIMBA_DEVICE_ID=11111111-1111-4111-8111-111111111111
export STIMBA_DEVICE_SERIAL=20225500001
export STIMBA_PORTAL_URL=https://portal.stimba.sk
export STIMBA_PORTAL_TOKEN=replace-with-dev-jwt
export STIMBA_AGENT_LISTEN_TOKEN=$(openssl rand -hex 16)
export STIMBA_URCONTROL_HOST=127.0.0.1   # running against URsim on loopback
export STIMBA_ENABLE_DASHBOARD=true
export STIMBA_ENABLE_METRICS_PUSH=false  # avoid pushing dev noise upstream
export LOG_LEVEL=debug

# 3. Point at a URsim instance (easy: docker)
docker run --rm -p 29999:29999 -p 30004:30004 \
  universalrobots/ursim_e-series:latest

# 4. Run the agent in watch mode
npm run dev

# Smoke-test the local API
curl -s -H "Authorization: Bearer $STIMBA_AGENT_LISTEN_TOKEN" \
  http://127.0.0.1:8787/v1/state | jq
```

`npm test` runs the `node --test` suite (config schema validation today; more
coverage added alongside each client module).

---

## Building the container image

```bash
# Build (tags ghcr.io/bielikandrej/ur-control-agent:<package.version>)
npm run docker:build

# Smoke-run locally — point at a URsim on host network
docker run --rm --network host \
  -e STIMBA_DEVICE_ID=$STIMBA_DEVICE_ID \
  -e STIMBA_DEVICE_SERIAL=$STIMBA_DEVICE_SERIAL \
  -e STIMBA_PORTAL_TOKEN=$STIMBA_PORTAL_TOKEN \
  -e STIMBA_AGENT_LISTEN_TOKEN=$STIMBA_AGENT_LISTEN_TOKEN \
  -e STIMBA_URCONTROL_HOST=127.0.0.1 \
  -e LOG_LEVEL=debug \
  ghcr.io/bielikandrej/ur-control-agent:1.0.0-alpha.1
```

### Publishing to `ghcr.io/bielikandrej`

`stimba` GitHub org does not exist yet (2026-04-18). Published under the
maintainer's user namespace `bielikandrej` for now — when the org is
registered, the CI `IMAGE_NAME` env var flips to `stimba/ur-control-agent`
and a one-time `docker pull && docker tag && docker push` moves tags over.

Create a PAT with `write:packages` scope and publish:

```bash
echo "$CR_PAT" | docker login ghcr.io -u bielikandrej --password-stdin
docker tag  ghcr.io/bielikandrej/ur-control-agent:1.0.0-alpha.1 \
            ghcr.io/bielikandrej/ur-control-agent:latest
docker push ghcr.io/bielikandrej/ur-control-agent:1.0.0-alpha.1
docker push ghcr.io/bielikandrej/ur-control-agent:latest
```

Make the package **public** in the GitHub UI so URCapX installs on customer
robots can pull without credentials. CI wiring (`.github/workflows/release.yml`)
lands in Sprint 6 Week 1.

---

## How it fits into a URCapX package

`examples/manifest.yaml` is the canonical reference. Key points:

1. **Two containers**, one shared URCap:
   - `stimba-ur-control-agent` (this repo) — `services: [urcontrol-primary]`
     to reach Dashboard/RTDE. Ingress `8787/tcp scope localhost` so the
     installationNode web UI can call `/v1/state` and `/v1/command` via the
     URCap backend proxy.
   - `cloudflared` — outbound-only, exposes the PolyscopeX web UI on a
     per-device subdomain (`ui.device-<uuid>.portal.stimba.sk`). No UR
     services needed — tunnel egress is pure TCP.
2. **Secrets flow through `secureStorage`**. The pairing flow on
   `portal.stimba.sk` POSTs the Cloudflare tunnel token + portal device
   token into URCap secure storage via the install API. The
   `stimbaAgentListenToken` is marked `generated: true` so the runtime
   auto-mints it on first install and keeps it stable across upgrades.
3. **Device + URCap metadata** arrives via `valueFrom` bindings, never
   hard-coded — the same image can run on any number of robots without a
   rebuild.
4. **State volume** (`agent-state`, 64 Mi, `reclaimPolicy: retain`) persists
   the JSONL queue and cursor across URCap upgrades and robot restarts —
   critical so buffered events survive an 8-hour overnight WAN outage.

---

## PS5 parity (Sprint 7)

The same control-plane contract — portal endpoints, JSONL queue shape,
heartbeat schema — is reused by the PS5 URCap v3.1.0. Instead of a container
artifact, the agent is packaged as a Java-wrapped native binary (via GraalVM
native-image) launched from the URCap OSGi bundle and supervised by systemd.
The TypeScript source is the source of truth; the PS5 build is a compilation
target. See `portal-stimba-sk/wiki/sprints/sprint-7-urcap-update.md`.

---

## Security posture

- Non-root (`UID 10001`), read-only rootfs, `CAP_DROP: [ALL]`, no extra Linux
  capabilities.
- Zero outbound ports except to `portal.stimba.sk` (HTTPS). RTDE + Dashboard
  are intra-controller (`urcontrol-primary` service alias).
- TLS certificate pinning (`STIMBA_PORTAL_TLS_PIN`) defends against
  upstream-MITM if the customer network inserts its own root CA.
- Bearer-token auth on the local `:8787` API with `crypto.timingSafeEqual`
  comparison. Global 60 req/min rate limit, 10 req/min on `/v1/command/*`.
- APPROVE-tier commands (`power_on`, `brake_release`, `play`, `load_program`)
  require a portal-issued ticket that is validated **before** the Dashboard
  write happens. Tickets are single-use; consumed state is persisted in the
  audit queue.
- Unhandled exceptions log at `fatal` and exit(1) so the URCapX runtime
  restarts the container cleanly (`restart: always`).

---

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/URSIM-RUNBOOK.md`](./docs/URSIM-RUNBOOK.md) | Sprint 6 §6 item (d) — end-to-end smoke test of the agent against a local URsim PSX. No Cloudflare account, no portal, no real robot needed. |
| [`docs/CLOUDFLARED-RUNBOOK.md`](./docs/CLOUDFLARED-RUNBOOK.md) | Sprint 6 §6 item (e) — per-device tunnel create, `TUNNEL_TOKEN` issuance, DNS routing to `ui.device-<id>.portal.stimba.sk`, Cloudflare Access policy, tear-down. |
| [`docs/LOCAL-API.md`](./docs/LOCAL-API.md) | v1 HTTP API contract the URCap UI panel team consumes. Auth, rate limits, `/v1/state`, `/v1/command` enum + APPROVE-tier ticket flow, error codes. |
| [`CHANGELOG.md`](./CHANGELOG.md) | Release notes. Keep-a-Changelog format, SemVer. |
| [`examples/manifest.yaml`](./examples/manifest.yaml) | Canonical URCapX manifest wiring both container artifacts (agent + cloudflared) together. |

Wider project docs — build & publish pipeline, sprint plans, ADRs — live
under `portal-stimba-sk/wiki/sprints/` and `portal-stimba-sk/wiki/decisions/`.

---

## License

Proprietary — © STIMBA, s. r. o.
