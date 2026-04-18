import { Agent, fetch, type RequestInit } from "undici";
import crypto from "node:crypto";
import type { Logger } from "pino";

/**
 * Thin HTTP client for portal.stimba.sk endpoints used by the agent:
 *
 *   POST /api/agent/heartbeat        { ts, deviceId, robotMode, safety, … }
 *   POST /api/agent/metrics/ingest   { events: MetricEvent[] }
 *   POST /api/agent/audit            { events: AuditEvent[] }
 *   POST /api/agent/log-upload  multipart bundle (Sprint 7 §2 "Download logs")
 *   GET  /api/agent/policy      → { allowedTiers, hitlRequiredTiers, killSwitch }
 *   GET  /api/agent/tickets/:id → HITL approval ticket validation
 *
 * Auth: device-scoped JWT in `Authorization: Bearer <token>`.
 *
 * TLS pinning: when `pinSha256` is configured, verify the leaf cert SHA-256
 * matches before accepting the response. Implemented via undici Dispatcher.
 */

export interface PortalClientOptions {
  baseUrl: string;
  token: string;
  pinSha256?: string;
  deviceId: string;
  logger: Logger;
  fetchTimeoutMs?: number;
}

export class PortalClient {
  private readonly dispatcher: Agent;

  constructor(private readonly opts: PortalClientOptions) {
    this.dispatcher = new Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      headersTimeout: opts.fetchTimeoutMs ?? 10_000,
      bodyTimeout: opts.fetchTimeoutMs ?? 10_000,
      connect: opts.pinSha256
        ? {
            // Strict TLS pin check
            checkServerIdentity: (host, cert) => {
              const fingerprint = crypto
                .createHash("sha256")
                .update(cert.raw)
                .digest("hex")
                .toUpperCase();
              const expected = opts.pinSha256!.replace(/:/g, "").toUpperCase();
              if (fingerprint !== expected) {
                return new Error(
                  `TLS pin mismatch for ${host}: got ${fingerprint}, expected ${expected}`,
                );
              }
              return undefined;
            },
          }
        : undefined,
    });
  }

  private url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async request<T>(path: string, init: RequestInit & { idempotencyKey?: string }): Promise<T> {
    // undici's RequestInit['headers'] is the same shape Headers accepts; cast
    // through unknown to dodge the lib.dom HeadersInit type that we don't load.
    const headers = new Headers(init.headers as unknown as ConstructorParameters<typeof Headers>[0]);
    headers.set("Authorization", `Bearer ${this.opts.token}`);
    headers.set("Content-Type", "application/json");
    headers.set("X-Stimba-Device-Id", this.opts.deviceId);
    headers.set("User-Agent", `stimba-ur-control-agent/1.0.0-alpha.1`);
    if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);

    const res = await fetch(this.url(path), {
      ...init,
      headers,
      dispatcher: this.dispatcher,
    } as RequestInit & { dispatcher: Agent });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.opts.logger.warn(
        { path, status: res.status, body: body.slice(0, 256) },
        "portal request failed",
      );
      throw new PortalError(res.status, body || res.statusText);
    }
    if (res.headers.get("content-length") === "0" || res.status === 204) {
      return undefined as unknown as T;
    }
    return (await res.json()) as T;
  }

  heartbeat(payload: HeartbeatPayload): Promise<void> {
    return this.request("/api/agent/heartbeat", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  pushMetrics(events: MetricEvent[], idemKey: string): Promise<{ accepted: number }> {
    return this.request("/api/agent/metrics/ingest", {
      method: "POST",
      body: JSON.stringify({ events }),
      idempotencyKey: idemKey,
    });
  }

  pushAudit(events: AuditEvent[], idemKey: string): Promise<{ accepted: number }> {
    return this.request("/api/agent/audit", {
      method: "POST",
      body: JSON.stringify({ events }),
      idempotencyKey: idemKey,
    });
  }

  fetchPolicy(): Promise<PolicySnapshot> {
    return this.request("/api/agent/policy", { method: "GET" });
  }

  validateTicket(ticketId: string): Promise<TicketValidation> {
    return this.request(`/api/agent/tickets/${encodeURIComponent(ticketId)}`, {
      method: "GET",
    });
  }
}

export class PortalError extends Error {
  constructor(public readonly status: number, message: string) {
    super(`portal HTTP ${status}: ${message}`);
    this.name = "PortalError";
  }
  isRetryable(): boolean {
    // 408 timeout, 429 throttle, 5xx server — retry
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

// ---------------------------------------------------------------------------
// Wire types — kept in sync with portal-stimba-sk/wiki/05-metrics-catalog.md
// ---------------------------------------------------------------------------

export interface HeartbeatPayload {
  ts: string; // ISO
  agentVersion: string;
  uptimeS: number;
  robotMode: string | null;
  safetyStatus: string | null;
  loadedProgram: string | null;
  programRunning: boolean | null;
  rtdeConnected: boolean;
  dashboardConnected: boolean;
  queueDepth: { metrics: number; audit: number };
}

export type MetricKind = "num" | "text" | "bool";

export interface MetricEvent {
  ts: string; // ISO timestamp
  metricKey: string; // e.g. "actual_q.0", "robot_mode"
  kind: MetricKind;
  valueNum?: number;
  valueText?: string;
  valueBool?: boolean;
  labels?: Record<string, string>;
}

export type AuditEventKind =
  | "command.dashboard"
  | "command.api"
  | "policy.refresh"
  | "tunnel.up"
  | "tunnel.down"
  | "agent.boot"
  | "agent.shutdown"
  | "rtde.connected"
  | "rtde.disconnected"
  | "ticket.consumed"
  | "ticket.rejected"
  | "killswitch.engaged";

export interface AuditEvent {
  ts: string;
  kind: AuditEventKind;
  actor: string; // "agent" | "portal:<userId>" | "ui:<sessionId>"
  detail: Record<string, unknown>;
  ticketId?: string | null;
}

export interface PolicySnapshot {
  policyVersion: number;
  allowedTiers: ("READ" | "SAFE_WRITE" | "APPROVE")[];
  hitlRequiredTiers: ("APPROVE" | "DANGEROUS")[];
  killSwitch: boolean;
  refreshIntervalSec: number;
}

export interface TicketValidation {
  ticketId: string;
  approved: boolean;
  expiresAt: string;
  scope: { command: string; tier: string };
  approvedBy?: string;
}
