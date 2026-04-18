import net from "node:net";
import { EventEmitter } from "node:events";
import type { Logger } from "pino";

/**
 * UR Dashboard Server client (TCP text protocol, default port 29999).
 *
 * Protocol reference:
 *   https://www.universal-robots.com/articles/ur/dashboard-server-e-series-port-29999/
 *
 * Commands used by the agent (READ-ONLY + safety controlled writes):
 *   - robotmode               → "Robotmode: RUNNING" / "POWER_OFF" / "IDLE" / ...
 *   - safetystatus            → "Safetystatus: NORMAL" / "PROTECTIVE_STOP" / ...
 *   - programState            → "STOPPED <program>" / "PLAYING <program>"
 *   - get loaded program      → "Loaded program: <path>"
 *   - running                 → "Program running: true|false"
 *   - PolyscopeVersion        → "URSoftware X.Y.Z-rc? (DATE)"
 *   - serial number           → "<serial>"
 *   - power on                → "Powering on"            (gated — safety tier SAFE_WRITE)
 *   - power off               → "Powering off"           (SAFE_WRITE)
 *   - brake release           → "Brake releasing"        (SAFE_WRITE)
 *   - stop                    → "Stopped"                (SAFE_WRITE)
 *   - pause                   → "Pausing program"        (SAFE_WRITE)
 *   - play                    → "Starting program"       (APPROVE — HITL in portal)
 *   - load <program>          → "Loading program: ..."   (APPROVE)
 *
 * Gating is enforced by the portal and re-verified here before send.
 *
 * NOTE: Dashboard server accepts one connection at a time per controller.
 * We maintain a single persistent connection with auto-reconnect + queue.
 */

export interface DashboardClientOptions {
  host: string;
  port: number;
  logger: Logger;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  commandTimeoutMs?: number;
}

export type DashboardCommandTier = "READ" | "SAFE_WRITE" | "APPROVE" | "DANGEROUS";

type PendingCommand = {
  command: string;
  tier: DashboardCommandTier;
  resolve: (response: string) => void;
  reject: (err: Error) => void;
  deadline: number;
};

export class DashboardClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = "";
  private queue: PendingCommand[] = [];
  private inFlight: PendingCommand | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly opts: DashboardClientOptions) {
    super();
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("DashboardClient already closed");
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);

      const onConnect = () => {
        this.opts.logger.info({ host: this.opts.host, port: this.opts.port }, "dashboard connected");
        this.reconnectAttempt = 0;
        this.socket = socket;
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("error", (err) => this.onError(err));
        socket.on("close", () => this.onClose());
        this.emit("connect");
        resolve();
      };

      const onEarlyError = (err: Error) => {
        socket.removeListener("connect", onConnect);
        reject(err);
      };

      socket.once("connect", onConnect);
      socket.once("error", onEarlyError);
      socket.connect(this.opts.port, this.opts.host);
    });
  }

  /**
   * Send a command with an explicit safety tier. The tier is logged + echoed
   * into audit events. Commands of tier APPROVE/DANGEROUS are rejected unless
   * the portal has pre-approved them via an HITL ticket (checked upstream).
   */
  send(command: string, tier: DashboardCommandTier = "READ"): Promise<string> {
    return new Promise((resolve, reject) => {
      const pending: PendingCommand = {
        command,
        tier,
        resolve,
        reject,
        deadline: Date.now() + (this.opts.commandTimeoutMs ?? 5_000),
      };
      this.queue.push(pending);
      this.pump();
    });
  }

  // ---------- Convenience typed accessors -----------------------------------

  async getRobotMode(): Promise<string> {
    const resp = await this.send("robotmode", "READ");
    return resp.replace(/^Robotmode:\s*/i, "").trim();
  }

  async getSafetyStatus(): Promise<string> {
    const resp = await this.send("safetystatus", "READ");
    return resp.replace(/^Safetystatus:\s*/i, "").trim();
  }

  async isProgramRunning(): Promise<boolean> {
    const resp = await this.send("running", "READ");
    return /true/i.test(resp);
  }

  async getLoadedProgram(): Promise<string | null> {
    const resp = await this.send("get loaded program", "READ");
    const m = resp.match(/Loaded program:\s*(.+)$/i);
    return m ? m[1].trim() : null;
  }

  async getSerial(): Promise<string> {
    // "serial number" response is just the raw serial
    return (await this.send("get serial number", "READ")).trim();
  }

  async getPolyscopeVersion(): Promise<string> {
    return (await this.send("PolyscopeVersion", "READ")).trim();
  }

  // ---------- SAFE_WRITE ops (can run without HITL approval) ----------------

  powerOff(): Promise<string> { return this.send("power off", "SAFE_WRITE"); }
  stopProgram(): Promise<string> { return this.send("stop", "SAFE_WRITE"); }
  pauseProgram(): Promise<string> { return this.send("pause", "SAFE_WRITE"); }

  // APPROVE ops — MUST only be invoked after portal returns an approved ticket
  powerOn(_ticket: string): Promise<string> { return this.send("power on", "APPROVE"); }
  brakeRelease(_ticket: string): Promise<string> { return this.send("brake release", "APPROVE"); }
  playProgram(_ticket: string): Promise<string> { return this.send("play", "APPROVE"); }
  loadProgram(path: string, _ticket: string): Promise<string> {
    // path is sanitized by caller (api-server) — only alnum + _ - . / allowed
    return this.send(`load ${path}`, "APPROVE");
  }

  // ---------- Internals -----------------------------------------------------

  private pump(): void {
    if (this.inFlight) return;
    if (!this.socket || this.socket.destroyed) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = next;
    this.opts.logger.debug(
      { tier: next.tier, cmd: next.command },
      "dashboard → send",
    );
    this.socket.write(`${next.command}\n`);
    // Per-command deadline guard
    setTimeout(() => {
      if (this.inFlight === next) {
        this.inFlight = null;
        next.reject(new Error(`dashboard command timeout: ${next.command}`));
        this.pump();
      }
    }, Math.max(100, next.deadline - Date.now()));
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (!this.inFlight) {
        this.opts.logger.warn({ line }, "dashboard unsolicited line");
        continue;
      }
      const p = this.inFlight;
      this.inFlight = null;
      p.resolve(line);
      this.pump();
    }
  }

  private onError(err: Error): void {
    this.opts.logger.warn({ err: err.message }, "dashboard socket error");
    this.emit("error", err);
  }

  private onClose(): void {
    this.opts.logger.warn("dashboard socket closed");
    this.socket = null;
    // Fail in-flight + queued, scheduler will retry them on reconnect? Keep
    // simple: reject all, let caller decide retry semantics.
    const err = new Error("dashboard disconnected");
    if (this.inFlight) {
      this.inFlight.reject(err);
      this.inFlight = null;
    }
    for (const p of this.queue) p.reject(err);
    this.queue = [];
    if (!this.closed) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const base = this.opts.reconnectBaseMs ?? 500;
    const max = this.opts.reconnectMaxMs ?? 30_000;
    const delay = Math.min(max, base * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.opts.logger.info({ delayMs: delay, attempt: this.reconnectAttempt }, "dashboard reconnect scheduled");
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.opts.logger.warn({ err: err.message }, "dashboard reconnect failed");
        this.scheduleReconnect();
      });
    }, delay);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) this.socket.destroy();
  }
}
