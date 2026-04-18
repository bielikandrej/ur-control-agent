import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import crypto from "node:crypto";
import { z } from "zod";
import type { Logger } from "pino";
import type { DashboardClient, DashboardCommandTier } from "./dashboard-client.js";
import type { PortalClient } from "./portal-client.js";
import type { PersistentQueue } from "./persistent-queue.js";
import type { AuditEvent } from "./portal-client.js";

/**
 * Local HTTP API server — listens on 127.0.0.1:8787 by default.
 *
 * Consumers:
 *   - URCap UI panel (React in PSX, Java Swing in PS5) — same-host, calls
 *     `/v1/state` and `/v1/command/*` for inline status + manual ops
 *   - URCap install lifecycle hook — calls `/v1/healthz` during boot probe
 *   - portal.stimba.sk does NOT call this directly; it pushes commands by
 *     issuing tickets which the agent pulls/validates via PortalClient
 *
 * Auth model:
 *   - Bearer token (`STIMBA_AGENT_LISTEN_TOKEN`) shared with URCap UI
 *     — generated at install, stored in URCap secure storage on PSX side
 *
 * Rate limit: 60 req/min global, 10 req/min on `/v1/command/*` to mirror
 * portal-side throttle (ADR-008 §Q3).
 */

export interface ApiServerOptions {
  host: string;
  port: number;
  authToken: string;
  agentVersion: string;
  startedAt: number;
  logger: Logger;
  dashboard: DashboardClient;
  portal: PortalClient;
  auditQueue: PersistentQueue<AuditEvent>;
}

const CommandSchema = z.object({
  command: z.enum([
    "power_off",
    "power_on",
    "brake_release",
    "stop",
    "pause",
    "play",
    "load_program",
  ]),
  programPath: z.string().optional(),
  ticketId: z.string().optional(), // required for APPROVE-tier commands
  reason: z.string().optional(),
});

const TIER_BY_COMMAND: Record<string, DashboardCommandTier> = {
  power_off: "SAFE_WRITE",
  stop: "SAFE_WRITE",
  pause: "SAFE_WRITE",
  power_on: "APPROVE",
  brake_release: "APPROVE",
  play: "APPROVE",
  load_program: "APPROVE",
};

// Return type is inferred — the FastifyInstance generic carries through the
// pino Logger we passed in, which doesn't unify with FastifyBaseLogger if we
// annotate explicitly. Caller in index.ts only needs `.close()` and `.listen()`.
export async function buildApiServer(opts: ApiServerOptions) {
  const app = Fastify({
    logger: opts.logger,
    genReqId: () => crypto.randomBytes(8).toString("hex"),
  });

  await app.register(helmet, {
    // No CSP — agent is consumed by URCap UI not browsers
    contentSecurityPolicy: false,
  });

  await app.register(rateLimit, {
    global: true,
    max: 60,
    timeWindow: "1 minute",
    allowList: [], // no exemptions
  });

  // ---------- Auth hook ----------------------------------------------------
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/healthz" || req.url === "/v1/healthz") return;
    const provided =
      typeof req.headers.authorization === "string" &&
      req.headers.authorization.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : null;
    if (!provided || !timingSafeEq(provided, opts.authToken)) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  // ---------- /healthz (no auth) ------------------------------------------
  app.get("/healthz", async () => ({
    ok: true,
    agentVersion: opts.agentVersion,
    uptimeS: Math.round((Date.now() - opts.startedAt) / 1000),
  }));

  app.get("/v1/healthz", async () => ({
    ok: true,
    agentVersion: opts.agentVersion,
    uptimeS: Math.round((Date.now() - opts.startedAt) / 1000),
  }));

  // ---------- /v1/state ----------------------------------------------------
  app.get("/v1/state", async () => {
    const [robotMode, safety, loaded, running, ps] = await Promise.allSettled([
      opts.dashboard.getRobotMode(),
      opts.dashboard.getSafetyStatus(),
      opts.dashboard.getLoadedProgram(),
      opts.dashboard.isProgramRunning(),
      opts.dashboard.getPolyscopeVersion(),
    ]);
    return {
      robotMode: settled(robotMode),
      safetyStatus: settled(safety),
      loadedProgram: settled(loaded),
      programRunning: settled(running),
      polyscopeVersion: settled(ps),
    };
  });

  // ---------- /v1/command --------------------------------------------------
  app.post(
    "/v1/command",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const parsed = CommandSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", detail: parsed.error.issues });
      }
      const { command, programPath, ticketId, reason } = parsed.data;
      const tier = TIER_BY_COMMAND[command];

      // APPROVE tier requires a ticket validated by the portal
      if (tier === "APPROVE") {
        if (!ticketId) return reply.code(400).send({ error: "ticket_required" });
        try {
          const v = await opts.portal.validateTicket(ticketId);
          if (!v.approved) return reply.code(403).send({ error: "ticket_not_approved" });
          if (v.scope.command !== command) {
            return reply.code(403).send({ error: "ticket_scope_mismatch" });
          }
        } catch (err) {
          return reply.code(502).send({
            error: "ticket_validation_failed",
            detail: (err as Error).message,
          });
        }
      }

      // Execute via Dashboard
      let response: string;
      try {
        switch (command) {
          case "power_off":     response = await opts.dashboard.powerOff(); break;
          case "stop":          response = await opts.dashboard.stopProgram(); break;
          case "pause":         response = await opts.dashboard.pauseProgram(); break;
          case "power_on":      response = await opts.dashboard.powerOn(ticketId!); break;
          case "brake_release": response = await opts.dashboard.brakeRelease(ticketId!); break;
          case "play":          response = await opts.dashboard.playProgram(ticketId!); break;
          case "load_program":
            if (!programPath) return reply.code(400).send({ error: "programPath_required" });
            if (!/^[A-Za-z0-9._\-/ ]+\.(urp|script)$/i.test(programPath)) {
              return reply.code(400).send({ error: "invalid_program_path" });
            }
            response = await opts.dashboard.loadProgram(programPath, ticketId!);
            break;
        }
      } catch (err) {
        return reply.code(502).send({ error: "dashboard_failed", detail: (err as Error).message });
      }

      // Audit event (best effort — never block the response)
      opts.auditQueue
        .push({
          ts: new Date().toISOString(),
          kind: "command.api",
          actor: "ui:local",
          ticketId: ticketId ?? null,
          detail: { command, programPath, tier, reason: reason ?? null, response },
        })
        .catch((e) =>
          opts.logger.warn({ err: (e as Error).message }, "audit enqueue failed"),
        );

      return { ok: true, response };
    },
  );

  // ---------- Lifecycle ----------------------------------------------------
  await app.listen({ host: opts.host, port: opts.port });
  opts.logger.info({ host: opts.host, port: opts.port }, "api server listening");
  return app;
}

function settled<T>(r: PromiseSettledResult<T>): T | null {
  return r.status === "fulfilled" ? r.value : null;
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
