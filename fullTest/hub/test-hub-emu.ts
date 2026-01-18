import net from "node:net";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Udp7777Listener } from "../../src/hub/Udp7777Listener.js";

const MAGIC_6666 = Buffer.from([0x0c, 0x00, 0x01, 0x00]); // u32le 0x0001000c

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

function canonMacHex(mac: string | undefined): string | undefined {
  if (!mac) return undefined;
  const hex = mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 12) return undefined;
  return hex;
}

type Rec = { type: number; len: number; payload: Buffer };

type TranscriptEntry = {
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

type TranscriptFile = {
  generatedAt: string;
  pcapPath: string;
  hubIp: string;
  entries: TranscriptEntry[];
  udp7777Samples: Array<{ tsMs: number; dirKey: string; payloadLen: number; parsed: any; payloadB64: string }>;
};

function parseDirKey(dirKey: string): { srcIp: string; srcPort: number; dstIp: string; dstPort: number } | undefined {
  // Example: "192.168.1.161:6666 -> 192.168.1.139:63057"
  const m = dirKey.match(/^([^:]+):(\d+)\s*->\s*([^:]+):(\d+)$/);
  if (!m) return undefined;
  return {
    srcIp: m[1]!,
    srcPort: Number.parseInt(m[2]!, 10),
    dstIp: m[3]!,
    dstPort: Number.parseInt(m[4]!, 10),
  };
}

function encode6666Record(type: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(12 + payload.length);
  out.writeUInt32LE(0x0001000c, 0);
  out.writeUInt32LE(payload.length, 4);
  out.writeUInt32LE(type >>> 0, 8);
  payload.copy(out, 12);
  return out;
}

function resolvePathMaybe(relOrAbs: string): string {
  return path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(process.cwd(), relOrAbs);
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

class Tcp6666StreamParser {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  private prefix: Buffer<ArrayBufferLike> = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  public prefixDone = false;

  push(chunk: Buffer<ArrayBufferLike>): Rec[] {
    this.buf = (this.buf.length === 0 ? chunk : (Buffer.concat([this.buf, chunk]) as Buffer<ArrayBufferLike>)) as Buffer<ArrayBufferLike>;
    const out: Rec[] = [];

    while (this.buf.length >= 12) {
      const idx = this.buf.indexOf(MAGIC_6666);
      if (idx < 0) {
        // keep last 3 bytes in case magic spans boundary
        const keep = Math.min(3, this.buf.length);
        const drop = this.buf.length - keep;
        if (drop > 0 && !this.prefixDone)
          this.prefix = Buffer.concat([this.prefix, this.buf.subarray(0, drop)]) as Buffer<ArrayBufferLike>;
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

async function main(): Promise<void> {
  const bindHost = process.env.HUB_EMU_BIND_HOST ?? "0.0.0.0";
  const tcpPort = Number.parseInt(process.env.HUB_EMU_TCP_6666_PORT ?? "6666", 10);
  const udpBind = (process.env.HUB_EMU_UDP_7777 ?? "1").trim() === "1";
  const expectedHubMac = canonMacHex(process.env.NVR_MAC);

  const exitAfterMs = Number.parseInt((process.env.HUB_EMU_EXIT_AFTER_MS ?? "0").trim(), 10);
  const idleExitMs = Number.parseInt((process.env.HUB_EMU_IDLE_EXIT_MS ?? "0").trim(), 10);
  const capturePathRaw = (process.env.HUB_EMU_CAPTURE_PATH ?? "").trim();
  const capturePath = capturePathRaw ? resolvePathMaybe(capturePathRaw) : "";
  const findAsciiNeedle = (process.env.HUB_EMU_FIND_ASCII ?? "").trim();
  const findAsciiNeedleLower = findAsciiNeedle ? findAsciiNeedle.toLowerCase() : "";

  const replayPathRaw = (process.env.HUB_EMU_REPLAY_6666_TRANSCRIPT ?? "").trim();
  const replayEnabled = Boolean(replayPathRaw);
  const replayPath = replayEnabled ? resolvePathMaybe(replayPathRaw) : "";
  const replayVerbose = (process.env.HUB_EMU_REPLAY_VERBOSE ?? "1").trim() === "1";
  const replayMutatePrefixToken = (process.env.HUB_EMU_REPLAY_MUTATE_PREFIX_TOKEN ?? "1").trim() === "1";
  const replaySendFirst = (process.env.HUB_EMU_REPLAY_SEND_FIRST ?? "0").trim() === "1";
  const replaySendFirstRelMsMax = Number.parseFloat((process.env.HUB_EMU_REPLAY_SEND_FIRST_REL_MS_MAX ?? "0").trim());

  const capture: any[] = [];
  const cap = (evt: any) => {
    if (!capturePath) return;
    capture.push({ tsMs: Date.now(), ...evt });
  };

  let idleTimer: NodeJS.Timeout | undefined;
  const bumpActivity = (kind: string, extra?: any) => {
    cap({ kind, ...(extra ?? {}) });
    if (idleExitMs > 0) {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => void shutdown(`idle>${idleExitMs}ms`), idleExitMs);
    }
  };

  let udp: Udp7777Listener | undefined;
  let server: net.Server | undefined;
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      console.log(`[hub-emu] shutdown reason=${JSON.stringify(reason)}`);
      bumpActivity("shutdown", { reason });
      if (capturePath) {
        writeJson(capturePath, {
          generatedAt: new Date().toISOString(),
          reason,
          env: {
            bindHost,
            tcpPort,
            udpBind,
            replayEnabled,
            replayPath: replayEnabled ? replayPath : undefined,
            exitAfterMs,
            idleExitMs,
            findAsciiNeedle: findAsciiNeedle || undefined,
          },
          events: capture,
        });
        console.log(`[hub-emu] wrote capture: ${capturePath} events=${capture.length}`);
      }
    } catch (e) {
      console.log(`[hub-emu] shutdown capture error: ${(e as Error).message}`);
    }

    try {
      if (udp) await udp.close();
    } catch {
      // ignore
    }

    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });

    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  let transcript: TranscriptFile | undefined;
  if (replayEnabled) {
    const raw = fs.readFileSync(replayPath, "utf8");
    transcript = JSON.parse(raw) as TranscriptFile;
    console.log(`[replay] loaded transcript: ${replayPath}`);
    console.log(`[replay] entries=${transcript.entries.length} udp7777Samples=${transcript.udp7777Samples.length}`);
  }

  if (udpBind) {
    udp = new Udp7777Listener({ host: bindHost });
    udp.on("packet", (p) => {
      bumpActivity("udp7777", {
        from: `${p.rinfo.address}:${p.rinfo.port}`,
        len: p.payload.length,
        uid: p.uid,
        seq: p.seq,
        dataLen: p.dataLen,
      });
      console.log(
        `[udp7777] from=${p.rinfo.address}:${p.rinfo.port} len=${p.payload.length} uid=${JSON.stringify(p.uid ?? "?")} seq=${p.seq ?? "?"} dataLen=${p.dataLen ?? "?"}`,
      );
    });
    udp.on("pirCandidate", (p) => {
      bumpActivity("udp7777_pirCandidate", { uid: p.uid });
      console.log(
        `[udp7777] PIR? from=${p.rinfo.address}:${p.rinfo.port} len=${p.payload.length} uid=${JSON.stringify(p.uid ?? "?")} seq=${p.seq ?? "?"}`,
      );
    });
    udp.start();
    console.log(`[udp7777] listening on ${bindHost}:7777`);
  }

  server = net.createServer((socket) => {
    const remote = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? "?"}`;
    console.log(`[tcp6666] connect ${remote}`);
    bumpActivity("tcp6666_connect", { remote });

    const parser = new Tcp6666StreamParser();
    let prefixLogged = false;

    // Replay state per connection
    let sentReplayPrefix = false;
    let outCursor = 0;
    let outFlow: TranscriptEntry | undefined;
    let inFlow: TranscriptEntry | undefined;

    const pickFlows = (camHint: { macHex?: string; uid?: string } | undefined) => {
      if (!transcript || !camHint?.uid) return;
      const entries = transcript.entries;
      // Heuristic from PCAP: u16le@2==0 is camera->hub, u16le@2==200 is hub->camera.
      inFlow = entries.find((e) => e.prefixTokenHint?.uid === camHint.uid && e.prefixU16le2 === 0);
      outFlow = entries.find((e) => e.prefixTokenHint?.uid === camHint.uid && e.prefixU16le2 === 200);
      if (replayVerbose) {
        console.log(
          `[replay] ${remote} flowPick uid=${camHint.uid} in=${inFlow ? inFlow.dirKey : "-"} out=${outFlow ? outFlow.dirKey : "-"}`,
        );
      }
    };

    const pickFlowsByRemoteIp = () => {
      if (!transcript) return;
      const remoteIp = socket.remoteAddress;
      if (!remoteIp) return;

      const entries = transcript.entries;
      const outCandidates = entries.filter((e) => {
        const d = parseDirKey(e.dirKey);
        return Boolean(d && d.srcPort === 6666 && d.dstIp === remoteIp);
      });
      const inCandidates = entries.filter((e) => {
        const d = parseDirKey(e.dirKey);
        return Boolean(d && d.dstPort === 6666 && d.srcIp === remoteIp);
      });

      // Prefer entries that have records.
      outFlow = outCandidates.find((e) => e.records.length > 0) ?? outCandidates[0];
      inFlow = inCandidates.find((e) => e.records.length > 0) ?? inCandidates[0];

      if (replayVerbose) {
        console.log(
          `[replay] ${remote} flowPickByIp remoteIp=${remoteIp} in=${inFlow ? inFlow.dirKey : "-"} out=${outFlow ? outFlow.dirKey : "-"}`,
        );
      }
    };

    const sendReplayPrefixIfNeeded = () => {
      if (!outFlow || sentReplayPrefix) return;
      const prefix = Buffer.from(outFlow.prefixHex, "hex");
      if (replayMutatePrefixToken) {
        const toks = findAsciiTokenOffsets(prefix, 6);
        // Keep token0 (MAC+UID), mutate token1 if present.
        if (toks.length >= 2) {
          const t1 = toks[1]!;
          const newTok = randomBase62(t1.token.length);
          prefix.write(newTok, t1.start, t1.token.length, "ascii");
          if (replayVerbose) console.log(`[replay] ${remote} mutated hubToken ${JSON.stringify(t1.token)} -> ${JSON.stringify(newTok)}`);
        }
      }
      socket.write(prefix);
      sentReplayPrefix = true;
      if (replayVerbose) console.log(`[replay] ${remote} sent prefix len=${prefix.length}`);
      bumpActivity("tcp6666_replay_prefix", { remote, len: prefix.length });
    };

    const sendOutAtIndex = (idx: number) => {
      if (!outFlow) return;
      if (idx < 0 || idx >= outFlow.records.length) return;
      const r = outFlow.records[idx]!;
      const payload = r.payloadB64 ? Buffer.from(r.payloadB64, "base64") : Buffer.alloc(0);
      sendReplayPrefixIfNeeded();
      socket.write(encode6666Record(r.type, payload));
      outCursor = Math.max(outCursor, idx + 1);
      console.log(`[replay] ${remote} tx type=${r.type} len=${payload.length} (idx=${idx})`);
      bumpActivity("tcp6666_replay_tx", { remote, type: r.type, len: payload.length, idx });
    };

    const sendNextByType = (type: number) => {
      if (!outFlow) return;
      const recs = outFlow.records;
      // Find next outgoing record with matching type starting from cursor.
      let idx = -1;
      for (let i = outCursor; i < recs.length; i++) {
        if (recs[i]!.type === type) {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        if (replayVerbose) console.log(`[replay] ${remote} no outgoing rec left for type=${type}`);
        return;
      }
      const r = recs[idx]!;
      const payload = r.payloadB64 ? Buffer.from(r.payloadB64, "base64") : Buffer.alloc(0);
      sendReplayPrefixIfNeeded();
      socket.write(encode6666Record(r.type, payload));
      outCursor = idx + 1;
      console.log(`[replay] ${remote} tx type=${r.type} len=${payload.length} (idx=${idx})`);
      bumpActivity("tcp6666_replay_tx", { remote, type: r.type, len: payload.length, idx });
    };

    if (replayEnabled) {
      // Some captures (e.g. unpairing) have no prefix tokens; pick flows by IP immediately.
      pickFlowsByRemoteIp();

      // Some sessions are hub-initiated: the hub sends the first framed record right after TCP connect.
      if (replaySendFirst) {
        setTimeout(() => {
          if (!outFlow || outFlow.records.length === 0) return;
          if (outCursor !== 0) return;
          const first = outFlow.records[0]!;
          if (Number.isFinite(replaySendFirstRelMsMax) && first.relMs > replaySendFirstRelMsMax) return;
          sendOutAtIndex(0);
        }, 10);
      }
    }

    socket.on("data", (chunk) => {
      bumpActivity("tcp6666_data", { remote, bytes: chunk.length });
      const recs = parser.push(chunk);
      if (!prefixLogged && parser.prefixDone) {
        const prefix = parser.getPrefix();
        const tokens = scanAsciiTokens(prefix, 6, 20);
        const hint = tokens.map(tryParseMacUidToken).find((x) => x.macHex || x.uid);
        console.log(`[tcp6666] ${remote} prefixLen=${prefix.length} headHex=${prefix.subarray(0, Math.min(96, prefix.length)).toString("hex")}`);
        if (tokens.length) console.log(`[tcp6666] ${remote} prefixTokens=${tokens.map((t) => JSON.stringify(t)).join(" ")}`);
        if (hint?.macHex || hint?.uid) {
          console.log(`[tcp6666] ${remote} prefixHint macHex=${hint.macHex ?? "?"} uid=${hint.uid ?? "?"}`);
          if (expectedHubMac && hint?.macHex && expectedHubMac !== hint.macHex) {
            console.log(`[tcp6666] ${remote} WARN hubMacMismatch expected=${expectedHubMac} got=${hint.macHex}`);
          }
        }

        bumpActivity("tcp6666_prefix", {
          remote,
          prefixLen: prefix.length,
          prefixHeadHex: prefix.subarray(0, Math.min(96, prefix.length)).toString("hex"),
          prefixTokens: tokens,
          prefixHint: hint ?? undefined,
        });

        if (findAsciiNeedleLower) {
          const ascii = prefix.toString("latin1").toLowerCase();
          if (ascii.includes(findAsciiNeedleLower)) {
            console.log(`[tcp6666] ${remote} ASCII_MATCH in prefix needle=${JSON.stringify(findAsciiNeedle)}`);
            bumpActivity("tcp6666_ascii_match_prefix", { remote, needle: findAsciiNeedle });
          }
        }

        if (replayEnabled) pickFlows(hint);
        if (replayEnabled && !outFlow) pickFlowsByRemoteIp();
        prefixLogged = true;
      }

      for (const r of recs) {
        const head = r.payload.subarray(0, Math.min(24, r.payload.length)).toString("hex");
        console.log(`[tcp6666] ${remote} rec type=${r.type} len=${r.len} payloadHeadHex=${head}`);
        bumpActivity("tcp6666_rec", { remote, type: r.type, len: r.len, payloadHeadHex: head });

        if (findAsciiNeedleLower) {
          const ascii = r.payload.toString("latin1").toLowerCase();
          if (ascii.includes(findAsciiNeedleLower)) {
            console.log(`[tcp6666] ${remote} ASCII_MATCH in payload type=${r.type} needle=${JSON.stringify(findAsciiNeedle)}`);
            bumpActivity("tcp6666_ascii_match_payload", { remote, type: r.type, needle: findAsciiNeedle });
          }
        }

        if (replayEnabled && outFlow) {
          // Minimal strategy: respond with same type using transcript order.
          // Observed pairing session shows symmetric type numbers (0..16) with different lengths per direction.
          sendNextByType(r.type);
        }
      }
    });

    socket.on("close", () => {
      bumpActivity("tcp6666_close", { remote });
      console.log(`[tcp6666] close ${remote}`);
    });
    socket.on("error", (err) => {
      bumpActivity("tcp6666_error", { remote, error: String(err) });
      console.log(`[tcp6666] error ${remote} ${String(err)}`);
    });
  });

  server.listen(tcpPort, bindHost, () => {
    console.log(`[tcp6666] listening on ${bindHost}:${tcpPort}`);
    console.log("Env: HUB_EMU_BIND_HOST, HUB_EMU_TCP_6666_PORT, HUB_EMU_UDP_7777");
    if (capturePath) console.log(`[hub-emu] capture enabled: ${capturePath}`);
    if (idleExitMs > 0) console.log(`[hub-emu] idle auto-exit: ${idleExitMs}ms`);
    if (exitAfterMs > 0) console.log(`[hub-emu] exit after: ${exitAfterMs}ms`);
    if (findAsciiNeedle) console.log(`[hub-emu] find ASCII needle: ${JSON.stringify(findAsciiNeedle)}`);
    bumpActivity("listening", { bindHost, tcpPort, udpBind });
  });

  if (exitAfterMs > 0) setTimeout(() => void shutdown(`exitAfterMs=${exitAfterMs}`), exitAfterMs);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
