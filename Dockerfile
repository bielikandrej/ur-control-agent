# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# STIMBA UR Control Agent — Docker image
# Built for Universal Robots PolyscopeX container artifact runtime + PS5 parity.
#
# Runtime layout inside container:
#   /app/dist           compiled JS
#   /app/node_modules   prod-only deps
#   /app/package.json   metadata (version reported via /healthz)
#
# Expected volume mounts (declared by URCapX manifest.yaml):
#   /var/stimba/agent   persistent state (audit queue, metric buffer, tokens)
#
# Expected networking (declared by URCapX manifest.yaml):
#   services: urcontrol-primary    → grants access to Dashboard :29999 + RTDE :30004
#   ingress : internal             → 8787/tcp for URCap UI panel backchannel
# -----------------------------------------------------------------------------

# ---------- Stage 1: deps ---------------------------------------------------
FROM node:20.11-alpine AS deps
WORKDIR /app
# Use BuildKit cache mounts to speed up CI rebuilds
COPY package.json ./
# npm install (no lockfile yet in alpha — lockfile added when scaffold is wired
# into CI). Use ci once package-lock.json lands.
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --no-audit --no-fund && \
    cp -R node_modules /app/node_modules_prod && \
    npm install --no-audit --no-fund

# ---------- Stage 2: build --------------------------------------------------
FROM node:20.11-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# ---------- Stage 3: runtime -----------------------------------------------
FROM node:20.11-alpine AS runtime
WORKDIR /app

# Non-root user (UID 10001 is outside typical host namespaces but arbitrary;
# real UID is set by URCap runtime via manifest.yaml `user:` field if needed)
RUN addgroup -S stimba -g 10001 && adduser -S stimba -G stimba -u 10001

# Minimal runtime dependencies (curl for healthcheck from orchestrator side)
RUN apk add --no-cache tini curl ca-certificates tzdata && update-ca-certificates

# Prod-only node_modules + compiled dist
COPY --from=deps  /app/node_modules_prod ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# State directory (writable by stimba user)
RUN mkdir -p /var/stimba/agent && chown -R stimba:stimba /var/stimba /app

USER stimba

ENV NODE_ENV=production \
    STIMBA_AGENT_STATE_DIR=/var/stimba/agent \
    STIMBA_AGENT_LISTEN_HOST=127.0.0.1 \
    STIMBA_AGENT_LISTEN_PORT=8787 \
    LOG_LEVEL=info

EXPOSE 8787

# Container-level healthcheck (the URCap runtime may also poll /healthz)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/index.js"]

# OCI labels (rendered by `docker buildx imagetools inspect`)
LABEL org.opencontainers.image.title="STIMBA UR Control Agent" \
      org.opencontainers.image.description="Monitoring + audit + RTDE metrics push agent for UR robots managed by portal.stimba.sk" \
      org.opencontainers.image.vendor="STIMBA s.r.o." \
      org.opencontainers.image.licenses="Proprietary" \
      org.opencontainers.image.source="https://github.com/bielikandrej/stimba-ur-control-agent" \
      org.opencontainers.image.authors="Andrej Bielik <bielik@stimba.sk>"
