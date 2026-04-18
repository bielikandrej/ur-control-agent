# URsim PSX hello-world runbook

> Sprint 6 §6 pre-kickoff item (d). End-to-end smoke test of the
> `stimba-ur-control-agent` container against a local URsim Polyscope X
> instance — no real robot, no Cloudflare account, no portal needed.

This runbook proves three things before Sprint 6 kick-off:

1. The agent container starts cleanly with realistic env vars.
2. It can reach the Dashboard server inside URsim PSX (`urcontrol-primary`
   service alias, port `:29999`).
3. The local `:8787` API responds to a Bearer-authenticated `GET /v1/state`
   with the URsim's actual robot mode + safety status.

If all three pass, the agent is ready to be embedded as a URCapX container
artifact in Week 1 of Sprint 6.

---

## Prereqs (one-time)

- macOS or Linux dev machine, Docker Desktop ≥ 4.30 with at least **6 GB**
  RAM allocated (URsim PSX is hungry).
- Free-on-disk: ~3 GB (URsim image is ~1.9 GB, agent is ~150 MB).
- This repo cloned locally — `cd` into `ur-control-agent/` before running
  any of the commands below.
- Either:
  - **Option A (recommended):** the agent image already built locally
    (`npm run docker:build`), or
  - **Option B:** the image already pushed to
    `ghcr.io/bielikandrej/ur-control-agent:1.0.0-alpha.1` and the host has docker
    login to ghcr.io.

---

## Step 1 — Pull URsim PSX

```bash
docker pull universalrobots/ursim_polyscopex:latest
```

Verify it's the public image (no login should be needed). Confirmed in
research doc §Q1 — `universalrobots/ursim_polyscopex` is publicly pullable.

---

## Step 2 — Start URsim PSX

```bash
docker run --rm -d \
  --name ursim-psx \
  --platform linux/amd64 \
  -p 29998:29998 \
  -p 29999:29999 \
  -p 30001-30004:30001-30004 \
  --shm-size 512m \
  universalrobots/ursim_polyscopex:latest
```

Wait ~60 seconds for boot. Verify:

```bash
# Polyscope X web UI should respond
curl -s -I http://127.0.0.1:29998/polyscope-x/ | head -1
# Expected: HTTP/1.1 200 OK   (or 302 redirect to /login)

# Dashboard text protocol should accept connections
echo "robotmode" | nc 127.0.0.1 29999
# Expected: a line like "Robotmode: POWER_OFF"
```

If the Dashboard line is empty or the connection refuses, give URsim
another 30 seconds — boot includes a Java + Chromium kiosk warm-up.

---

## Step 3 — Generate dev secrets

The agent refuses to start with placeholder values. Use real-shaped tokens
even for local testing — the zod schema rejects anything else.

```bash
export STIMBA_DEVICE_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
export STIMBA_DEVICE_SERIAL=20225500001
export STIMBA_PORTAL_TOKEN=$(openssl rand -hex 32)         # 64 chars, JWT-like
export STIMBA_AGENT_LISTEN_TOKEN=$(openssl rand -hex 16)   # 32 chars min

# Optional but realistic — comment out to skip TLS pinning for the smoke
# test (portal isn't reachable here anyway):
# export STIMBA_PORTAL_TLS_PIN=$(openssl s_client -connect portal.stimba.sk:443 \
#   -servername portal.stimba.sk </dev/null 2>/dev/null | \
#   openssl x509 -fingerprint -sha256 -noout | tr -d ':' | cut -d= -f2 | \
#   tr '[:upper:]' '[:lower:]')

echo "device_id=$STIMBA_DEVICE_ID"
echo "listen_token=$STIMBA_AGENT_LISTEN_TOKEN"
```

Save the listen token — you need it for Step 5.

---

## Step 4 — Run the agent against URsim

```bash
# `--network host` so the agent can reach 127.0.0.1:29999 inside URsim's
# port mapping, AND so the local :8787 API is reachable from the host.
# On macOS host networking is limited; use the explicit host bridge instead:
#   --add-host=host.docker.internal:host-gateway
#   -e STIMBA_URCONTROL_HOST=host.docker.internal

docker run --rm --name stimba-agent \
  --network host \
  -e STIMBA_DEVICE_ID="$STIMBA_DEVICE_ID" \
  -e STIMBA_DEVICE_SERIAL="$STIMBA_DEVICE_SERIAL" \
  -e STIMBA_URCAP_VERSION=1.0.0-dev \
  -e STIMBA_POLYSCOPE_VARIANT=psx \
  -e STIMBA_PORTAL_TOKEN="$STIMBA_PORTAL_TOKEN" \
  -e STIMBA_AGENT_LISTEN_TOKEN="$STIMBA_AGENT_LISTEN_TOKEN" \
  -e STIMBA_AGENT_LISTEN_HOST=0.0.0.0 \
  -e STIMBA_URCONTROL_HOST=127.0.0.1 \
  -e STIMBA_ENABLE_METRICS_PUSH=false \
  -e STIMBA_ENABLE_AUDIT_PUSH=false \
  -e STIMBA_ENABLE_RTDE=false \
  -e LOG_LEVEL=debug \
  ghcr.io/bielikandrej/ur-control-agent:1.0.0-alpha.1
```

Expected log lines (within ~5 seconds):

```
{"level":30,"msg":"stimba-ur-control-agent starting","version":"1.0.0-alpha.1"}
{"level":30,"msg":"queue opened","component":"queue.metrics"}
{"level":30,"msg":"queue opened","component":"queue.audit"}
{"level":30,"msg":"dashboard connected","component":"dashboard","host":"127.0.0.1","port":29999}
{"level":30,"msg":"api server listening","component":"api","host":"0.0.0.0","port":8787}
{"level":30,"msg":"heartbeat tick","component":"heartbeat","robotMode":"POWER_OFF",...}
```

The two pushers (`pusher.metrics`, `pusher.audit`) will not appear because
we disabled them — pushing without a real portal would just log retries.

---

## Step 5 — Hit the local API from the host

In a second terminal:

```bash
TOKEN=$STIMBA_AGENT_LISTEN_TOKEN  # from Step 3

# Healthz (no auth)
curl -s http://127.0.0.1:8787/healthz | jq
# { "ok": true, "agentVersion": "1.0.0-alpha.1", "uptimeS": 12 }

# State (auth required)
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8787/v1/state | jq
# {
#   "robotMode": "POWER_OFF",
#   "safetyStatus": "NORMAL",
#   "loadedProgram": null,
#   "programRunning": false,
#   "polyscopeVersion": "PolyscopeX 10.x.x"
# }

# Reject without auth
curl -s -i http://127.0.0.1:8787/v1/state | head -1
# HTTP/1.1 401 Unauthorized

# SAFE_WRITE command — power on doesn't need a ticket because URsim has
# no real motors. NOTE: power_on is APPROVE-tier in production; this only
# works locally because we're not validating tickets against a portal.
# For the smoke test, exercise a SAFE_WRITE-tier command instead:
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "content-type: application/json" \
     -X POST -d '{"command":"power_off","reason":"smoke test"}' \
  http://127.0.0.1:8787/v1/command | jq
# { "ok": true, "response": "Powering off" }
```

If all four curls behave as shown, the agent is wired correctly end-to-end.

---

## Step 6 — Pass criteria

| Check | Pass condition |
|---|---|
| URsim PSX boots | `curl http://127.0.0.1:29998/polyscope-x/` returns 2xx/3xx |
| Dashboard reachable | `echo robotmode \| nc 127.0.0.1 29999` returns `Robotmode: …` |
| Agent connects to dashboard | Log line `dashboard connected` appears within 5s |
| API listening | `GET /healthz` returns `{ok: true}` |
| Auth enforced | unauthenticated `/v1/state` → 401 |
| State proxied correctly | `/v1/state.robotMode` matches `nc` output |
| Heartbeat ticks | `heartbeat tick` log every 30s |
| Queues persist | `docker exec stimba-agent ls /var/stimba/agent` shows `metrics.jsonl` + `audit.jsonl` + cursors |
| Graceful shutdown | `docker stop stimba-agent` → `agent.shutdown` audit + `shutdown complete` log within 10s |

If anything fails, capture the docker logs and grep for the failing
component:

```bash
docker logs stimba-agent 2>&1 | grep -E '"level":(40|50|60)'   # warn/error/fatal
```

---

## Step 7 — Tear down

```bash
docker stop stimba-agent
docker stop ursim-psx
```

Both containers were started with `--rm` so they self-clean.

---

## Known limitations of the URsim smoke test

- **No RTDE coverage** — the v0 agent's RTDE client is a stub
  (Sprint 6 Week 2 deliverable). `STIMBA_ENABLE_RTDE=true` will log a
  TODO marker and exit the rtde subsystem cleanly.
- **No portal pushes** — metrics + audit queues will buffer to disk but
  never flush. Real portal connectivity is a Sprint 6 Week 1 task once a
  staging device record exists in `portal.stimba.sk`.
- **No ticket validation** — APPROVE-tier commands will return
  `ticket_validation_failed` because there's no portal to call. To fully
  test the APPROVE path, point `STIMBA_PORTAL_URL` at a real staging
  portal and use a real device token + ticket.
- **Cloudflare Tunnel not exercised** — the cloudflared sibling container
  is declared in `examples/manifest.yaml` but its connectivity test lives
  in the sibling runbook [`CLOUDFLARED-RUNBOOK.md`](./CLOUDFLARED-RUNBOOK.md).
  The URsim smoke test deliberately covers only the agent half so it can
  be run without a Cloudflare account.

---

## Sign-off

Once Step 6 is all green, mark Sprint 6 §6 item (d) `URsim PSX hello world`
as ✅ in `portal-stimba-sk/wiki/sprints/sprint-6-research.md` and append a
progress.md entry with the URsim version + agent image digest used.
