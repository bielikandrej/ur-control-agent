import net from "node:net";
import { EventEmitter } from "node:events";
import type { Logger } from "pino";

/**
 * RTDE (Real-Time Data Exchange) client — skeleton.
 *
 * RTDE is a binary request/response protocol over TCP :30004. The protocol
 * spec is published by UR:
 *   https://www.universal-robots.com/articles/ur/interface-communication/real-time-data-exchange-rtde-guide/
 *
 * This file sets up the connection lifecycle and subscription model; the full
 * packet codec is deferred to Sprint 6 Week 2 (see sprint-6-urcapx.md §scope).
 * We default to polling Dashboard server for mode/safety in v0 and switch to
 * RTDE for high-rate metrics (actual joint positions, TCP velocity, motor
 * currents) in v1.
 *
 * Expected metric outputs (v1):
 *   - actual_TCP_pose          (Vector6D)
 *   - actual_TCP_speed         (Vector6D)
 *   - actual_q                 (Vector6D, joint positions rad)
 *   - actual_qd                (Vector6D, joint velocities rad/s)
 *   - actual_current           (Vector6D, motor currents A)
 *   - robot_mode               (int32)
 *   - safety_mode              (int32)
 *   - runtime_state            (uint32)
 *   - target_speed_fraction    (double, 0.0..1.0)
 *   - actual_digital_input_bits  (uint64 bitmask)
 *   - actual_digital_output_bits (uint64 bitmask)
 *
 * These map 1:1 to `metrics_raw` rows in portal DB via metrics-pusher.
 */

export type RtdeSample = {
  timestamp: number; // ms since epoch on agent
  robotTimeS: number; // seconds since controller boot (from RTDE `timestamp` output)
  robotMode: number;
  safetyMode: number;
  runtimeState: number;
  targetSpeedFraction: number;
  actualQ: [number, number, number, number, number, number];
  actualQd: [number, number, number, number, number, number];
  actualCurrent: [number, number, number, number, number, number];
  actualTcpPose: [number, number, number, number, number, number];
  digitalInputs: bigint;
  digitalOutputs: bigint;
};

export interface RtdeClientOptions {
  host: string;
  port: number;
  pollHz: number;
  logger: Logger;
}

export class RtdeClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private closed = false;

  constructor(private readonly opts: RtdeClientOptions) {
    super();
  }

  async connect(): Promise<void> {
    // TODO(sprint-6-w2): RTDE protocol negotiation
    //   1. Send RTDE_REQUEST_PROTOCOL_VERSION (V_2)
    //   2. Send RTDE_CONTROL_PACKAGE_SETUP_OUTPUTS with list above + frequency
    //   3. Receive variable types + recipe ID
    //   4. Send RTDE_CONTROL_PACKAGE_START
    //   5. Read RTDE_DATA_PACKAGE loop, decode per recipe
    //
    // For v0 we keep this a no-op; metrics-pusher falls back to Dashboard
    // polling for robotMode / safetyStatus / isRunning at 1 Hz.
    this.opts.logger.info(
      { host: this.opts.host, port: this.opts.port, hz: this.opts.pollHz },
      "rtde-client: skeleton only, skipping real connect (v0)",
    );
  }

  /** Subscribe to decoded samples; callback invoked at configured pollHz. */
  onSample(_cb: (sample: RtdeSample) => void): () => void {
    // TODO(sprint-6-w2): wire real decoder
    return () => {};
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.socket) this.socket.destroy();
  }
}
