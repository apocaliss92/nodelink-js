import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { type AddressInfo } from "node:net";
import { setInterval as setIntervalNode } from "node:timers";
import { BCUDP_DATA_HEADER_SIZE, BCUDP_DEFAULT_MTU, BCUDP_DISCOVERY_PORT_LOCAL_UID } from "./constants.js";
import { decodeBcUdpPacket, encodeAckPacket, encodeDataPacket, encodeDiscoveryPacket } from "./packets.js";
import { buildC2dC, buildC2dHb, parseD2cCr } from "./xml.js";

export type BcUdpStreamOptions =
  | {
      /** Local discovery via UID (typical for battery cameras). */
      mode: "uid";
      uid: string;
      host?: string;
      port?: number;
      mtu?: number;
      /** If true, enables UDP broadcast for discovery. */
      broadcast?: boolean;
      /** Discovery timeout in milliseconds (default: 30000 for battery cameras that may be sleeping). */
      discoveryTimeout?: number;
      /** Interval between discovery retry packets in milliseconds (default: 500). */
      discoveryRetryInterval?: number;
    }
  | {
      /** Direct connection with already-known parameters. */
      mode: "direct";
      host: string;
      port: number;
      clientId: number;
      cameraId: number;
      mtu?: number;
    };

type SendEntry = { packetId: number; buf: Buffer; ts: number };

/**
 * Implements BCUDP as a reliable "byte stream" (ACK + resend),
 * following `neolink` (`UdpPayloadSource`).
 */
export class BcUdpStream extends EventEmitter<{
  data: [Buffer];
  close: [];
  error: [Error];
  debug: [string, unknown?];
}> {
  private readonly opts: BcUdpStreamOptions;
  private sock: dgram.Socket | undefined;
  private remote?: { host: string; port: number };
  private mtu: number;

  private clientId: number | undefined;
  private cameraId: number | undefined;

  private sendPacketId = 0;
  private packetsWant = 0;
  private received = new Map<number, Buffer>();
  private sent = new Map<number, SendEntry>();

  private ackTimer: NodeJS.Timeout | undefined;
  private resendTimer: NodeJS.Timeout | undefined;
  private hbTimer: NodeJS.Timeout | undefined;

  constructor(options: BcUdpStreamOptions) {
    super();
    this.opts = options;
    this.mtu = options.mtu ?? BCUDP_DEFAULT_MTU;
  }

  async connect(): Promise<void> {
    if (this.sock) return;
    const sock = dgram.createSocket("udp4");
    this.sock = sock;

    sock.on("message", (msg, rinfo) => {
      try {
        const p = decodeBcUdpPacket(msg);
        this.handlePacket(p, rinfo.address, rinfo.port);
      } catch (e) {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
      }
    });
    sock.on("error", (e) => this.emit("error", e));
    sock.on("close", () => this.emit("close"));

    await new Promise<void>((resolve) => sock.bind(0, "0.0.0.0", () => resolve()));

    if (this.opts.mode === "direct") {
      this.remote = { host: this.opts.host, port: this.opts.port };
      this.clientId = this.opts.clientId;
      this.cameraId = this.opts.cameraId;
    } else {
      await this.discoveryUid(sock);
    }

    this.startTimers();
  }

  private async discoveryUid(sock: dgram.Socket): Promise<void> {
    if (this.opts.mode !== "uid") throw new Error("Internal: discoveryUid called for non-uid mode");
    const port = this.opts.port ?? BCUDP_DISCOVERY_PORT_LOCAL_UID;
    const host = this.opts.host ?? "255.255.255.255";
    const broadcast = this.opts.broadcast ?? true;
    // Longer timeout for battery cameras that may be sleeping (default 30s, was 5s)
    const discoveryTimeout = this.opts.discoveryTimeout ?? 30_000;
    // Retry interval for sending discovery packets to wake up sleeping cameras
    const retryInterval = this.opts.discoveryRetryInterval ?? 500;

    if (broadcast) {
      sock.setBroadcast(true);
    }

    const addr = sock.address();
    const localPort = typeof addr === "string" ? 0 : (addr as AddressInfo).port;
    const cid = (Math.floor(Math.random() * 0x7fffffff) | 0) || 82000;

    // Build discovery packet (will be reused for retries)
    const xml = buildC2dC({ uid: this.opts.uid, clientPort: localPort, cid, mtu: this.mtu, os: "WIN" });

    const reply = await new Promise<{ cid: number; did: number; rhost: string; rport: number }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (retryTimer) clearInterval(retryTimer);
        sock.off("message", onMsg);
        reject(new Error(`BCUDP discovery timeout after ${discoveryTimeout}ms (camera may be sleeping or unreachable)`));
      }, discoveryTimeout);

      let retryTimer: NodeJS.Timeout | undefined;
      let retryCount = 0;

      const onMsg = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        try {
          const p = decodeBcUdpPacket(msg);
          if (p.kind !== "discovery") return;
          const parsed = parseD2cCr(p.xml);
          if (!parsed) return;
          if (parsed.rsp !== 0) return;
          // Success! Camera responded
          clearTimeout(timeout);
          if (retryTimer) clearInterval(retryTimer);
          sock.off("message", onMsg);
          this.emit("debug", "discovery_success", { retryCount, rhost: rinfo.address, rport: rinfo.port });
          resolve({ cid: parsed.cid, did: parsed.did, rhost: rinfo.address, rport: rinfo.port });
        } catch {
          // ignore
        }
      };
      sock.on("message", onMsg);

      // Send initial discovery packet
      const sendDiscovery = () => {
        const tid = (Math.floor(Math.random() * 255) | 0) >>> 0;
        const packet = encodeDiscoveryPacket(tid, xml);
        try {
          sock.send(packet, port, host);
          retryCount++;
          this.emit("debug", "discovery_send", { retryCount, host, port });
        } catch (e) {
          this.emit("error", e instanceof Error ? e : new Error(String(e)));
        }
      };

      // Send initial packet immediately
      sendDiscovery();

      // Retry sending discovery packets at regular intervals to wake up sleeping cameras
      // This mimics neolink behavior for battery cameras
      retryTimer = setIntervalNode(() => {
        sendDiscovery();
      }, retryInterval);
    });

    this.clientId = reply.cid;
    this.cameraId = reply.did;
    // After discovery, the peer is the responder address (port may vary by model).
    this.remote = { host: reply.rhost, port: reply.rport };
  }

  private startTimers(): void {
    if (!this.sock || !this.remote || this.clientId == null || this.cameraId == null) {
      throw new Error("BCUDP not ready");
    }

    // ACK every 10ms (official client / neolink behavior)
    this.ackTimer = setIntervalNode(() => {
      try {
        this.sendAck();
      } catch (e) {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
      }
    }, 10);

    // resend every 500ms
    this.resendTimer = setIntervalNode(() => {
      try {
        this.resendOutstanding();
      } catch (e) {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
      }
    }, 500);

    // heartbeat every 1s
    this.hbTimer = setIntervalNode(() => {
      try {
        this.sendHeartbeat();
      } catch (e) {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
      }
    }, 1000);
  }

  private sendHeartbeat(): void {
    if (!this.sock || !this.remote || this.clientId == null || this.cameraId == null) return;
    const tid = (Math.floor(Math.random() * 255) | 0) >>> 0;
    const xml = buildC2dHb({ cid: this.clientId, did: this.cameraId });
    const pkt = encodeDiscoveryPacket(tid, xml);
    this.sock.send(pkt, this.remote.port, this.remote.host);
  }

  private buildAckPayload(): { packetId: number; payload: Buffer } {
    if (this.packetsWant === 0) {
      return { packetId: 0xffffffff, payload: Buffer.alloc(0) };
    }
    let firstMissing = this.packetsWant;
    while (this.received.has(firstMissing)) firstMissing++;

    const max = this.received.size === 0 ? firstMissing - 1 : Math.max(firstMissing - 1, ...this.received.keys());
    const bytes: number[] = [];
    for (let i = firstMissing; i <= max; i++) {
      bytes.push(this.received.has(i) ? 1 : 0);
    }
    return { packetId: (firstMissing - 1) >>> 0, payload: Buffer.from(bytes) };
  }

  private sendAck(): void {
    if (!this.sock || !this.remote || this.clientId == null || this.cameraId == null) return;
    const { packetId, payload } = this.buildAckPayload();
    const ack = encodeAckPacket({
      connectionId: this.cameraId, // towards camera: did
      groupId: packetId === 0xffffffff ? 0xffffffff : 0,
      packetId,
      maybeLatency: 0,
      payload,
    });
    this.sock.send(ack, this.remote.port, this.remote.host);
  }

  private resendOutstanding(): void {
    if (!this.sock || !this.remote) return;
    for (const [, entry] of this.sent) {
      this.sock.send(entry.buf, this.remote.port, this.remote.host);
    }
  }

  private handleAckFromCamera(packetId: number, payload: Buffer): void {
    // Porting of neolink behavior: camera ACKs what it received from us.
    // Remove <= packetId and those marked 1 in payload (relative to packetId).
    if (packetId !== 0xffffffff) {
      for (const k of this.sent.keys()) {
        if (k <= packetId) this.sent.delete(k);
      }
      for (let i = 0; i < payload.length; i++) {
        const v = payload[i] ?? 0;
        if (v > 0) {
          const pid = (packetId + 1 + i) >>> 0;
          this.sent.delete(pid);
        }
      }
    }
  }

  private flushReceived(): void {
    // emit contiguous received payloads as a byte stream
    while (this.received.has(this.packetsWant)) {
      const chunk = this.received.get(this.packetsWant)!;
      this.received.delete(this.packetsWant);
      this.packetsWant++;
      this.emit("data", chunk);
    }
  }

  private handlePacket(p: ReturnType<typeof decodeBcUdpPacket>, rhost: string, rport: number): void {
    // Bind remote to whoever talks to us after discovery (robustness)
    if (!this.remote) this.remote = { host: rhost, port: rport };

    if (p.kind === "ack") {
      if (this.clientId != null && p.connectionId === this.clientId) {
        this.handleAckFromCamera(p.packetId, p.payload);
      }
      return;
    }

    if (p.kind === "data") {
      if (this.clientId != null && p.connectionId === this.clientId) {
        if (p.packetId >= this.packetsWant) {
          this.received.set(p.packetId, p.payload);
          this.flushReceived();
        }
      }
      return;
    }

    // discovery packets after connect (HB, disconnect, etc.) -> ignored for now.
    return;
  }

  write(buf: Buffer): void {
    if (!this.sock || !this.remote || this.cameraId == null) throw new Error("BCUDP stream is not connected");
    const maxPayload = this.mtu - BCUDP_DATA_HEADER_SIZE;
    for (let off = 0; off < buf.length; off += maxPayload) {
      const payload = buf.subarray(off, Math.min(buf.length, off + maxPayload));
      const packetId = this.sendPacketId >>> 0;
      this.sendPacketId = (this.sendPacketId + 1) >>> 0;
      const pkt = encodeDataPacket({ connectionId: this.cameraId, packetId, payload: Buffer.from(payload) });
      this.sent.set(packetId, { packetId, buf: pkt, ts: Date.now() });
      this.sock.send(pkt, this.remote.port, this.remote.host);
    }
  }

  async close(): Promise<void> {
    if (this.ackTimer) clearInterval(this.ackTimer);
    if (this.resendTimer) clearInterval(this.resendTimer);
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.ackTimer = undefined;
    this.resendTimer = undefined;
    this.hbTimer = undefined;

    const s = this.sock;
    this.sock = undefined;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

