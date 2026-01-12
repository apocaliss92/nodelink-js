import dgram from "node:dgram";
import { EventEmitter } from "node:events";

export type Udp7777Packet = {
  rinfo: { address: string; port: number };
  receivedAtMs: number;
  raw: Buffer;
  magicLE: number;
  dataLen: number;
  seq: number;
  uid: string;
  headerLen: number;
  data: Buffer;
};

export type Udp7777ListenerOptions = {
  /** Bind address (default: 0.0.0.0) */
  host?: string;
  /** Bind port (default: 7777) */
  port?: number;
  /** If set, only emit packets for this UID */
  filterUid?: string;
};

/**
 * Minimal UDP/7777 listener (observed on Home Hub LAN captures).
 *
 * Notes:
 * - Captures show camera -> hub UDP/7777 only (no replies observed).
 * - Packet format observed so far:
 *   - u32le magic (0x2a87cf32)
 *   - u32le dataLen
 *   - u32le seq
 *   - 16-byte ASCII UID (null-padded)
 *   - 16 bytes of zeros/padding
 *   - data (dataLen bytes)
 */
export class Udp7777Listener extends EventEmitter {
  private sock: dgram.Socket | undefined;
  private readonly opts: { host: string; port: number; filterUid?: string };

  constructor(options: Udp7777ListenerOptions = {}) {
    super();
    const host = options.host ?? "0.0.0.0";
    const port = options.port ?? 7777;
    this.opts = options.filterUid ? { host, port, filterUid: options.filterUid } : { host, port };
  }

  start(): Promise<void> {
    if (this.sock) return Promise.resolve();

    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.sock = sock;

    sock.on("error", (err) => this.emit("error", err));
    sock.on("message", (msg, rinfo) => {
      const p = this.tryParse(msg);
      if (!p) return;
      if (this.opts.filterUid && p.uid !== this.opts.filterUid) return;
      this.emit("packet", { ...p, rinfo: { address: rinfo.address, port: rinfo.port }, receivedAtMs: Date.now(), raw: msg } satisfies Udp7777Packet);

      // Heuristic: in idle_pir_idle_pir_idle capture, PIR-looking bursts included a 55-byte packet.
      if (msg.length === 55) this.emit("pirCandidate", p.uid);
    });

    return new Promise<void>((resolve) => {
      sock.bind(this.opts.port, this.opts.host, () => resolve());
    });
  }

  close(): Promise<void> {
    const sock = this.sock;
    this.sock = undefined;
    if (!sock) return Promise.resolve();
    return new Promise<void>((resolve) => {
      try {
        sock.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  private tryParse(msg: Buffer): Omit<Udp7777Packet, "rinfo" | "receivedAtMs" | "raw"> | undefined {
    if (msg.length < 44) return undefined;
    const magicLE = msg.readUInt32LE(0);
    if (magicLE !== 0x2a87cf32) return undefined;

    const dataLen = msg.readUInt32LE(4);
    const seq = msg.readUInt32LE(8);
    const headerLen = msg.length - dataLen;
    if (headerLen !== 44) return undefined;

    const uidRaw = msg.subarray(12, 28);
    const nul = uidRaw.indexOf(0);
    const uid = (nul >= 0 ? uidRaw.subarray(0, nul) : uidRaw).toString("ascii");

    const data = msg.subarray(44);
    return { magicLE, dataLen, seq, uid, headerLen, data };
  }
}
