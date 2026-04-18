# Changelog

All notable changes to `@stimba/ur-control-agent` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 (`1.0.0-alpha.*`, `1.0.0-beta.*`) do not promise contract stability.

---

## [Unreleased]

### Added
- Nothing yet.

### Changed
- Nothing yet.

### Fixed
- Nothing yet.

---

## [1.0.0-alpha.1] — 2026-04-18

Initial scaffold for Sprint 6 (URCapX) pre-kickoff. **Not** suitable for
production robots — RTDE decoder is a stub, no portal endpoints exist
yet on `portal.stimba.sk`, and ticket validation is unwired.

### Added
- Project scaffold: `package.json`, `tsconfig.json`, `Dockerfile` (3-stage,
  tini PID 1, non-root `stimba:10001`), `.dockerignore`, ESM Node 20.
- `src/config.ts` — Zod-validated env-var config with custom `envBoolean`
  preprocess (handles `false`/`0`/`no`/`off` correctly, unlike
  `z.coerce.boolean()`).
- `src/logger.ts` — pino structured logging with secret redaction.
- `src/dashboard-client.ts` — TCP `:29999` Dashboard Server client with
  reconnect backoff + tiered command surface (READ / SAFE_WRITE /
  APPROVE / DANGEROUS, ADR-008).
- `src/rtde-client.ts` — TCP `:30004` RTDE skeleton; protocol decoder
  stubbed for Sprint 6 Week 2.
- `src/portal-client.ts` — undici HTTPS client with TLS certificate
  pinning (`STIMBA_PORTAL_TLS_PIN`) via `checkServerIdentity` over
  `cert.raw`.
- `src/persistent-queue.ts` — JSONL append-only queue with separate
  cursor file; crash-safe replay on boot.
- `src/heartbeat.ts` — periodic beat with best-effort dashboard read.
- `src/pusher.ts` — batched queue flush with exponential backoff and
  idempotency-key derivation
  (`sha256(deviceId:stream:firstSeq:lastSeq).slice(0, 32)`).
- `src/metrics-collector.ts` — 1 Hz Dashboard poll for v0 telemetry
  (until RTDE decoder ships).
- `src/api-server.ts` — Fastify + helmet + rate-limit + Zod local API
  on `127.0.0.1:8787`. Bearer-token auth, 60 req/min global, 10 req/min
  on `/v1/command`. Endpoints: `/healthz`, `/v1/healthz`, `/v1/state`,
  `/v1/command`.
- `src/index.ts` — entrypoint with documented boot sequence + shutdown
  handlers + `unhandledRejection` / `uncaughtException` traps.
- `test/config.test.ts` — `node:test` suite covering env validation,
  envBoolean coercion edge cases (incl. case-insensitive `FALSE`/`TRUE`),
  default flags, and rejection of unrecognised boolean strings.
- `examples/manifest.yaml` — canonical URCapX manifest declaring both
  container artifacts (agent + cloudflared) wired together.
- `.github/workflows/ci.yml` — 3-job pipeline: build-test → multi-arch
  GHCR image (amd64+arm64) → release on `v*` tags.
- `docs/URSIM-RUNBOOK.md` — Sprint 6 §6 item (d) end-to-end smoke test
  against a local URsim PSX with no Cloudflare or portal dependency.
- `docs/CLOUDFLARED-RUNBOOK.md` — Sprint 6 §6 item (e) tunnel + DNS +
  Access policy smoke test for the second container artifact.
- `docs/LOCAL-API.md` — v1 HTTP API contract for URCap UI panel
  consumers (PSX React + PS5 Swing).
- `README.md` — overview, env-var table, dev workflow, container build
  commands, URCapX integration notes, security posture, PS7 parity hook.

### Fixed
- `src/api-server.ts` — drop explicit `Promise<FastifyInstance>` return type;
  the pino `Logger` generic leaked through Fastify's `FastifyInstance` and
  didn't unify with `FastifyBaseLogger`. Return type now inferred.
- `src/portal-client.ts` — replace `HeadersInit` (lib.dom type we don't
  load) with `ConstructorParameters<typeof Headers>[0]`.
- `src/persistent-queue.ts` — remove unused `rotateEvents` field; rotation
  is gated by file size only (`rotateBytes`). Field can be re-introduced
  when per-event rotation is wired.
- `src/rtde-client.ts` — `closed` is now read in `close()` as a
  double-close guard instead of being write-only.

### Known limitations
- RTDE protocol decoder is a stub (`TODO(sprint-6-w2)` markers in
  `rtde-client.ts`). `STIMBA_ENABLE_RTDE` defaults to `false` for this
  reason.
- Portal endpoints (`/api/v1/devices/:id/heartbeat`, `/metrics`,
  `/audit`, `/tickets/:id/validate`) do not exist yet on
  `portal.stimba.sk`. Pushes will retry forever and buffer to disk —
  see `STIMBA_ENABLE_METRICS_PUSH` / `STIMBA_ENABLE_AUDIT_PUSH` to
  silence in dev.
- `stimba` GitHub org does not exist yet (confirmed 2026-04-18). Published
  under the maintainer's user namespace `ghcr.io/bielikandrej`. CI env var
  `IMAGE_NAME` flips to `stimba/ur-control-agent` once the org is created
  and a one-time `docker pull && docker tag && docker push` moves tags.

[unreleased]: https://github.com/bielikandrej/ur-control-agent/compare/v1.0.0-alpha.1...HEAD
[1.0.0-alpha.1]: https://github.com/bielikandrej/ur-control-agent/releases/tag/v1.0.0-alpha.1
