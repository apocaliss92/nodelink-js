import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { setInterval as setIntervalNode } from "node:timers";

import { BCUDP_DATA_HEADER_SIZE, BCUDP_DEFAULT_MTU, BCUDP_DISCOVERY_PORT_LOCAL_ANY, BCUDP_DISCOVERY_PORT_LOCAL_UID } from "./constants";
import { decodeBcUdpPacket, encodeAckPacket, encodeDataPacket, encodeDiscoveryPacket } from "./packets";
import { buildC2dC, buildC2dHb, parseD2cCr } from "./xml";

type SendEntry = { packetId: number; buf: Buffer; ts: number };

let neolinkUdpStreamInstanceSeq = 0;

/**
 * A fresh BCUDP implementation based directly on Neolink sources:
 * - `_refs/neolink/crates/core/src/bc_protocol/connection/discovery.rs`
 * - `_refs/neolink/crates/core/src/bc_protocol/connection/udpsource.rs`
 *
 * Design goals:
 * - Preserve ACK cadence (10ms), resend cadence (500ms), HB cadence (1s)
 * - Preserve Neolink wire fields (connId semantics, ack truth-table semantics)
 * - Keep UDP receive path cheap to avoid starving ACK/HB timers
 */
export class NeolinkUdpStream extends EventEmitter<{
  data: [Buffer];
  close: [];
  error: [Error];
  debug: [string, unknown?];
}> {
  public readonly instanceId = ++neolinkUdpStreamInstanceSeq;
  private sock: dgram.Socket | undefined;
  private mtu = BCUDP_DEFAULT_MTU;
  private closing = false;

  private remote: { host: string; port: number } | undefined;
  private uid: string;
  private host?: string;
  private broadcast = false;

  private clientId: number | undefined;
  private cameraId: number | undefined;

  private discoveryTidAny: number | undefined;
  private discoveryTidUid: number | undefined;

  private sendPacketId = 0;
  private packetsWant = 0;
  private received = new Map<number, Buffer>();
  private sent = new Map<number, SendEntry>();

  private ackTimer: NodeJS.Timeout | undefined;
  private resendTimer: NodeJS.Timeout | undefined;
  private hbTimer: NodeJS.Timeout | undefined;

  private lastAckPacket: Buffer = Buffer.alloc(0);

  // Internal discovery completion signal (avoid extra EventEmitter typing surface).
  private discoveryOkResolver: (() => void) | undefined;

  // Drain buffering (avoid event-loop starvation).
  private pendingData: Buffer[] = [];
  private pendingDataOffset = 0;
  private drainScheduled = false;
  private readonly maxDrainPerTick = 64;

  constructor(opts: { uid: string; host?: string; broadcast?: boolean; mtu?: number }) {
    super();
    this.uid = opts.uid;
    if (opts.host != null) this.host = opts.host;
    this.broadcast = !!opts.broadcast;
    if (opts.mtu) this.mtu = opts.mtu;
  }

  private stopTimers(): void {
    if (this.ackTimer) clearInterval(this.ackTimer);
    if (this.resendTimer) clearInterval(this.resendTimer);
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.ackTimer = undefined;
    this.resendTimer = undefined;
    this.hbTimer = undefined;
  }

  async connect(): Promise<void> {
    if (this.sock) return;
    // Allow reuse across multiple connects if the instance is intentionally reused,
    // but if it was previously closed we should allow it to connect again.
    this.closing = false;
    const sock = dgram.createSocket("udp4");
    this.sock = sock;

    sock.on("error", (e) => {
      // Always surface errors, but also ensure we stop timers if the socket dies.
      this.emit("error", e);
    });
    sock.on("close", () => {
      // CRITICAL: a dgram socket can close without our `close()` being called (errors, external teardown).
      // If we don't stop timers here, hb/ack/resend will keep firing and spamming logs.
      this.stopTimers();
      this.sock = undefined;
      this.remote = undefined;
      this.discoveryOkResolver = undefined;
      this.emit("close");
    });
    sock.on("message", (msg, rinfo) => this.handlePacket(msg, rinfo.address, rinfo.port));

    await new Promise<void>((resolve, reject) => {
      // Bind to an ephemeral port; Neolink binds 53500..54000, but ephemeral works on most systems.
      sock.bind(0, "0.0.0.0", () => resolve());
      sock.once("error", reject);
    });

    try {
      sock.setBroadcast(true);
    } catch {
      // ignore
    }

    await this.discoveryLocal();

    // Neolink: after discovery, disable broadcast.
    try {
      sock.setBroadcast(false);
    } catch {
      // ignore
    }

    this.updateAckPacket(); // empty ACK initially
    this.startTimers();
  }

  private async discoveryLocal(): Promise<void> {
    if (!this.sock) throw new Error("socket not bound");

    // Neolink generate_cid(): random i32
    const clientId = (Math.floor(Math.random() * 0xffffffff) | 0) as number;
    this.clientId = clientId;

    const clientPort = (this.sock.address() as AddressInfo).port;

    // Neolink uses stable tids per discovery port across retries.
    this.discoveryTidAny ??= (Math.floor(Math.random() * 256) | 0) >>> 0;
    this.discoveryTidUid ??= (Math.floor(Math.random() * 256) | 0) >>> 0;

    const mtu = this.mtu;
    const xml = buildC2dC({ uid: this.uid, clientPort, cid: clientId, mtu });

    const targets: Array<{ host: string; port: number; tid: number }> = [];
    if (this.host) {
      targets.push({ host: this.host, port: BCUDP_DISCOVERY_PORT_LOCAL_UID, tid: this.discoveryTidUid! });
      targets.push({ host: this.host, port: BCUDP_DISCOVERY_PORT_LOCAL_ANY, tid: this.discoveryTidAny! });
    }
    if (this.broadcast) {
      // broadcast on both ports
      targets.push({ host: "255.255.255.255", port: BCUDP_DISCOVERY_PORT_LOCAL_UID, tid: this.discoveryTidUid! });
      targets.push({ host: "255.255.255.255", port: BCUDP_DISCOVERY_PORT_LOCAL_ANY, tid: this.discoveryTidAny! });
    }
    if (!targets.length) {
      throw new Error("NeolinkUdpStream: discovery requires host or broadcast=true");
    }

    const timeoutMs = 30_000;
    const retryMs = 500;
    const startedAt = Date.now();

    // Send immediately, then every 500ms until D2C_C_R for our cid arrives.
    for (;;) {
      if (!this.sock) throw new Error("socket closed during discovery");
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`BCUDP discovery timeout after ${timeoutMs}ms`);
      }

      for (const t of targets) {
        const pkt = encodeDiscoveryPacket(t.tid, xml);
        this.sock.send(pkt, t.port, t.host);
      }

      // Wait up to retryMs for a matching D2C_C_R (handled in handlePacket, which sets remote/cameraId).
      const ok = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), retryMs);
        const onOk = () => {
          clearTimeout(timer);
          resolve(true);
        };
        this.discoveryOkResolver = onOk;
      });
      if (ok) return;
    }
  }

  private startTimers(): void {
    if (!this.sock || !this.remote || this.clientId == null || this.cameraId == null) {
      throw new Error("NeolinkUdpStream not ready");
    }

    // ACK every 10ms
    this.ackTimer = setIntervalNode(() => {
      try {
        if (this.closing) return;
        this.sock?.send(this.lastAckPacket, this.remote!.port, this.remote!.host);
      } catch {
        // ignore
      }
    }, 10);

    // Resend every 500ms
    this.resendTimer = setIntervalNode(() => {
      try {
        if (this.closing) return;
        if (!this.sock || !this.remote) return;
        for (const [, entry] of this.sent) {
          this.sock.send(entry.buf, this.remote.port, this.remote.host);
        }
        // Also refresh ACK occasionally (Neolink does this on resend tick)
        this.updateAckPacket();
      } catch {
        // ignore
      }
    }, 500);

    // Heartbeat every 1s with random tid
    this.hbTimer = setIntervalNode(() => {
      try {
        if (this.closing) return;
        if (!this.sock || !this.remote || this.clientId == null || this.cameraId == null) return;
        const tid = (Math.floor(Math.random() * 256) | 0) >>> 0;
        // Neolink PCAP: C2D_HB uses did=0 (NOT the discovered did).
        // Sending the discovered did here triggers D2C_DISC on some firmwares (camera immediately disconnects).
        const xml = buildC2dHb({ cid: this.clientId, did: 0 });
        const pkt = encodeDiscoveryPacket(tid, xml);
        this.emit("debug", "udp_hb_send", { instanceId: this.instanceId, tid, cid: this.clientId, did: 0, host: this.remote.host, port: this.remote.port });
        this.sock.send(pkt, this.remote.port, this.remote.host, (err) => {
          if (err) this.emit("error", err);
          else this.emit("debug", "udp_hb_sent_ok", { instanceId: this.instanceId, tid });
        });
      } catch {
        // ignore
      }
    }, 1000);
  }

  private handlePacket(msg: Buffer, rhost: string, rport: number): void {
    let p: ReturnType<typeof decodeBcUdpPacket>;
    try {
      p = decodeBcUdpPacket(msg);
    } catch {
      return;
    }

    // Discovery handling: accept first D2C_C_R with matching cid, set remote.
    if (p.kind === "discovery") {
      const cr = parseD2cCr(p.xml);
      if (cr && cr.rsp === 0 && this.clientId != null && cr.cid === this.clientId) {
        this.remote = { host: rhost, port: rport };
        this.cameraId = cr.did;
        this.emit("debug", "discovery_rx_connected", { instanceId: this.instanceId, tid: p.tid, disconnect: false, xml: p.xml });
        const r = this.discoveryOkResolver;
        this.discoveryOkResolver = undefined;
        r?.();
      }
      return;
    }

    if (!this.remote) return;
    if (this.remote.host !== rhost || this.remote.port !== rport) {
      // Neolink/udpsource is strict about addr matching; ignore stray packets.
      return;
    }

    if (p.kind === "ack") {
      // Camera ACKs what it received from us (connectionId == clientId).
      if (this.clientId != null && p.connectionId === this.clientId) {
        this.handleAckFromCamera(p.packetId, p.payload);
      }
      return;
    }

    if (p.kind === "data") {
      // Only accept camera->client DATA that matches our clientId.
      if (this.clientId != null && p.connectionId === this.clientId) {
        if (p.packetId >= this.packetsWant) {
          this.received.set(p.packetId, p.payload);
          this.updateAckPacket();
          this.flushReceived();
        }
      }
    }
  }

  private buildAckPayload(): { packetId: number; payload: Buffer } {
    // Neolink: empty ACK until we have consumed at least one packet.
    if (this.packetsWant === 0) {
      return { packetId: 0xffffffff, payload: Buffer.alloc(0) };
    }

    let firstMissing = this.packetsWant;
    while (this.received.has(firstMissing)) firstMissing++;

    let max = firstMissing - 1;
    for (const k of this.received.keys()) {
      if (k > max) max = k;
    }

    if (max < firstMissing) {
      return { packetId: (firstMissing - 1) >>> 0, payload: Buffer.alloc(0) };
    }

    const len = max - firstMissing + 1;
    const bytes = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) bytes[i] = this.received.has(firstMissing + i) ? 1 : 0;
    return { packetId: (firstMissing - 1) >>> 0, payload: bytes };
  }

  private updateAckPacket(): void {
    if (this.cameraId == null) return;
    const { packetId, payload } = this.buildAckPayload();
    this.lastAckPacket = encodeAckPacket({
      // Neolink: client->camera ACK uses connectionId=0 (camera->client DATA uses cid; camera->client ACK uses cid).
      // This is visible byte-for-byte in the reference PCAP: conn=0 on ACK packets sent by the client.
      connectionId: 0,
      groupId: packetId === 0xffffffff && payload.length === 0 ? 0xffffffff : 0,
      packetId,
      maybeLatency: 0,
      payload,
    });
  }

  private handleAckFromCamera(packetId: number, payload: Buffer): void {
    if (packetId !== 0xffffffff) {
      for (const k of this.sent.keys()) {
        if (k <= packetId) this.sent.delete(k);
      }
      for (let i = 0; i < payload.length; i++) {
        if ((payload[i] ?? 0) > 0) this.sent.delete(((packetId + 1 + i) >>> 0) as number);
      }
    }
  }

  private flushReceived(): void {
    while (this.received.has(this.packetsWant)) {
      const chunk = this.received.get(this.packetsWant)!;
      this.received.delete(this.packetsWant);
      this.packetsWant++;
      this.pendingData.push(chunk);
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      const end = Math.min(this.pendingData.length, this.pendingDataOffset + this.maxDrainPerTick);
      for (; this.pendingDataOffset < end; this.pendingDataOffset++) {
        this.emit("data", this.pendingData[this.pendingDataOffset]!);
      }
      if (this.pendingDataOffset >= this.pendingData.length) {
        this.pendingData = [];
        this.pendingDataOffset = 0;
        return;
      }
      this.scheduleDrain();
    });
  }

  write(buf: Buffer): void {
    if (!this.sock || !this.remote || this.cameraId == null) throw new Error("NeolinkUdpStream is not connected");
    const maxPayload = this.mtu - BCUDP_DATA_HEADER_SIZE;
    for (let off = 0; off < buf.length; off += maxPayload) {
      const payload = buf.subarray(off, Math.min(buf.length, off + maxPayload));
      const packetId = this.sendPacketId >>> 0;
      this.sendPacketId = (this.sendPacketId + 1) >>> 0;
      // Neolink: client->camera DATA uses connectionId=0.
      const pkt = encodeDataPacket({ connectionId: 0, packetId, payload: Buffer.from(payload) });
      this.sent.set(packetId, { packetId, buf: pkt, ts: Date.now() });
      this.sock.send(pkt, this.remote.port, this.remote.host);
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.stopTimers();

    const s = this.sock;
    this.sock = undefined;
    this.remote = undefined;
    this.discoveryOkResolver = undefined;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}


