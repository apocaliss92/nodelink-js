import net from "node:net";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { Udp7777Listener } from "./Udp7777Listener";

const MAGIC_6666 = Buffer.from([0x0c, 0x00, 0x01, 0x00]); // u32le 0x0001000c

export type HubEmulatorRec = { type: number; len: number; payload: Buffer };

export type HubEmulatorTranscriptEntry = {
  dirKey: string;
  reassembledBytes: number;
  gaps: number;
  prefixHex: string;
  prefixU32le0?: number;
  prefixU16le0?: number;
  prefixU16le2?: number;
  prefixTokens: string[];
  prefixTokenHint?: { macHex?: string; uid?: string };
  records: Array<{ tsMs: number; relMs: number; streamOff: number; type: number; len: number; payloadB64: string }>;
};

export type HubEmulatorTranscriptFile = {
  generatedAt: string;
  pcapPath: string;
  hubIp: string;
  entries: HubEmulatorTranscriptEntry[];
  udp7777Samples: Array<{ tsMs: number; dirKey: string; payloadLen: number; parsed: unknown; payloadB64: string }>;
};

export type HubEmulatorOptions = {
  bindHost?: string;
  tcpPort?: number;
  enableUdp7777?: boolean;

  expectedHubMacHex?: string;

  transcript?: HubEmulatorTranscriptFile;
  transcriptPath?: string;

  replayVerbose?: boolean;
  replayMutatePrefixToken?: boolean;
  replaySendFirst?: boolean;
  replaySendFirstRelMsMax?: number;

  capturePath?: string;
  exitAfterMs?: number;
  idleExitMs?: number;

  findAsciiNeedle?: string;
};

export type HubEmulatorEvents = {
  listening: { bindHost: string; tcpPort: number; udp7777: boolean };
  shutdown: { reason: string };
  udp7777: { from: string; len: number; uid?: string; seq?: number; dataLen?: number };
  tcp6666_connect: { remote: string };
  tcp6666_close: { remote: string };
  tcp6666_error: { remote: string; error: string };
  tcp6666_prefix: { remote: string; prefixLen: number; prefixHeadHex: string; prefixTokens: string[]; prefixHint?: { macHex?: string; uid?: string } };
  tcp6666_rec: { remote: string; type: number; len: number; payloadHeadHex: string };
  tcp6666_replay_prefix: { remote: string; len: number };
  tcp6666_replay_tx: { remote: string; type: number; len: number; idx: number };
};

function encode6666Record(type: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(12 + payload.length);
  out.writeUInt32LE(0x0001000c, 0);
  out.writeUInt32LE(payload.length, 4);
  out.writeUInt32LE(type >>> 0, 8);
  payload.copy(out, 12);
  return out;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, obj: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function randomBase62(len: number): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length]!;
  return out;
}

function scanAsciiTokens(buf: Buffer, minLen = 6, limit = 20): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.length >= minLen) out.push(cur);
    cur = "";
  };
  for (const b of buf) {
    const isAlnum = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
    if (isAlnum) {
      cur += String.fromCharCode(b);
      if (cur.length > 96) push();
    } else {
      push();
      if (out.length >= limit) break;
    }
  }
  push();
  return out.slice(0, limit);
}

function tryParseMacUidToken(token: string): { macHex?: string; uid?: string } {
  if (!/^[0-9A-F]{12}/.test(token)) return {};
  const macHex = token.slice(0, 12);
  const uid = token.slice(12, 28);
  if (/^[0-9A-Za-z]{16}$/.test(uid)) return { macHex, uid };
  return { macHex };
}

function findAsciiTokenOffsets(buf: Buffer, minLen = 6): Array<{ token: string; start: number; end: number }> {
  const out: Array<{ token: string; start: number; end: number }> = [];
  let cur = "";
  let curStart = 0;
  const push = (end: number) => {
    if (cur.length >= minLen) out.push({ token: cur, start: curStart, end });
    cur = "";
    curStart = end + 1;
  };
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    const isAlnum = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
    if (isAlnum) {
      if (cur.length === 0) curStart = i;
      cur += String.fromCharCode(b);
    } else {
      push(i);
    }
  }
  push(buf.length);
  return out;
}

function parseDirKey(dirKey: string): { srcIp: string; srcPort: number; dstIp: string; dstPort: number } | undefined {
  const m = dirKey.match(/^([^:]+):(\d+)\s*->\s*([^:]+):(\d+)$/);
  if (!m) return undefined;
  return {
    srcIp: m[1]!,
    srcPort: Number.parseInt(m[2]!, 10),
    dstIp: m[3]!,
    dstPort: Number.parseInt(m[4]!, 10),
  };
}

class Tcp6666StreamParser {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  private prefix: Buffer<ArrayBufferLike> = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  public prefixDone = false;

  push(chunk: Buffer<ArrayBufferLike>): HubEmulatorRec[] {
    this.buf = (this.buf.length === 0
      ? chunk
      : (Buffer.concat([this.buf, chunk]) as Buffer<ArrayBufferLike>)) as Buffer<ArrayBufferLike>;

    const out: HubEmulatorRec[] = [];

    while (this.buf.length >= 12) {
      const idx = this.buf.indexOf(MAGIC_6666);
      if (idx < 0) {
        const keep = Math.min(3, this.buf.length);
        const drop = this.buf.length - keep;
        if (drop > 0 && !this.prefixDone) this.prefix = Buffer.concat([this.prefix, this.buf.subarray(0, drop)]) as Buffer<ArrayBufferLike>;
        this.buf = this.buf.subarray(drop) as Buffer<ArrayBufferLike>;
        break;
      }

      if (idx > 0) {
        if (!this.prefixDone) this.prefix = Buffer.concat([this.prefix, this.buf.subarray(0, idx)]) as Buffer<ArrayBufferLike>;
        this.buf = this.buf.subarray(idx) as Buffer<ArrayBufferLike>;
        if (this.buf.length < 12) break;
      }

      this.prefixDone = true;
      const len = this.buf.readUInt32LE(4);
      const type = this.buf.readUInt32LE(8);
      const total = 12 + len;
      if (this.buf.length < total) break;
      const payload = this.buf.subarray(12, total);
      out.push({ type, len, payload });
      this.buf = this.buf.subarray(total) as Buffer<ArrayBufferLike>;
    }

    return out;
  }

  getPrefix(): Buffer {
    return this.prefix;
  }
}

function canonMacHex(mac: string | undefined): string | undefined {
  if (!mac) return undefined;
  const hex = mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 12) return undefined;
  return hex;
}

export class HubEmulator extends EventEmitter {
  private opts: {
    bindHost: string;
    tcpPort: number;
    enableUdp7777: boolean;
    replayVerbose: boolean;
    replayMutatePrefixToken: boolean;
    replaySendFirst: boolean;
    replaySendFirstRelMsMax: number;
    capturePath: string | undefined;
    exitAfterMs: number;
    idleExitMs: number;
    transcript: HubEmulatorTranscriptFile | undefined;
    transcriptPath: string | undefined;
    expectedHubMacHex: string | undefined;
    findAsciiNeedle: string | undefined;
  };

  private udp: Udp7777Listener | undefined;
  private server: net.Server | undefined;
  private shuttingDown = false;
  private capture: any[] = [];
  private idleTimer?: NodeJS.Timeout;
  private exitTimer?: NodeJS.Timeout;

  constructor(options: HubEmulatorOptions = {}) {
    super();

    this.opts = {
      bindHost: options.bindHost ?? "0.0.0.0",
      tcpPort: options.tcpPort ?? 6666,
      enableUdp7777: options.enableUdp7777 ?? true,
      replayVerbose: options.replayVerbose ?? true,
      replayMutatePrefixToken: options.replayMutatePrefixToken ?? true,
      replaySendFirst: options.replaySendFirst ?? false,
      replaySendFirstRelMsMax: options.replaySendFirstRelMsMax ?? 0,
      capturePath: options.capturePath,
      exitAfterMs: options.exitAfterMs ?? 0,
      idleExitMs: options.idleExitMs ?? 0,
      transcript: options.transcript,
      transcriptPath: options.transcriptPath,
      expectedHubMacHex: canonMacHex(options.expectedHubMacHex),
      findAsciiNeedle: (options.findAsciiNeedle ?? "").trim() || undefined,
    };
  }

  private cap(evt: any) {
    if (!this.opts.capturePath) return;
    this.capture.push({ tsMs: Date.now(), ...evt });
  }

  private bumpActivity(kind: string, extra?: any) {
    this.cap({ kind, ...(extra ?? {}) });
    if (this.opts.idleExitMs > 0) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => void this.shutdown(`idle>${this.opts.idleExitMs}ms`), this.opts.idleExitMs);
    }
  }

  async start(): Promise<void> {
    if (this.server) throw new Error("HubEmulator already started");

    let transcript = this.opts.transcript;
    if (!transcript && this.opts.transcriptPath) {
      const raw = fs.readFileSync(this.opts.transcriptPath, "utf8");
      transcript = JSON.parse(raw) as HubEmulatorTranscriptFile;
    }

    if (this.opts.enableUdp7777) {
      this.udp = new Udp7777Listener({ host: this.opts.bindHost });
      this.udp.on("packet", (p) => {
        this.bumpActivity("udp7777", {
          from: `${p.rinfo.address}:${p.rinfo.port}`,
          len: p.payload.length,
          uid: p.uid,
          seq: p.seq,
          dataLen: p.dataLen,
        });
        this.emit("udp7777", { from: `${p.rinfo.address}:${p.rinfo.port}`, len: p.payload.length, uid: p.uid, seq: p.seq, dataLen: p.dataLen });
      });
      this.udp.start();
    }

    this.server = net.createServer((socket) => {
      const remote = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? "?"}`;
      this.bumpActivity("tcp6666_connect", { remote });
      this.emit("tcp6666_connect", { remote });

      const parser = new Tcp6666StreamParser();
      let prefixLogged = false;

      // Replay state per connection
      let sentReplayPrefix = false;
      let outCursor = 0;
      let outFlow: HubEmulatorTranscriptEntry | undefined;

      const pickFlowsByRemoteIp = () => {
        if (!transcript) return;
        const remoteIp = socket.remoteAddress;
        if (!remoteIp) return;

        const entries = transcript.entries;
        const outCandidates = entries.filter((e) => {
          const d = parseDirKey(e.dirKey);
          return Boolean(d && d.srcPort === 6666 && d.dstIp === remoteIp);
        });

        outFlow = outCandidates.find((e) => e.records.length > 0) ?? outCandidates[0];

        if (this.opts.replayVerbose) {
          // eslint-disable-next-line no-console
          console.log(`[hub-emu][replay] ${remote} flowPickByIp remoteIp=${remoteIp} out=${outFlow ? outFlow.dirKey : "-"}`);
        }
      };

      const sendReplayPrefixIfNeeded = () => {
        if (!outFlow || sentReplayPrefix) return;
        const prefix = Buffer.from(outFlow.prefixHex, "hex");
        if (this.opts.replayMutatePrefixToken) {
          const toks = findAsciiTokenOffsets(prefix, 6);
          if (toks.length >= 2) {
            const t1 = toks[1]!;
            const newTok = randomBase62(t1.token.length);
            prefix.write(newTok, t1.start, t1.token.length, "ascii");
          }
        }
        socket.write(prefix);
        sentReplayPrefix = true;
        this.bumpActivity("tcp6666_replay_prefix", { remote, len: prefix.length });
        this.emit("tcp6666_replay_prefix", { remote, len: prefix.length });
      };

      const sendOutAtIndex = (idx: number) => {
        if (!outFlow) return;
        if (idx < 0 || idx >= outFlow.records.length) return;
        const r = outFlow.records[idx]!;
        const payload = r.payloadB64 ? Buffer.from(r.payloadB64, "base64") : Buffer.alloc(0);
        sendReplayPrefixIfNeeded();
        socket.write(encode6666Record(r.type, payload));
        outCursor = Math.max(outCursor, idx + 1);
        this.bumpActivity("tcp6666_replay_tx", { remote, type: r.type, len: payload.length, idx });
        this.emit("tcp6666_replay_tx", { remote, type: r.type, len: payload.length, idx });
      };

      const sendNextByType = (type: number) => {
        if (!outFlow) return;
        const recs = outFlow.records;
        let idx = -1;
        for (let i = outCursor; i < recs.length; i++) {
          if (recs[i]!.type === type) {
            idx = i;
            break;
          }
        }
        if (idx < 0) return;
        sendOutAtIndex(idx);
      };

      if (transcript) {
        pickFlowsByRemoteIp();
        if (this.opts.replaySendFirst) {
          setTimeout(() => {
            if (!outFlow || outFlow.records.length === 0) return;
            if (outCursor !== 0) return;
            const first = outFlow.records[0]!;
            if (Number.isFinite(this.opts.replaySendFirstRelMsMax) && first.relMs > this.opts.replaySendFirstRelMsMax) return;
            sendOutAtIndex(0);
          }, 10);
        }
      }

      socket.on("data", (chunk) => {
        this.bumpActivity("tcp6666_data", { remote, bytes: chunk.length });
        const recs = parser.push(chunk);

        if (!prefixLogged && parser.prefixDone) {
          const prefix = parser.getPrefix();
          const tokens = scanAsciiTokens(prefix, 6, 20);
          const hint = tokens.map(tryParseMacUidToken).find((x) => x.macHex || x.uid);

          if (this.opts.expectedHubMacHex && hint?.macHex && this.opts.expectedHubMacHex !== hint.macHex) {
            // eslint-disable-next-line no-console
            console.log(`[hub-emu] WARN hubMacMismatch expected=${this.opts.expectedHubMacHex} got=${hint.macHex}`);
          }

          this.bumpActivity("tcp6666_prefix", {
            remote,
            prefixLen: prefix.length,
            prefixHeadHex: prefix.subarray(0, Math.min(96, prefix.length)).toString("hex"),
            prefixTokens: tokens,
            prefixHint: hint ?? undefined,
          });
          this.emit("tcp6666_prefix", {
            remote,
            prefixLen: prefix.length,
            prefixHeadHex: prefix.subarray(0, Math.min(96, prefix.length)).toString("hex"),
            prefixTokens: tokens,
            prefixHint: hint ?? undefined,
          });

          if (this.opts.findAsciiNeedle) {
            const ascii = prefix.toString("latin1").toLowerCase();
            if (ascii.includes(this.opts.findAsciiNeedle.toLowerCase())) {
              // eslint-disable-next-line no-console
              console.log(`[hub-emu] ASCII_MATCH in prefix needle=${JSON.stringify(this.opts.findAsciiNeedle)}`);
            }
          }

          prefixLogged = true;
        }

        for (const r of recs) {
          const headHex = r.payload.subarray(0, Math.min(24, r.payload.length)).toString("hex");
          this.bumpActivity("tcp6666_rec", { remote, type: r.type, len: r.len, payloadHeadHex: headHex });
          this.emit("tcp6666_rec", { remote, type: r.type, len: r.len, payloadHeadHex: headHex });

          if (this.opts.findAsciiNeedle) {
            const ascii = r.payload.toString("latin1").toLowerCase();
            if (ascii.includes(this.opts.findAsciiNeedle.toLowerCase())) {
              // eslint-disable-next-line no-console
              console.log(`[hub-emu] ASCII_MATCH in payload type=${r.type} needle=${JSON.stringify(this.opts.findAsciiNeedle)}`);
            }
          }

          if (transcript && outFlow) {
            sendNextByType(r.type);
          }
        }
      });

      socket.on("close", () => {
        this.bumpActivity("tcp6666_close", { remote });
        this.emit("tcp6666_close", { remote });
      });

      socket.on("error", (err) => {
        this.bumpActivity("tcp6666_error", { remote, error: String(err) });
        this.emit("tcp6666_error", { remote, error: String(err) });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.tcpPort, this.opts.bindHost, () => resolve());
    });

    this.bumpActivity("listening", { bindHost: this.opts.bindHost, tcpPort: this.opts.tcpPort, udpBind: this.opts.enableUdp7777 });
    this.emit("listening", { bindHost: this.opts.bindHost, tcpPort: this.opts.tcpPort, udp7777: this.opts.enableUdp7777 });

    if (this.opts.exitAfterMs > 0) {
      this.exitTimer = setTimeout(() => void this.shutdown(`exitAfterMs=${this.opts.exitAfterMs}`), this.opts.exitAfterMs);
    }
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    this.bumpActivity("shutdown", { reason });
    this.emit("shutdown", { reason });

    try {
      if (this.opts.capturePath) {
        writeJson(this.opts.capturePath, {
          generatedAt: new Date().toISOString(),
          reason,
          options: {
            bindHost: this.opts.bindHost,
            tcpPort: this.opts.tcpPort,
            enableUdp7777: this.opts.enableUdp7777,
            transcriptPath: this.opts.transcriptPath,
          },
          events: this.capture,
        });
      }
    } catch {
      // ignore capture errors
    }

    try {
      if (this.udp) await this.udp.close();
    } catch {
      // ignore
    }

    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      try {
        this.server.close(() => resolve());
      } catch {
        resolve();
      }
    });

    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.exitTimer) clearTimeout(this.exitTimer);
    this.server = undefined;
  }
}
