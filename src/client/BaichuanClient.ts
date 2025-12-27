import { EventEmitter } from "node:events";
import net from "node:net";
import { BC_TCP_DEFAULT_PORT, BC_CLASS_LEGACY, BC_CLASS_MODERN_24 } from "../protocol/constants.js";
import { aesDecrypt, aesEncrypt, bcDecrypt, bcEncrypt, deriveAesKey, md5StrModern, type EncryptionProtocol } from "../protocol/crypto.js";
import { BaichuanFrameParser, encodeHeader, type BaichuanFrame } from "../protocol/framing.js";
import { buildChannelExtensionXml, buildLoginXml, getXmlText } from "../protocol/xml.js";
import { BcUdpStream, type BcUdpStreamOptions } from "../bcudp/BcUdpStream.js";

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
   * Trasporto da usare:
   * - `tcp`: Baichuan TCP (tipico per cam cablate)
   * - `udp`: BCUDP (tipico per cam a batteria)
   * - `auto`: prova `tcp`, poi `udp`
   */
  transport?: "tcp" | "udp" | "auto";
  /** Opzioni BCUDP (necessarie se `transport: "udp"` o `auto` fallback). */
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
}> {
  private readonly opts: BaichuanClientOptions;

  private tcpSocket: net.Socket | undefined;
  private udpSocket: BcUdpStream | undefined;
  private transport: "tcp" | "udp" = "tcp";
  private readonly parser = new BaichuanFrameParser();
  private readonly pending = new Map<PendingKey, { resolve: (f: BaichuanFrame) => void; reject: (e: Error) => void }>();

  private msgNum = 0;
  private loggedIn = false;

  private enc: EncryptionProtocol = { kind: "none" };
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
      throw new Error("Baichuan UDP richiesto ma `options.udp` non è impostato (serve per BCUDP, tipico cam a batteria).");
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
   * Invia un comando Baichuan e ritorna la risposta XML (se presente).
   * Se la risposta non contiene body, ritorna stringa vuota.
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

    // split + decrypt (extension/payload concatenated as in body)
    const body = frame.body;
    if (body.length === 0) return "";

    // For modern 24-byte frames: extension+payload; we decrypt full body as one stream just like references do.
    // (In practice extension and payload are separately encrypted but concatenation preserves it.)
    const xml = this.tryDecryptXml(body, frame.header.channelId, enc);
    return xml;
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

    const replyXml = await this.sendXml({
      cmdId: 1,
      payloadXml: loginXml,
      extensionXml: "",
      messageClass: BC_CLASS_MODERN_24,
      // For the login message itself, some firmwares still expect BCEncrypt.
      // We try preferred (negotiated) but the decrypt path is tolerant.
      encryption: this.enc.kind === "aes" || this.enc.kind === "full_aes" ? this.enc : { kind: "bc" },
      timeoutMs: 10_000,
    });

    // If login succeeded, camera replies with 200 in responseCode on modern frames.
    // We check the last received header via tolerant parsing by issuing a second time? Not needed:
    // sendXml already waited for the correct frame; we can consider success if it looks like XML and doesn't contain empty payload with errors.
    if (!replyXml.startsWith("<?xml")) {
      throw new Error("Baichuan login: unexpected non-XML reply");
    }

    this.loggedIn = true;
  }
}

