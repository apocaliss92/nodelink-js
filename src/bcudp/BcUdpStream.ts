import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { type AddressInfo } from "node:net";
import { setInterval as setIntervalNode } from "node:timers";
import { BCUDP_DATA_HEADER_SIZE, BCUDP_DEFAULT_MTU, BCUDP_DISCOVERY_PORT_LOCAL_UID, BCUDP_DISCOVERY_PORT_LOCAL_ANY } from "./constants";
import { decodeBcUdpPacket, encodeAckPacket, encodeDataPacket, encodeDiscoveryPacket } from "./packets";
import { buildC2dA, buildC2dC, buildC2dHb, buildC2dT, parseD2cCfm, parseD2cCr, parseD2cT } from "./xml";

class AckLatency {
  private currentValues: number[] = [];
  private lastReceiveTime: number | null = null;
  private displayValue: number = 0;
  private lastDisplayTime: number | null = null;

  getValue(): number {
    return this.displayValue;
  }

  feed(): void {
    const now = performance.now(); // Use high-res timer if available, or Date.now()
    if (this.lastReceiveTime !== null) {
      const diff = (now - this.lastReceiveTime) * 1000; // ms to micros
      this.currentValues.push(diff);
    }
    this.lastReceiveTime = now;

    if (this.lastDisplayTime !== null) {
      if (now - this.lastDisplayTime > 1000) {
        this.lastDisplayTime = now;
        const count = this.currentValues.length;
        if (count > 0) {
          const sum = this.currentValues.reduce((a, b) => a + b, 0);
          this.displayValue = Math.floor(sum / count);
        } else {
          this.displayValue = 0;
        }
        this.currentValues = [];
      }
    } else {
      this.lastDisplayTime = now;
      this.displayValue = 0;
    }
  }
}

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
      /** See `implementation` in uid mode. */
      implementation?: "v1" | "neolink-v2";
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
  private sid: number | undefined;

  private sendPacketId = 0;
  private packetsWant = 0;
  private received = new Map<number, Buffer>();
  private sent = new Map<number, SendEntry>();

  private ackTimer: NodeJS.Timeout | undefined;
  private resendTimer: NodeJS.Timeout | undefined;
  private hbTimer: NodeJS.Timeout | undefined;
  private discoveryTid: number | undefined;
  private lastASentAtMs = 0;

  // Neolink/official client send UDP HB at 1s cadence.
  private readonly hbIntervalMs = 1000;

  private ackScheduled = false;
  private ackLatency = new AckLatency();

  // Neolink pattern: compute the ACK payload when state changes (on data receive),
  // but send the latest ACK on a tight interval. This keeps the send path cheap,
  // which is important in Node under heavy load.
  private lastAckPacket: Buffer = Buffer.alloc(0);
  private ackSentCount = 0;
  private lastAckSentAtMs = 0;
  private lastHbSentAtMs = 0;

  private lastAckDest: { host: string; port: number } | undefined;
  private lastHbDest: { host: string; port: number } | undefined;

  // Decouple UDP receive path (ACK timing) from consumer parsing.
  // Emitting data synchronously from the UDP socket callback can block the event loop
  // (especially with verbose logging / heavy frame parsing), which delays ACKs and can
  // cause the camera to abort the stream.
  private pendingData: Buffer[] = [];
  private pendingDataOffset = 0;
  private drainScheduled = false;

  constructor(options: BcUdpStreamOptions) {
    super();
    this.opts = options;
    this.mtu = options.mtu ?? BCUDP_DEFAULT_MTU;
  }

  async connect(): Promise<void> {
    if (this.sock) return;
    const sock = dgram.createSocket("udp4");
    this.sock = sock;
    
    try {
      sock.setRecvBufferSize(4 * 1024 * 1024);
      sock.setSendBufferSize(4 * 1024 * 1024);
    } catch (e) {
      // Ignore if not supported
    }

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
    // Neolink sends to both ports 2015 and 2018 (see discovery.rs:1119)
    const ports = this.opts.port ? [this.opts.port] : [BCUDP_DISCOVERY_PORT_LOCAL_ANY, BCUDP_DISCOVERY_PORT_LOCAL_UID];
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
    // Neolink uses "MAC" as OS for discovery (see discovery.rs:361)
    const xml = buildC2dC({ uid: this.opts.uid, clientPort: localPort, cid, mtu: this.mtu });

    const reply = await new Promise<{ cid: number; did: number; rhost: string; rport: number; sid?: number; tid?: number }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (retryTimer) clearInterval(retryTimer);
        sock.off("message", onMsg);
        reject(new Error(`BCUDP discovery timeout after ${discoveryTimeout}ms (camera may be sleeping or unreachable)`));
      }, discoveryTimeout);

      let retryTimer: NodeJS.Timeout | undefined;
      let retryCount = 0;
      let discoveredSid: number | undefined;
      let discoveredTid: number | undefined;
      let discovered: { cid: number; did: number; rhost: string; rport: number } | undefined;
      let sentT = false;
      let gotT = false;
      let sentA = false;
      let finalizeTimer: NodeJS.Timeout | undefined;

      const maybeFinalize = (reason: string) => {
        if (!discovered) return;
        // Once we have cid/did, we can proceed; SID helps stability but some cams omit it.
        // If we managed to complete T/A, great; otherwise continue with best-effort.
        if (finalizeTimer) return;
        // Small delay to allow an immediate CFM to arrive after A.
        finalizeTimer = setTimeout(() => {
          const d = discovered;
          const sid = discoveredSid;
          const tid = discoveredTid;
          if (!d) return;
          sock.off("message", onMsg);
          clearTimeout(timeout);
          if (retryTimer) clearInterval(retryTimer);
          this.emit("debug", "discovery_finalize", { reason, ...(sid != null ? { sid } : {}), ...d });
          resolve({ ...d, ...(sid != null ? { sid } : {}), ...(tid != null ? { tid } : {}) });
        }, 250);
      };

      const sendT = (rhost: string, rport: number) => {
        if (sentT) return;
        if (!discovered) return;
        try {
          const tid = (Math.floor(Math.random() * 255) | 0) >>> 0;
          const tXml = buildC2dT({ ...(discoveredSid != null ? { sid: discoveredSid } : {}), cid: discovered.cid, mtu: this.mtu, conn: "local" });
          const tPkt = encodeDiscoveryPacket(tid, tXml);
          sock.send(tPkt, rport, rhost);
          sentT = true;
          this.emit("debug", "discovery_t_send", { sid: discoveredSid, cid: discovered.cid, did: discovered.did, rhost, rport });
        } catch (e) {
          this.emit("debug", "discovery_t_send_error", e);
        }
      };

      const sendA = (tid: number, rhost: string, rport: number, dt: { sid: number; cid: number; did: number; conn?: string }) => {
        if (sentA) return;
        try {
          const aXml = buildC2dA({ sid: dt.sid, conn: dt.conn ?? "local", cid: dt.cid, did: dt.did, mtu: this.mtu });
          const aPkt = encodeDiscoveryPacket(tid, aXml);
          sock.send(aPkt, rport, rhost);
          sentA = true;
          this.emit("debug", "discovery_a_send", { sid: dt.sid, cid: dt.cid, did: dt.did, rhost, rport });
        } catch (e) {
          this.emit("debug", "discovery_a_send_error", e);
        }
      };

      const onMsg = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        try {
          const p = decodeBcUdpPacket(msg);
          if (p.kind !== "discovery") return;

          // Helpful for debugging odd camera behavior.
          this.emit("debug", "discovery_rx", { tid: p.tid, rhost: rinfo.address, rport: rinfo.port, xmlPreview: p.xml.slice(0, 120) });

          // Some models send a D2C_CFM before/around discovery completion.
          // Treat it as a strong signal that the session is established.
          const cfm = parseD2cCfm(p.xml);
          if (cfm) {
            discoveredSid = cfm.sid;
            if (!discovered && cfm.cid != null && cfm.did != null) {
              discovered = { cid: cfm.cid, did: cfm.did, rhost: rinfo.address, rport: rinfo.port };
            }
            // If we have enough to proceed, finalize (but still attempt T/A if possible).
            if (discovered) {
              sendT(rinfo.address, rinfo.port);
              maybeFinalize("cfm");
            }
          }

          // Camera->Client T step. Reply with C2D_A using the same tid.
          const dt = parseD2cT(p.xml);
          if (dt) {
            gotT = true;
            discoveredSid = dt.sid;
            if (!discovered) {
              discovered = { cid: dt.cid, did: dt.did, rhost: rinfo.address, rport: rinfo.port };
            }
            this.emit("debug", "discovery_t_rx", { sid: dt.sid, cid: dt.cid, did: dt.did, rhost: rinfo.address, rport: rinfo.port });
            sendA(p.tid, rinfo.address, rinfo.port, dt);
            // After receiving T and sending A, we should be good to proceed.
            maybeFinalize("t_a");
            return;
          }

          const parsed = parseD2cCr(p.xml);
          if (!parsed) return;
          if (parsed.rsp !== 0) return;

          // Some models provide suggested heartbeat timers in discovery response.
          // Neolink ignores these timers and uses a fixed 1s heartbeat.
          // Still emit them for diagnostics.
          const suggested = parsed.timer?.hb ?? parsed.timer?.hbt ?? parsed.timer?.def;
          if (suggested != null) {
            this.emit("debug", "hb_interval_suggested", { suggested, timer: parsed.timer });
          }
          // Success! Camera responded
          this.emit("debug", "discovery_success", { retryCount, rhost: rinfo.address, rport: rinfo.port, sid: parsed.sid ?? discoveredSid, timer: parsed.timer });

          discoveredTid = p.tid;
          discovered = { cid: parsed.cid, did: parsed.did, rhost: rinfo.address, rport: rinfo.port };
          if (parsed.sid != null) discoveredSid = parsed.sid;

          // Attempt T handshake if SID is available.
          sendT(rinfo.address, rinfo.port);

          // Don't resolve immediately: give the camera a chance to complete T/A/CFM.
          // If it doesn't, we'll finalize shortly anyway.
          if (gotT || sentA) {
            maybeFinalize("cr_t");
          } else {
            // If SID is missing, we might still proceed without T.
            // If SID is present, allow a brief window for D2C_T.
            if (discoveredSid != null) {
              if (finalizeTimer) clearTimeout(finalizeTimer);
              finalizeTimer = setTimeout(() => {
                maybeFinalize("cr_timeout");
              }, 1500);
            } else {
              maybeFinalize("cr_no_sid");
            }
          }
          return;
        } catch {
          // ignore
        }
      };
      sock.on("message", onMsg);

      // Send initial discovery packet to all ports (neolink behavior)
      const sendDiscovery = () => {
        const tid = (Math.floor(Math.random() * 255) | 0) >>> 0;
        const packet = encodeDiscoveryPacket(tid, xml);
        for (const port of ports) {
          try {
            sock.send(packet, port, host);
            retryCount++;
            this.emit("debug", "discovery_send", { retryCount, host, port });
          } catch (e) {
            this.emit("error", e instanceof Error ? e : new Error(String(e)));
          }
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
    this.sid = reply.sid;
    this.discoveryTid = reply.tid;
    // After discovery, assume the responder is the streaming peer.
    // Some cameras may later switch ports for data; we track that via remote_update on data/ack.
    this.remote = { host: reply.rhost, port: reply.rport };
  }

  private startTimers(): void {
    if (!this.sock || !this.remote || this.clientId == null || this.cameraId == null) {
      throw new Error("BCUDP not ready");
    }

    // Initialize ACK packet (empty)
    this.updateAckPacket();

    // Send initial heartbeat immediately (neolink behavior)
    this.sendHeartbeat();

    // ACK every 10ms (official client / neolink behavior)
    this.ackTimer = setIntervalNode(() => {
      try {
        this.sendAckFast();
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

    // heartbeat interval: default 1s, may be overridden by discovery timers.
    const hbMs = this.hbIntervalMs;
    this.hbTimer = setIntervalNode(() => {
      try {
        this.sendHeartbeat();
      } catch (e) {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
      }
    }, hbMs);
  }

  private sendHeartbeat(): void {
    if (!this.sock || !this.remote || this.clientId == null || this.cameraId == null) return;
    const peer = this.remote;
    // Neolink sends HB using the discovery thread tid (keep_alive_device(tid, ...)).
    // Some firmwares appear to be strict about this.
    const tid = (this.discoveryTid ?? ((Math.floor(Math.random() * 255) | 0) >>> 0)) >>> 0;

    let xml: string;
    // Neolink sends C2D_HB as soon as it has CID and DID, even if SID is not yet assigned (or is 0).
    // This keeps the session alive and seems to be what the camera expects after the initial handshake.
    xml = buildC2dHb({ cid: this.clientId, did: this.cameraId });

    const pkt = encodeDiscoveryPacket(tid, xml);

    this.emit("debug", "udp_hb_send", { tid, xml, host: peer.host, port: peer.port });

    // Neolink sends HB to the same peer address used by the UDP stream.
    this.sock.send(pkt, peer.port, peer.host);
    this.lastHbSentAtMs = performance.now();
    this.lastHbDest = { host: peer.host, port: peer.port };
    
  }

  private buildAckPayload(): { packetId: number; payload: Buffer } {
    // Some cameras will disconnect if the ACK truth-table grows to ~205 bytes.
    // Keep it comfortably below that.
    const MAX_ACK_PAYLOAD_BYTES = 64;

    // Match neolink/offical client behavior: until we've received and consumed at least
    // one packet (packetsWant>0), send the special "empty" ACK.
    // This uses group_id=0xffffffff + packet_id=0xffffffff + empty payload.
    // Avoid sending packet_id=0xffffffff with a non-empty truth-table.
    if (this.packetsWant === 0) {
      return { packetId: 0xffffffff, payload: Buffer.alloc(0) };
    }
    let firstMissing = this.packetsWant;
    while (this.received.has(firstMissing)) firstMissing++;

    let max = firstMissing - 1;
    // Avoid spread/Math.max over iterators (can be very costly when many packets are buffered).
    for (const k of this.received.keys()) {
      if (k > max) max = k;
    }

    // Cap the ACK bitmap window to avoid disconnects.
    const maxAllowed = firstMissing + MAX_ACK_PAYLOAD_BYTES - 1;
    if (max > maxAllowed) max = maxAllowed;

    if (max < firstMissing) {
      return { packetId: (firstMissing - 1) >>> 0, payload: Buffer.alloc(0) };
    }

    const len = max - firstMissing + 1;
    const bytes = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = this.received.has(firstMissing + i) ? 1 : 0;
    }
    return { packetId: (firstMissing - 1) >>> 0, payload: bytes };
  }

  private updateAckPacket(): void {
    if (this.cameraId == null) return;
    const { packetId, payload } = this.buildAckPayload();
    this.lastAckPacket = encodeAckPacket({
      connectionId: this.cameraId, // towards camera: did
      // In neolink: group_id=0xffffffff is only used for the special empty ACK.
      groupId: packetId === 0xffffffff && payload.length === 0 ? 0xffffffff : 0,
      packetId,
      maybeLatency: this.ackLatency.getValue(),
      payload,
    });
  }

  private sendAckFast(): void {
    if (!this.sock || !this.remote || this.lastAckPacket.length === 0) return;
    this.sock.send(this.lastAckPacket, this.remote.port, this.remote.host);
    this.ackSentCount++;
    this.lastAckSentAtMs = performance.now();
    this.lastAckDest = { host: this.remote.host, port: this.remote.port };
    if (this.ackSentCount % 100 === 0) {
      this.emit("debug", "ack_sent_100", { latency: this.ackLatency.getValue() });
    }
  }

  private maybeSendImmediateAck(reason: "data" | "manual"): void {
    // Critical for battery cams: ACK must be timely (camera resends after ~1000ms).
    // Timers can be delayed under load; send an immediate ACK from the receive path,
    // but throttle to avoid spamming.
    const now = performance.now();
    // Official client/neolink send ACK on a 10ms cadence; only do immediate ACK
    // when we suspect the event loop is lagging.
    const MIN_GAP_MS = 25;
    if (now - this.lastAckSentAtMs < MIN_GAP_MS) return;
    this.emit("debug", "ack_immediate", { reason });
    this.sendAckFast();
  }

  private scheduleAck(reason: "data" | "manual" = "data"): void {
    // With the cached ACK packet + 10ms timer, we avoid sending ACKs on every
    // inbound packet to prevent overwhelming the camera.
    if (reason === "manual") {
      if (this.ackScheduled) return;
      this.ackScheduled = true;
      setImmediate(() => {
        this.ackScheduled = false;
        try {
          this.sendAckFast();
        } catch (e) {
          this.emit("error", e instanceof Error ? e : new Error(String(e)));
        }
      });
      this.emit("debug", "ack_scheduled", { reason });
    }
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
        if (k <= packetId) {
          this.sent.delete(k);
        }
      }
      for (let i = 0; i < payload.length; i++) {
        const v = payload[i] ?? 0;
        if (v > 0) {
          const pid = (packetId + 1 + i) >>> 0;
          this.sent.delete(pid);
        }
      }
    }
    this.ackLatency.feed();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      try {
        for (; this.pendingDataOffset < this.pendingData.length; this.pendingDataOffset++) {
          this.emit("data", this.pendingData[this.pendingDataOffset]!);
        }
      } catch (e) {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
      } finally {
        // Reset buffer when fully drained.
        if (this.pendingDataOffset >= this.pendingData.length) {
          this.pendingData = [];
          this.pendingDataOffset = 0;
        }
      }
    });
  }

  private flushReceived(): void {
    // Move contiguous received payloads to a pending queue (fast) and drain later.
    while (this.received.has(this.packetsWant)) {
      const chunk = this.received.get(this.packetsWant)!;
      this.received.delete(this.packetsWant);
      this.packetsWant++;
      this.pendingData.push(chunk);
    }
    if (this.pendingData.length > this.pendingDataOffset) {
      this.scheduleDrain();
    }
  }

  private handlePacket(p: ReturnType<typeof decodeBcUdpPacket>, rhost: string, rport: number): void {
    // Bind/update remote to whoever talks to us.
    // Important for some battery cameras: discovery happens on one UDP port,
    // but the data/ack stream can come from another port. If we keep sending
    // ACK/heartbeat to the discovery port, the camera may stop streaming.
    const updateRemote = (reason: string) => {
      if (!this.remote || this.remote.host !== rhost || this.remote.port !== rport) {
        this.remote = { host: rhost, port: rport };
        this.emit("debug", "remote_update", { reason, host: rhost, port: rport });
      }
    };

    const discoveryMatchesSession = (xml: string): boolean => {
      // Discovery packets carry cid/did in XML (e.g. D2C_DISC, D2C_C_R, D2C_T).
      // Only treat them as authoritative for remote port updates if they match
      // the active session, to avoid following stray broadcast packets.
      if (this.clientId == null || this.cameraId == null) return false;
      return xml.includes(`<cid>${this.clientId}</cid>`) && xml.includes(`<did>${this.cameraId}</did>`);
    };


    if (!this.remote) updateRemote("first_packet");

    if (p.kind === "ack") {
      if (this.clientId != null && p.connectionId === this.clientId) {
        updateRemote("ack");
        this.handleAckFromCamera(p.packetId, p.payload);
      }
      return;
    }

    if (p.kind === "data") {
      if (this.clientId != null && p.connectionId === this.clientId) {
        updateRemote("data");
        // this.ackLatency.feed(); // Removed: latency is calculated from ACKs
        if (p.packetId >= this.packetsWant) {
          this.received.set(p.packetId, p.payload);
          this.flushReceived();
          this.updateAckPacket();
          // Send an immediate ACK from the receive path to avoid timer starvation.
          this.maybeSendImmediateAck("data");
          if (this.packetsWant % 100 === 0) {
            this.emit("debug", "udp_progress", { packetsWant: this.packetsWant });
          }
        }
      }
      return;
    }

    // discovery packets after connect (HB, disconnect, etc.) -> ignored for now.
    if (p.kind === "discovery") {
      if (discoveryMatchesSession(p.xml)) {
        updateRemote("discovery");
      }

      // Neolink behavior: some firmwares send D2C_T again after discovery/stream start.
      // Reply with C2D_A using the same tid to keep the session valid.
      const dt = parseD2cT(p.xml);
      if (dt && this.clientId != null && this.cameraId != null && dt.cid === this.clientId && dt.did === this.cameraId) {
        // Update SID if camera provides it.
        this.sid = dt.sid;

        // Throttle to avoid spamming if the camera repeats it.
        const now = performance.now();
        if (now - this.lastASentAtMs > 250) {
          this.lastASentAtMs = now;
          try {
            const aXml = buildC2dA({ sid: dt.sid, conn: dt.conn ?? "local", cid: dt.cid, did: dt.did, mtu: this.mtu });
            const aPkt = encodeDiscoveryPacket(p.tid, aXml);
            this.emit("debug", "discovery_a_send_connected", { sid: dt.sid, cid: dt.cid, did: dt.did, rhost, rport, tid: p.tid });
            this.sock?.send(aPkt, this.remote!.port, this.remote!.host);
          } catch (e) {
            this.emit("debug", "discovery_a_send_connected_error", e);
          }
        }
      }

      // If the camera sends CFM later, keep SID in sync.
      const cfm = parseD2cCfm(p.xml);
      if (cfm && cfm.sid != null) {
        this.sid = cfm.sid;
      }

      // Surface disconnect requests for diagnostics.
      const isDisc = /<D2C_DISC>|<C2D_DISC>/.test(p.xml);
      this.emit("debug", "discovery_rx_connected", { tid: p.tid, ...(isDisc ? { disconnect: true } : {}), xml: p.xml.slice(0, 200) });
      if (isDisc) {
        const now = performance.now();
        const stats = {
          packetsWant: this.packetsWant,
          receivedBuffered: this.received.size,
          sentBuffered: this.sent.size,
          pendingDataBuffered: Math.max(0, this.pendingData.length - this.pendingDataOffset),
          ackPacketBytes: this.lastAckPacket.length,
          lastAckAgeMs: this.lastAckSentAtMs ? Math.max(0, Math.round(now - this.lastAckSentAtMs)) : undefined,
          lastHbAgeMs: this.lastHbSentAtMs ? Math.max(0, Math.round(now - this.lastHbSentAtMs)) : undefined,
          remote: this.remote,
          lastAckDest: this.lastAckDest,
          lastHbDest: this.lastHbDest,
        };
        this.emit("debug", "disconnect_stats", stats);

        // Ensure sockets/timers are torn down promptly to avoid callers writing to a dead stream.
        void this.close();
        this.emit(
          "error",
          new Error(
            `BCUDP disconnect requested by camera (${rhost}:${rport}) stats=${JSON.stringify(stats)} xml=${JSON.stringify(p.xml.slice(0, 220))}`,
          ),
        );
      }
    }
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

