#!/usr/bin/env tsx
/**
 * Full-spectrum probe to localise the channel that carries Motion Mark metadata.
 *
 * Mirrors what the Reolink mobile app does, in this order:
 *   1. Login + the bag of "app-only" GET commands (31, 37, 56, 76, 120, 190, 192, 232, 289)
 *   2. Open subStream (the app uses subStream by default, not mainStream)
 *   3. Listen for `cmd_id != 3` push frames AND log every BcMedia magic the
 *      production codec would silently drop (registered via setUnknownChunkListener).
 *   4. Hold the stream open for the requested duration with motion happening.
 *
 * Output is two tables:
 *   - Cmd-id summary (counts, samples)
 *   - Unknown BcMedia magics (with byte previews) — these are the prime
 *     candidates for an undocumented metadata sub-packet.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { BaichuanClient } from "../../src/client/BaichuanClient";
import { BaichuanVideoStream } from "../../src/baichuan/stream/BaichuanVideoStream";
import type { BcMediaCodec } from "../../src/baichuan/stream/BcMediaCodec";
import {
  aesDecrypt,
  bcDecrypt,
  type EncryptionProtocol,
} from "../../src/protocol/crypto";
import type { BaichuanFrame } from "../../src/protocol/framing";

interface Args {
  host: string;
  user: string;
  password: string;
  durationMs: number;
  profile: "main" | "sub" | "ext";
}

const APP_ONLY_CMDS: number[] = [
  151, // ABILITY_INFO
  146, // GET_STREAM_INFO_LIST
  58,  // GET_ABILITY_SUPPORT
  199, // GET_SUPPORT
  104, // GET_SYSTEM_GENERAL
  102, // GET_HDD_INFO_LIST
  44,  // GET_OSD_DATETIME
  10,  // TALK_ABILITY
  299, // GET_AI_CFG
  56,  // GET_ENC
  76,  // (cmd_76 — network info)
  37,  // (cmd_37 — port info)
  31,  // (cmd_31 — header-only, suspected subscribe)
  192, // (cmd_192 — header-only, suspected subscribe)
  120, // GET_ONLINE_USER_LIST
  190, // GET_PTZ_PRESET
  232, // GET_AUDIO_TASK
  289, // GET_WHITE_LED
];

async function main(): Promise<void> {
  const args = parseArgs();
  process.stdout.write(
    `Connecting to ${args.host}, profile=${args.profile}, duration=${args.durationMs / 1000}s\n`,
  );

  const api = new ReolinkBaichuanApi({
    host: args.host,
    username: args.user,
    password: args.password,
  });
  const client = api["client"] as BaichuanClient;
  const enc = () => (client as unknown as { enc: EncryptionProtocol }).enc;

  const startedAt = Date.now();

  const cmdCounts = new Map<number, { n: number; samples: string[]; first: number }>();
  const cmdSnapshot = (cmd: number, frame: BaichuanFrame, sample: string | undefined): void => {
    let entry = cmdCounts.get(cmd);
    if (!entry) {
      entry = { n: 0, samples: [], first: Date.now() - startedAt };
      cmdCounts.set(cmd, entry);
    }
    entry.n += 1;
    if (sample && entry.samples.length < 3) entry.samples.push(sample.slice(0, 240));
    void frame;
  };

  // Tap 1: every Baichuan frame, count and try to decode XML body (skip cmd=3 noise).
  const tap = (frame: BaichuanFrame): void => {
    const cmd = frame.header.cmdId;
    if (cmd === 3) return;
    const channel = frame.header.channelId;
    let xml: string | undefined;
    if (frame.payload.length > 0) {
      xml = tryDecodeXml(frame.payload, channel, enc());
    }
    cmdSnapshot(cmd, frame, xml ? oneLine(xml, 240) : undefined);
  };
  client.on("frame", tap);

  await client.connect();
  await client.login("full_aes");
  process.stdout.write(`login OK (enc=${enc().kind})\n\n`);

  // Send each app-only cmd_id like the mobile app would.
  process.stdout.write("Sending app-only commands…\n");
  for (const cmd of APP_ONLY_CMDS) {
    try {
      const reply = await sendCmd(client, cmd);
      process.stdout.write(`  cmd=${String(cmd).padStart(3)} OK reply=${reply.length}B\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`  cmd=${String(cmd).padStart(3)} ERR ${msg}\n`);
    }
  }
  process.stdout.write("\n");

  // Now open the requested stream. The mobile app opens subStream.
  const stream = new BaichuanVideoStream({
    client,
    api,
    channel: 0,
    profile: args.profile,
  });

  // Tap 2: listen for unknown BcMedia chunks inside the video stream.
  type UnknownEntry = { magic: number; n: number; firstAt: number; sample: string };
  const unknowns = new Map<number, UnknownEntry>();
  const codec = (stream as unknown as { bcMediaCodec: BcMediaCodec }).bcMediaCodec;
  codec.setUnknownChunkListener(({ magic, preview, skipped }) => {
    const key = magic;
    let e = unknowns.get(key);
    if (!e) {
      e = {
        magic,
        n: 0,
        firstAt: Date.now() - startedAt,
        sample: preview.toString("hex").slice(0, 128),
      };
      unknowns.set(key, e);
    }
    e.n += 1;
    void skipped;
  });

  // Optional debug: also count every regular BcMedia packet for visibility.
  let videoAUs = 0;
  let videoKeyframes = 0;
  let audioFrames = 0;
  stream.on("videoAccessUnit", (au) => {
    videoAUs += 1;
    if (au.isKeyframe) videoKeyframes += 1;
  });
  stream.on("audioFrame", () => { audioFrames += 1; });
  stream.on("error", (err) => process.stderr.write(`stream error: ${err.message}\n`));

  await stream.start();
  process.stdout.write(
    `stream ${args.profile} started — watching ${args.durationMs / 1000}s … trigger motion now.\n\n`,
  );
  await new Promise<void>((r) => setTimeout(r, args.durationMs));
  await stream.stop();
  await api.close();

  process.stdout.write("\n=== Cmd-id summary (non-video) ===\n");
  const rows = [...cmdCounts.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [cmd, info] of rows) {
    process.stdout.write(
      `  cmd=${String(cmd).padStart(4)} n=${String(info.n).padStart(5)}  +${(info.first / 1000).toFixed(2)}s\n`,
    );
    for (const s of info.samples) process.stdout.write(`    | ${s}\n`);
  }
  process.stdout.write(
    `\n=== Video stats: ${videoAUs} access units (${videoKeyframes} keyframes), audio=${audioFrames} ===\n`,
  );

  process.stdout.write("\n=== Unknown BcMedia magics observed in video stream ===\n");
  if (unknowns.size === 0) {
    process.stdout.write("  (none — every chunk was a recognised BcMedia packet)\n");
  } else {
    const sortedUnknowns = [...unknowns.values()].sort((a, b) => b.n - a.n);
    process.stdout.write("  magic     ascii  count   firstAt   sample (first 64 bytes hex)\n");
    for (const u of sortedUnknowns) {
      const a = magicAscii(u.magic);
      process.stdout.write(
        `  ${u.magic.toString(16).padStart(8, "0")}  ${a.padEnd(5, " ")}  ${String(u.n).padStart(5, " ")}  +${(u.firstAt / 1000).toFixed(2)}s  ${u.sample}\n`,
      );
    }
  }
}

async function sendCmd(client: BaichuanClient, cmdId: number): Promise<Buffer> {
  // Header-only frames for cmd_31 and cmd_192; everything else gets an Extension XML
  // with channelId=0 like the app sends.
  const headerOnly = cmdId === 31 || cmdId === 192;
  // sendFrame is exposed on the underlying client (used internally for video).
  const sendFrame = (client as unknown as {
    sendFrame: (params: {
      cmdId: number;
      payloadXml?: string;
      extensionXml?: string;
      messageClass?: number;
      timeoutMs?: number;
      channelIdOverride?: number;
    }) => Promise<BaichuanFrame>;
  }).sendFrame.bind(client);

  const frame = await sendFrame({
    cmdId,
    extensionXml: headerOnly
      ? ""
      : `<?xml version="1.0" encoding="UTF-8" ?>\n<Extension version="1.1">\n<channelId>0</channelId>\n</Extension>\n`,
    timeoutMs: 8_000,
    channelIdOverride: headerOnly ? 0 : undefined,
  });
  return frame.body;
}

function tryDecodeXml(buf: Buffer, channelId: number, enc: EncryptionProtocol): string | undefined {
  const candidates: Buffer[] = [];
  try {
    if (enc.kind === "aes" || enc.kind === "full_aes") candidates.push(aesDecrypt(buf, enc.key));
  } catch {/* ignore */}
  try { candidates.push(bcDecrypt(buf, channelId)); } catch {/* ignore */}
  candidates.push(buf);
  for (const c of candidates) {
    const s = c.toString("utf8");
    if (s.startsWith("<?xml") || s.startsWith("<body") || s.startsWith("<Extension")) return s;
  }
  return undefined;
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function magicAscii(m: number): string {
  return Buffer.from([m & 0xff, (m >>> 8) & 0xff, (m >>> 16) & 0xff, (m >>> 24) & 0xff])
    .toString("ascii")
    .replace(/[^\x20-\x7e]/g, ".");
}

function parseArgs(): Args {
  const env = loadEnv();
  let host = env.TCP_HOST ?? "";
  let user = env.TCP_USERNAME ?? "admin";
  let password = env.TCP_PASSWORD ?? "";
  let durationMs = 30_000;
  let profile: Args["profile"] = "sub"; // mirror app default
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") host = argv[++i];
    else if (a === "--user") user = argv[++i];
    else if (a === "--password") password = argv[++i];
    else if (a === "--duration") durationMs = Number(argv[++i]) * 1000;
    else if (a === "--profile") {
      const v = argv[++i];
      if (v !== "main" && v !== "sub" && v !== "ext") die(`bad --profile: ${v}`);
      profile = v;
    } else die(`unknown flag: ${a}`);
  }
  if (!host) die("--host required");
  if (!password) die("--password required");
  return { host, user, password, durationMs, profile };
}

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const path = pathResolve(process.cwd(), ".env");
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${msg}\n`);
  if (process.env.DEBUG && err instanceof Error && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
