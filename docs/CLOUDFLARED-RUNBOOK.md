# Cloudflare Tunnel hello-world runbook

> Sprint 6 §6 pre-kickoff item (e). End-to-end smoke test of the second
> URCapX container artifact — `cloudflare/cloudflared` — against a local
> URsim Polyscope X instance and a real Cloudflare account with the
> `portal.stimba.sk` zone delegated.

This runbook proves four things before Sprint 6 kick-off:

1. A per-device named tunnel can be created from the CLI.
2. `cloudflared` running as a Docker container with `TUNNEL_TOKEN` only
   (no on-disk config) connects outbound and registers all four edge
   datacenters.
3. Public-hostname routing (`ui.device-<id>.portal.stimba.sk` →
   `http://localhost:29998`) reaches URsim's Polyscope X web UI from the
   public internet.
4. Cloudflare Access (Zero Trust) gates the subdomain behind an email or
   service-token policy — a request without a valid token gets a 302 to
   the Access login page, not the bare URsim UI.

If all four pass, the cloudflared sibling container is ready to be
declared in `examples/manifest.yaml` and shipped in Week 1 of Sprint 6.

---

## Prereqs (one-time)

| Item | Why | How to verify |
|---|---|---|
| Cloudflare account, free plan OK | tunnels are unmetered on free | log in at `dash.cloudflare.com` |
| `portal.stimba.sk` zone | per-device subdomain routing | the zone shows a green "Active" badge in the dashboard |
| `cloudflared` CLI ≥ 2026.4.0 on the Mac | local tunnel + DNS commands | `cloudflared --version` |
| API token with **Tunnel:Edit + Zone:DNS:Edit** scope | scripted DNS routing | save in `~/.cloudflare-tunnel-token` (chmod 600) |
| Account ID | required for tunnel CRUD | dashboard right sidebar → "Account ID" |
| URsim PSX already running per `URSIM-RUNBOOK.md` Step 2 | subject under test | `curl -I http://127.0.0.1:29998/polyscope-x/` returns 2xx/3xx |

> **Sprint 6 §6 item (e) status:** the Cloudflare account creation itself
> is the user-side action — once the account + zone + API token exist,
> this runbook can be re-run any time we need to re-validate the
> deployment topology (e.g. before each new agent release).

---

## Step 1 — Authenticate the local CLI (one-time per Mac)

```bash
cloudflared tunnel login
# Browser opens → pick the portal.stimba.sk zone → click Authorize
# Writes ~/.cloudflared/cert.pem
```

The `cert.pem` is **only** used by the local CLI to create tunnels and
DNS records. The Docker container does not get this file — it uses the
short-lived `TUNNEL_TOKEN` issued in Step 3 instead.

---

## Step 2 — Create a per-device named tunnel

Replace `<dev-uuid>` with a stable test value (we use the same UUID the
URsim smoke test generated in `URSIM-RUNBOOK.md` Step 3). The tunnel
name MUST match the device-id pattern so portal-side reconciliation can
trace `tunnel-id ↔ device-id` later.

```bash
DEV_UUID=11111111-1111-4111-8111-111111111111   # smoke test only
TUNNEL_NAME="device-${DEV_UUID}"

cloudflared tunnel create "$TUNNEL_NAME"
# Output: Created tunnel device-…  with id <tunnel-uuid>
# Writes ~/.cloudflared/<tunnel-uuid>.json (the tunnel credentials file)
```

Capture the tunnel UUID — we need it in Steps 3 and 4.

```bash
TUNNEL_ID=$(cloudflared tunnel list | awk -v n="$TUNNEL_NAME" '$2 == n {print $1}')
echo "tunnel_id=$TUNNEL_ID"
```

---

## Step 3 — Issue the TUNNEL_TOKEN for container use

```bash
TUNNEL_TOKEN=$(cloudflared tunnel token "$TUNNEL_ID")
echo "token length=${#TUNNEL_TOKEN}"   # ~210 chars, base64-ish
```

> ⚠️ **Treat this like a password.** It grants outbound connect
> capability to the tunnel until it's rotated. In production the portal
> issues this token to the URCap install API via `secureStorage` —
> never store it in git, env files, or screenshots.

---

## Step 4 — Route the public hostname to the local URsim

The container artifact in `examples/manifest.yaml` runs cloudflared in
**remotely-managed** mode (`TUNNEL_TOKEN` only, no `config.yml`). That
means the routing rules live in the Cloudflare dashboard, not on disk.

Two ways to add the public hostname:

### Option A — dashboard (interactive, one-shot smoke)

1. `dash.cloudflare.com → Zero Trust → Networks → Tunnels`
2. Pick `device-<dev-uuid>` → **Configure** → **Public Hostname** tab
3. **Add a public hostname** with these values:
   - **Subdomain:** `ui.device-<dev-uuid>` (literal — keep dashes in
     UUID)
   - **Domain:** `portal.stimba.sk`
   - **Service:** `HTTP`
   - **URL:** `localhost:29998`
   - **Origin Server Name** (under *TLS* → expand): leave blank for HTTP
4. Save. The DNS record (`CNAME … → <tunnel-uuid>.cfargotunnel.com`,
   proxied) appears in the zone within seconds.

### Option B — scripted (idempotent, what the portal does)

```bash
ACCOUNT_ID="<your-cf-account-id>"
CF_TOKEN="$(cat ~/.cloudflare-tunnel-token)"
ZONE_ID=$(curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=portal.stimba.sk" \
  | jq -r '.result[0].id')

# 1. Add the ingress rule to the tunnel config
curl -s -X PUT \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "content-type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  -d @- <<JSON | jq '.success'
{
  "config": {
    "ingress": [
      {
        "hostname": "ui.device-${DEV_UUID}.portal.stimba.sk",
        "service": "http://localhost:29998"
      },
      { "service": "http_status:404" }
    ]
  }
}
JSON

# 2. Create the proxied DNS CNAME
curl -s -X POST \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "content-type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -d "{
    \"type\": \"CNAME\",
    \"name\": \"ui.device-${DEV_UUID}\",
    \"content\": \"${TUNNEL_ID}.cfargotunnel.com\",
    \"ttl\": 1,
    \"proxied\": true
  }" | jq '.success'
```

Both `success` calls must return `true`. If the second fails with code
81053 (record already exists), the script is being re-run — patch the
existing record with `PUT /dns_records/{id}` instead.

---

## Step 5 — Run cloudflared as a container

```bash
docker run --rm -d \
  --name cloudflared-test \
  --network host \
  -e TUNNEL_TOKEN="$TUNNEL_TOKEN" \
  -e NO_AUTOUPDATE=true \
  cloudflare/cloudflared:2026.4.0 \
  tunnel --no-autoupdate run
```

> macOS: `--network host` is limited and the tunnel egress will still
> work, but the loopback `localhost:29998` ingress side won't reach
> URsim. On macOS, replace the ingress URL in Step 4 with
> `http://host.docker.internal:29998` AND start the container with
> `--add-host=host.docker.internal:host-gateway` instead of
> `--network host`.

Expected log lines (within ~5 seconds):

```
INF Starting tunnel tunnelID=<tunnel-uuid>
INF Version 2026.4.0
INF Generated Connector ID: <conn-uuid>
INF Initial protocol quic
INF Connection <c1> registered connIndex=0 ip=… location=fra07
INF Connection <c2> registered connIndex=1 ip=… location=fra08
INF Connection <c3> registered connIndex=2 ip=… location=ams01
INF Connection <c4> registered connIndex=3 ip=… location=ams02
```

Four registered connections across two datacenters = healthy. Anything
fewer than four indicates a UDP/QUIC firewall block on the host network
— see "Troubleshooting" below.

---

## Step 6 — Hit the public hostname from outside

From a phone on cellular, or any machine **not** on the dev LAN:

```bash
curl -s -I "https://ui.device-${DEV_UUID}.portal.stimba.sk/polyscope-x/" | head -3
# HTTP/2 200
# server: cloudflare
# cf-ray: <…>-<…>
```

The `cf-ray` header confirms the request went through Cloudflare's edge.
Open the same URL in a browser — the Polyscope X kiosk UI should render
exactly as if you'd hit `http://127.0.0.1:29998` directly on the dev
machine.

> **Latency note:** an unloaded smoke test should land in ~120-180 ms
> from EU clients (frankfurt edge → frankfurt origin via Argo). Real
> robots in customer factories will see 200-400 ms depending on
> upstream WAN — acceptable for a kiosk UI, marginal for VNC, which is
> exactly why we picked an HTTP-tunneled web UI over VNC pixel-pushing.

---

## Step 7 — Add Cloudflare Access policy (gate the subdomain)

Without Access, anyone who guesses `ui.device-<uuid>` gets the kiosk
UI. The portal will always wrap each device subdomain in an Access
application before issuing the URL to the customer. For the smoke test
we add a minimal email-based policy.

Dashboard path:

1. `Zero Trust → Access → Applications → Add an application →
   Self-hosted`
2. **Application name:** `device-<uuid>-test`
3. **Session duration:** 24 h
4. **Application domain:** `ui.device-<uuid>.portal.stimba.sk`
5. **Identity providers:** at minimum `One-time PIN`
6. Add a policy:
   - **Action:** Allow
   - **Include:** Emails ending in `@stimba.sk`
7. Save.

Re-test from Step 6 — the request now redirects to a Cloudflare Access
login page asking for an email + OTP. After successful auth, the kiosk
UI loads and the `CF_Authorization` cookie is set for 24 hours.

For the production portal proxy path (where the portal is the
client, not a human), replace the OTP IDP with a Service Token policy
and add the token to the portal's egress headers.

---

## Step 8 — Pass criteria

| Check | Pass condition |
|---|---|
| Tunnel created | `cloudflared tunnel list` shows `device-<uuid>` |
| TUNNEL_TOKEN issued | non-empty, ≥200 chars |
| DNS record proxied | `dig ui.device-<uuid>.portal.stimba.sk +short` → a Cloudflare anycast IP, not the origin |
| Container connects | 4 `Connection registered` lines in container logs within 5s |
| Public URL reachable | `curl -I https://ui.…` returns 200 with `cf-ray` header |
| Origin reached | the body matches what `curl http://127.0.0.1:29998/polyscope-x/` returns |
| Access enforced | request without `CF_Authorization` cookie → 302 to `…/cdn-cgi/access/login/…` |
| Graceful shutdown | `docker stop cloudflared-test` → "shutting down" log + clean exit within 5s |
| Reconnect after WAN flap | `sudo pfctl -e ; sleep 30 ; sudo pfctl -d` (mac) or `sudo nft … drop` (linux) shows the container reconnecting all 4 edges within 60s of restoration |

If anything fails, grep the container logs first:

```bash
docker logs cloudflared-test 2>&1 | grep -iE 'err|fail|warn'
```

---

## Troubleshooting

**Symptom:** only 1-2 `Connection registered` lines instead of 4.
- Likely cause: outbound UDP/443 (QUIC) blocked. Cloudflared falls back
  to HTTP/2, which is slower and brittle.
- Fix locally: `-e TUNNEL_TRANSPORT_PROTOCOL=http2` to force the
  fallback explicitly, then file an issue with the dev network owner.
  In customer factories, the same env var is the documented mitigation
  for restricted egress (Sprint 6 manifest can flip it via secure
  storage if needed).

**Symptom:** `502 Bad Gateway` from the public URL but logs show all 4
connections healthy.
- Likely cause: ingress URL points at a port nothing is listening on,
  or URsim died after Step 4. Re-run Step 2 of `URSIM-RUNBOOK.md`.
- Verify from inside the container:
  `docker exec cloudflared-test wget -qO- --tries=1 --timeout=3 http://localhost:29998/polyscope-x/ | head -1`

**Symptom:** Access login page redirects to a generic Cloudflare 403.
- Likely cause: the Access application's domain doesn't match the
  request hostname exactly (typo in subdomain casing, missing trailing
  segment, etc.). Re-check Step 7.

**Symptom:** `cloudflared tunnel token` returns
`error: tunnel token endpoint requires authenticated origin certificate`.
- The local CLI needs `~/.cloudflared/cert.pem` (Step 1). Re-run
  `cloudflared tunnel login`.

---

## Step 9 — Tear down

```bash
docker stop cloudflared-test

# Delete the public hostname routing
cloudflared tunnel route ip delete "ui.device-${DEV_UUID}.portal.stimba.sk" 2>/dev/null || true

# Delete the tunnel itself
cloudflared tunnel delete -f "$TUNNEL_NAME"

# Remove the DNS CNAME (dashboard or scripted)
# (skip if you want to keep the test subdomain warm for re-runs)
```

The `device-<uuid>` test tunnel UUID is gone after `delete -f`.
Re-running this runbook with the same `DEV_UUID` will mint a brand new
tunnel-id, which is the same code path the portal exercises on every
new pairing.

---

## Hand-off into the URCapX manifest

Once Step 8 is all green, the `cloudflared` container artifact in
`examples/manifest.yaml` (lines 119-141) is validated as the production
shape. The portal pairing flow becomes:

1. Customer scans pairing QR on the URCap install screen → URCap posts
   the pairing code to `portal.stimba.sk/pair`.
2. Portal mints a new `device-<uuid>` named tunnel via the Cloudflare
   API (Step 2 + Step 3 + Step 4 Option B), gets back a
   `TUNNEL_TOKEN` and a `device-<uuid>` UUID.
3. Portal creates the Access application + service-token policy
   (scripted equivalent of Step 7).
4. Portal POSTs both `cloudflareTunnelToken` and the device JWT into
   URCap secure storage via the install API.
5. URCapX runtime starts the `cloudflared` container with the token
   from secure storage. The Connection-registered lines appear in the
   URCap log feed within seconds, and the per-device URL is live.

That entire flow takes ~3 seconds wall-clock per device once the
portal-side automation lands (Sprint 6 Week 2 deliverable).

---

## Sign-off

Once Steps 8 + 9 are complete, mark Sprint 6 §6 item (e) `Cloudflare
account + API token` as ✅ in
`portal-stimba-sk/wiki/sprints/sprint-6-research.md` and append a
`progress.md` entry with:

- Cloudflare account email used (mask the account ID)
- `cloudflared --version` output
- Datacenter codes that registered (e.g. `fra07,fra08,ams01,ams02`) —
  useful baseline for production latency comparisons
- A screenshot of the Access login intercept for the audit log
