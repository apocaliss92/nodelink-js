import { EventEmitter } from "node:events";
import net from "node:net";
import { BC_TCP_DEFAULT_PORT, BC_CLASS_LEGACY, BC_CLASS_MODERN_24 } from "../protocol/constants.js";
import { aesDecrypt, aesEncrypt, bcDecrypt, bcEncrypt, deriveAesKey, md5StrModern, type EncryptionProtocol } from "../protocol/crypto.js";
import { BaichuanFrameParser, encodeHeader, type BaichuanFrame } from "../protocol/framing.js";
import { buildChannelExtensionXml, buildLoginXml, getXmlText } from "../protocol/xml.js";
import { BcUdpStream, type BcUdpStreamOptions } from "../bcudp/BcUdpStream.js";
import type { ReolinkEvent } from "../reolink/baichuan/types.js";

export type BaichuanClientOptions = {
  host: string;
  port?: number;
  username: string;
  password: string;
  /**
   * For NVR: logical channel index (0-based).
   * For standalone cameras: usually 0.
   */
  channel?: number;
  /** If true, emits additional debug events. */
  debug?: boolean;
  /**
   * Transport to use:
   * - `tcp`: Baichuan TCP (typical for wired cameras)
   * - `udp`: BCUDP (typical for battery cameras)
   * - `auto`: try `tcp`, then fallback to `udp`
   */
  transport?: "tcp" | "udp" | "auto";
  /** BCUDP options (required for `transport: "udp"` or `auto` fallback). */
  udp?: BcUdpStreamOptions;
};

export type MaxEncryption = "none" | "bc" | "aes" | "full_aes";

type PendingKey = `${number}:${number}`; // cmdId:messageKey

export class BaichuanClient extends EventEmitter<{
  frame: [BaichuanFrame];
  push: [BaichuanFrame];
  close: [];
  error: [Error];
  debug: [string, unknown?];
  event: [ReolinkEvent]; // Parsed events (motion/AI)
}> {
  private readonly opts: BaichuanClientOptions;

  private tcpSocket: net.Socket | undefined;
  private udpSocket: BcUdpStream | undefined;
  private transport: "tcp" | "udp" = "tcp";
  private readonly parser = new BaichuanFrameParser();
  private readonly pending = new Map<PendingKey, { resolve: (f: BaichuanFrame) => void; reject: (e: Error) => void }>();

  private msgNum = 0;
  private loggedIn = false;
  subscribed = false; // Public to allow ReolinkBaichuanApi to check subscription status

  enc: EncryptionProtocol = { kind: "none" }; // Public to allow ReolinkBaichuanApi to access for audio decryption
  private nonce?: string;

  constructor(options: BaichuanClientOptions) {
    super();
    this.opts = options;
  }

  async connect(): Promise<void> {
    const desired = this.opts.transport ?? "tcp";
    if (desired === "tcp") {
      await this.connectTcp();
      return;
    }
    if (desired === "udp") {
      await this.connectUdp();
      return;
    }
    // auto
    try {
      await this.connectTcp();
    } catch (e) {
      this.emit("debug", "auto:tcp_failed", e);
      await this.connectUdp();
    }
  }

  private async connectTcp(): Promise<void> {
    if (this.tcpSocket && !this.tcpSocket.destroyed) {
      this.transport = "tcp";
      return;
    }
    const port = this.opts.port ?? BC_TCP_DEFAULT_PORT;
    const sock = net.createConnection({ host: this.opts.host, port });
    this.tcpSocket = sock;
    this.transport = "tcp";

    sock.on("data", (chunk) => {
      const frames = this.parser.push(chunk);
      for (const f of frames) this.handleFrame(f);
    });
    sock.on("close", () => {
      this.emit("close");
      for (const [, p] of this.pending) p.reject(new Error("Baichuan socket closed"));
      this.pending.clear();
    });
    sock.on("error", (err) => this.emit("error", err));

    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", (e) => reject(e));
    });
  }

  private async connectUdp(): Promise<void> {
    if (this.udpSocket) {
      this.transport = "udp";
      return;
    }
    const udpOpts = this.opts.udp;
    if (!udpOpts) {
      throw new Error("Baichuan UDP requested but `options.udp` is not set (required for BCUDP, typical for battery cameras).");
    }
    const sock = new BcUdpStream(udpOpts);
    this.udpSocket = sock;
    this.transport = "udp";

    sock.on("data", (chunk) => {
      const frames = this.parser.push(chunk);
      for (const f of frames) this.handleFrame(f);
    });
    sock.on("close", () => {
      this.emit("close");
      for (const [, p] of this.pending) p.reject(new Error("Baichuan UDP stream closed"));
      this.pending.clear();
    });
    sock.on("error", (err) => this.emit("error", err));

    await sock.connect();
  }

  async close(): Promise<void> {
    const tcp = this.tcpSocket;
    this.tcpSocket = undefined;
    if (tcp) {
      await new Promise<void>((resolve) => {
        tcp.once("close", () => resolve());
        tcp.destroy();
      });
    }
    const udp = this.udpSocket;
    this.udpSocket = undefined;
    if (udp) await udp.close();
  }

  private handleFrame(frame: BaichuanFrame): void {
    this.emit("frame", frame);

    const key: PendingKey = `${frame.header.cmdId}:${frame.messageKey}`;
    const pending = this.pending.get(key);
    if (pending) {
      this.pending.delete(key);
      pending.resolve(frame);
      return;
    }

    // unrequested -> push/stream
    this.emit("push", frame);

    // Parse events (cmd_id 33 = Motion/AI/Visitor events)
    if (frame.header.cmdId === 33) {
      try {
        const event = this.parseEvent(frame);
        if (event) {
          this.emit("event", event);
        }
      } catch (error) {
        if (this.opts.debug) {
          this.emit("debug", "event_parse_error", error);
        }
      }
    }
  }

  /**
   * Parses event frame (cmd_id 33) into ReolinkEvent.
   * Based on reolink-aio _parse_xml handling of cmd_id 33.
   */
  private parseEvent(frame: BaichuanFrame): ReolinkEvent | null {
    const body = frame.body;
    if (body.length === 0) return null;

    const xml = this.tryDecryptXml(body, frame.header.channelId, this.enc);
    if (!xml || !xml.startsWith("<?xml")) return null;

    // Extract channel from frame (channelId 250 = host, 1+ = channels)
    const channelId = frame.header.channelId;
    const channel = channelId === 250 ? 0 : channelId - 1;

    // Parse XML for event tags (motion, AI, visitor, etc.)
    // Based on reolink-aio: <Event><status>MD</status><AItype>people</AItype>...</Event>
    const eventMatch = xml.match(/<Event[^>]*>([\s\S]*?)<\/Event>/);
    if (!eventMatch) return null;

    const eventXml = eventMatch[1] ?? "";
    const status = getXmlText(eventXml, "status") ?? "";
    const aiType = getXmlText(eventXml, "AItype") ?? "";

    // Motion detection
    if (status && status.includes("MD")) {
      return {
        channel,
        type: "motion",
        motion: {
          channel,
          state: true,
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      };
    }

    // AI detection
    if (aiType) {
      const aiTypeMap: Record<string, "people" | "vehicle" | "dog_cat" | "face" | "package" | "other"> = {
        people: "people",
        vehicle: "vehicle",
        dog_cat: "dog_cat",
        face: "face",
        package: "package",
      };

      return {
        channel,
        type: "ai",
        ai: {
          channel,
          type: aiTypeMap[aiType.toLowerCase()] ?? "other",
          detected: true,
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      };
    }

    return null;
  }

  private nextMsgNum(): number {
    this.msgNum = (this.msgNum + 1) & 0xffff;
    return this.msgNum;
  }

  private requireSocket(): net.Socket {
    if (this.transport !== "tcp") throw new Error("Internal: requireSocket called while not using TCP");
    if (!this.tcpSocket || this.tcpSocket.destroyed) throw new Error("Baichuan TCP socket is not connected");
    return this.tcpSocket;
  }

  private writeWire(wire: Buffer): void {
    if (this.transport === "tcp") {
      this.requireSocket().write(wire);
      return;
    }
    if (!this.udpSocket) throw new Error("Baichuan UDP stream is not connected");
    this.udpSocket.write(wire);
  }

  private encodeBodyXml(extXml: string, payloadXml: string, channelId: number, enc: EncryptionProtocol): Buffer {
    const extBuf = Buffer.from(extXml, "utf8");
    const payloadBuf = Buffer.from(payloadXml, "utf8");

    if (enc.kind === "none") return Buffer.concat([extBuf, payloadBuf]);
    if (enc.kind === "bc") return Buffer.concat([bcEncrypt(extBuf, channelId), bcEncrypt(payloadBuf, channelId)]);
    if (enc.kind === "aes" || enc.kind === "full_aes") return Buffer.concat([aesEncrypt(extBuf, enc.key), aesEncrypt(payloadBuf, enc.key)]);
    // exhaustive
    return Buffer.concat([extBuf, payloadBuf]);
  }

  private tryDecryptXml(buf: Buffer, channelId: number, preferred: EncryptionProtocol): string {
    const tryDecode = (b: Buffer) => b.toString("utf8");

    const tryAs = (enc: EncryptionProtocol): string | undefined => {
      let dec: Buffer;
      try {
        if (enc.kind === "none") dec = buf;
        else if (enc.kind === "bc") dec = bcDecrypt(buf, channelId);
        else dec = aesDecrypt(buf, enc.key);
      } catch {
        return undefined;
      }
      const s = tryDecode(dec);
      return s.startsWith("<?xml") ? s : undefined;
    };

    return (
      tryAs(preferred) ??
      (preferred.kind !== "bc" ? tryAs({ kind: "bc" }) : undefined) ??
      tryAs({ kind: "none" }) ??
      tryDecode(buf)
    );
  }

  /**
   * Sends a Baichuan command and returns the XML reply (if any).
   * If the reply has no body, returns an empty string.
   */
  async sendXml(params: {
    cmdId: number;
    channel?: number;
    payloadXml?: string;
    extensionXml?: string;
    /** Classe header: di default moderna 24 byte (0x6414). */
    messageClass?: number;
    /** Forza cifratura specifica per questo invio. */
    encryption?: EncryptionProtocol;
    /** Timeout ms. */
    timeoutMs?: number;
  }): Promise<string> {
    await this.connect();

    const channel = params.channel ?? this.opts.channel ?? 0;
    const channelId = params.channel == null ? 250 : channel + 1; // segue reolink_aio: 250 host, 1..= canali

    const msgNum = this.nextMsgNum();
    const cmdId = params.cmdId;

    const extXml = params.extensionXml ?? (params.channel != null ? buildChannelExtensionXml(channel) : "");
    const payloadXml = params.payloadXml ?? "";

    const messageClass = params.messageClass ?? BC_CLASS_MODERN_24;
    const payloadOffset = Buffer.byteLength(extXml, "utf8");
    const bodyLen = payloadOffset + Buffer.byteLength(payloadXml, "utf8");

    const header = encodeHeader({
      cmdId,
      bodyLen,
      channelId,
      streamType: 0,
      msgNum,
      responseCode: 0,
      messageClass,
      payloadOffset,
    });
    const messageKey = header.readUInt32LE(12);
    const pendingKey: PendingKey = `${cmdId}:${messageKey}`;

    const enc = params.encryption ?? this.enc;
    const bodyBytes = this.encodeBodyXml(extXml, payloadXml, channelId, enc);
    const wire = Buffer.concat([header, bodyBytes]);

    const timeoutMs = params.timeoutMs ?? 10_000;
    const framePromise = new Promise<BaichuanFrame>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(pendingKey);
        reject(new Error(`Baichuan timeout cmdId=${cmdId} msgNum=${msgNum}`));
      }, timeoutMs);
      this.pending.set(pendingKey, {
        resolve: (f) => {
          clearTimeout(t);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });

    if (this.opts.debug) this.emit("debug", "tx", { cmdId, msgNum, channelId, messageClass, bodyLen });
    this.writeWire(wire);

    const frame = await framePromise;
    if (this.opts.debug) this.emit("debug", "rx", { cmdId: frame.header.cmdId, responseCode: frame.header.responseCode, msgNum: frame.header.msgNum });

    // Check responseCode for errors (400 = bad request/auth failure, 200 = success)
    // Some cameras return 400 with empty body when authentication fails
    if (frame.header.responseCode === 400) {
      // Try to decrypt anyway in case there's an error message, but don't fail if body is empty
      const body = frame.body;
      if (body.length === 0) {
        // Empty body with 400 typically means authentication failure
        throw new Error("Baichuan authentication failed (responseCode 400, empty body) - check username/password");
      }
      // If body is not empty, try to decrypt and return it (might contain error details)
    }

    // split + decrypt (extension/payload concatenated as in body)
    const body = frame.body;
    if (body.length === 0) return "";

    // For modern 24-byte frames: extension+payload; we decrypt full body as one stream just like references do.
    // (In practice extension and payload are separately encrypted but concatenation preserves it.)
    const xml = this.tryDecryptXml(body, frame.header.channelId, enc);
    return xml;
  }

  /**
   * Sends a Baichuan command and returns the binary reply (for commands like Snap that return binary data).
   * Similar to sendXml but returns raw Buffer instead of XML string.
   */
  async sendBinary(params: {
    cmdId: number;
    channel?: number;
    payloadXml?: string;
    extensionXml?: string;
    messageClass?: number;
    encryption?: EncryptionProtocol;
    timeoutMs?: number;
  }): Promise<Buffer> {
    await this.connect();

    const channel = params.channel ?? this.opts.channel ?? 0;
    const channelId = params.channel == null ? 250 : channel + 1;

    const msgNum = this.nextMsgNum();
    const cmdId = params.cmdId;

    const extXml = params.extensionXml ?? (params.channel != null ? buildChannelExtensionXml(channel) : "");
    const payloadXml = params.payloadXml ?? "";

    const messageClass = params.messageClass ?? BC_CLASS_MODERN_24;
    const payloadOffset = Buffer.byteLength(extXml, "utf8");
    const bodyLen = payloadOffset + Buffer.byteLength(payloadXml, "utf8");

    const header = encodeHeader({
      cmdId,
      bodyLen,
      channelId,
      streamType: 0,
      msgNum,
      responseCode: 0,
      messageClass,
      payloadOffset,
    });
    const messageKey = header.readUInt32LE(12);
    const pendingKey: PendingKey = `${cmdId}:${messageKey}`;

    const enc = params.encryption ?? this.enc;
    const bodyBytes = this.encodeBodyXml(extXml, payloadXml, channelId, enc);
    const wire = Buffer.concat([header, bodyBytes]);

    const timeoutMs = params.timeoutMs ?? 10_000;
    const framePromise = new Promise<BaichuanFrame>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(pendingKey);
        reject(new Error(`Baichuan timeout cmdId=${cmdId} msgNum=${msgNum}`));
      }, timeoutMs);
      this.pending.set(pendingKey, {
        resolve: (f) => {
          clearTimeout(t);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });

    if (this.opts.debug) this.emit("debug", "tx", { cmdId, msgNum, channelId, messageClass, bodyLen, binary: true });
    this.writeWire(wire);

    const frame = await framePromise;
    if (this.opts.debug) this.emit("debug", "rx", { cmdId: frame.header.cmdId, responseCode: frame.header.responseCode, msgNum: frame.header.msgNum, binary: true });

    if (frame.header.responseCode === 400) {
      const body = frame.body;
      if (body.length === 0) {
        throw new Error("Baichuan binary request failed (responseCode 400, empty body)");
      }
    }

    // For binary responses, return raw decrypted body
    const body = frame.body;
    if (body.length === 0) return Buffer.alloc(0);

    // Decrypt the body (binary data like JPEG)
    const decrypted = this.tryDecryptBinary(body, frame.header.channelId, enc);
    return decrypted;
  }

  /**
   * Decrypts binary data (similar to tryDecryptXml but for binary responses).
   * Public method to allow ReolinkBaichuanApi to decrypt audio frames.
   */
  tryDecryptBinary(buf: Buffer, channelId: number, preferred: EncryptionProtocol): Buffer {
    if (buf.length === 0) return buf;

    const tryAs = (enc: EncryptionProtocol): Buffer | null => {
      try {
        if (enc.kind === "none") return buf;
        if (enc.kind === "bc") {
          return bcDecrypt(buf, channelId);
        }
        if (enc.kind === "aes" || enc.kind === "full_aes") {
          return aesDecrypt(buf, enc.key);
        }
        return null;
      } catch {
        return null;
      }
    };

    // Try preferred encryption first, then fallback to current encryption, then BC, then none
    return (
      tryAs(preferred) ??
      (preferred.kind !== "bc" && this.enc.kind !== "none" && (this.enc.kind === "aes" || this.enc.kind === "full_aes") ? tryAs(this.enc) : null) ??
      (preferred.kind !== "bc" ? tryAs({ kind: "bc" }) : null) ??
      tryAs({ kind: "none" }) ??
      buf // Return as-is if decryption fails
    );
  }

  /**
   * Login flow: legacy "upgrade" -> receive nonce/encryption -> modern login.
   * Ispirato a `neolink` (Rust) e `reolink_aio` (Python).
   */
  async login(maxEncryption: MaxEncryption = "full_aes"): Promise<void> {
    if (this.loggedIn) return;

    // 1) legacy header-only login upgrade to obtain nonce + encryption type
    const encByte =
      maxEncryption === "none" ? 0xdc00 : maxEncryption === "bc" ? 0xdc01 : maxEncryption === "aes" ? 0xdc02 : 0xdc12;

    await this.connect();
    // legacy login is supported on both transports

    const msgNum = this.nextMsgNum();
    const cmdId = 1;
    const channelId = 250; // host

    const header = encodeHeader({
      cmdId,
      bodyLen: 0,
      channelId,
      streamType: 0,
      msgNum,
      responseCode: encByte,
      messageClass: BC_CLASS_LEGACY,
    });
    const messageKey = header.readUInt32LE(12);
    const pendingKey: PendingKey = `${cmdId}:${messageKey}`;

    const framePromise = new Promise<BaichuanFrame>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(pendingKey);
        reject(new Error("Baichuan timeout waiting for nonce"));
      }, 10_000);
      this.pending.set(pendingKey, {
        resolve: (f) => {
          clearTimeout(t);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });

    this.writeWire(header); // header-only
    const nonceFrame = await framePromise;

    // This reply contains <Encryption><nonce>...</nonce></Encryption> and response_code 0xDD??
    const resp = nonceFrame.header.responseCode;
    if ((resp >>> 8) !== 0xdd) throw new Error(`Baichuan login: expected encryption info (0xDDxx), got 0x${resp.toString(16)}`);
    const encType = resp & 0xff;

    // During negotiation the payload is at most BCEncrypt (even if AES is supported).
    const nonceXml = this.tryDecryptXml(nonceFrame.body, nonceFrame.header.channelId, encType === 0x00 ? { kind: "none" } : { kind: "bc" });
    const nonce = getXmlText(nonceXml, "nonce");
    if (!nonce) throw new Error("Baichuan login: nonce not found in XML");
    this.nonce = nonce;

    // set encryption mode for post-login traffic
    if (encType === 0x00) this.enc = { kind: "none" };
    else if (encType === 0x01) this.enc = { kind: "bc" };
    else if (encType === 0x02) this.enc = { kind: "aes", key: deriveAesKey(nonce, this.opts.password) };
    else if (encType === 0x12) this.enc = { kind: "full_aes", key: deriveAesKey(nonce, this.opts.password) };
    else throw new Error(`Baichuan login: unknown encType=0x${encType.toString(16)}`);

    // 2) modern login with username/password hashes
    const userHash = md5StrModern(`${this.opts.username}${nonce}`);
    const passHash = md5StrModern(`${this.opts.password}${nonce}`);
    const loginXml = buildLoginXml(userHash, passHash);
    
    if (this.opts.debug) {
      this.emit("debug", "login_hash", { 
        username: this.opts.username,
        nonce,
        userHash,
        passHashLength: passHash.length,
        loginXmlLength: loginXml.length,
        loginXmlPreview: loginXml.substring(0, 200)
      });
    }

    const replyXml = await this.sendXml({
      cmdId: 1,
      payloadXml: loginXml,
      extensionXml: "",
      messageClass: BC_CLASS_MODERN_24,
      // For the login message itself, many firmwares expect BCEncrypt regardless of negotiated encryption.
      // This matches neolink/reolink-aio behavior: always use BCEncrypt for login.
      encryption: { kind: "bc" },
      timeoutMs: 10_000,
    });

    // If login succeeded, camera replies with 200 in responseCode on modern frames.
    // responseCode 400 typically means authentication failed (bad credentials)
    // responseCode 200 means success
    if (this.opts.debug) {
      this.emit("debug", "login_reply", { 
        replyLength: replyXml.length, 
        replyPreview: replyXml.substring(0, 200),
        startsWithXml: replyXml.startsWith("<?xml")
      });
    }
    
    // Check if reply is empty - this often indicates authentication failure
    // (responseCode 400 was seen in debug output, which typically means auth failure)
    if (replyXml.length === 0) {
      throw new Error("Baichuan login failed: empty reply (likely authentication failure - check username/password. Response code 400 indicates bad credentials)");
    }
    
    if (!replyXml.startsWith("<?xml")) {
      const preview = replyXml.length > 0 ? replyXml.substring(0, 100) : "(empty)";
      throw new Error(`Baichuan login: unexpected non-XML reply (length: ${replyXml.length}, preview: ${preview})`);
    }

    this.loggedIn = true;
  }
}

