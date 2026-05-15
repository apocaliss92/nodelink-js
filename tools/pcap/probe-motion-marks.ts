#!/usr/bin/env tsx
/**
 * Live probe: connect to the camera, open the mainStream (where Motion Marks
 * are documented to appear), and log every Baichuan frame received that is NOT
 * a normal video packet (cmd_id != 3) — plus a structural scan of cmd_id=3
 * extension XML payloads, which is where Reolink sometimes piggybacks metadata.
 *
 * Goal: identify the wire channel that carries the bounding-box metadata, if it
 * exists, by walking real traffic instead of replaying old captures.
 *
 * Usage:
 *   npx tsx tools/pcap/probe-motion-marks.ts \
 *     --host 192.168.50.226 [--user admin] [--password XXX] [--duration 30]
 *
 * Credentials default to TCP_HOST / TCP_USERNAME / TCP_PASSWORD from .env.
 */
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { BaichuanClient } from "../../src/client/BaichuanClient";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { describeCmdId, describeMessageClass } from "./cmd-names";
import type { BaichuanFrame } from "../../src/protocol/framing";
import {
  aesDecrypt,
  bcDecrypt,
  type EncryptionProtocol,
} from "../../src/protocol/crypto";

interface Args {
  host: string;
  user: string;
  password: string;
  durationMs: number;
  profile: "main" | "sub" | "ext";
}

function parseArgs(): Args {
  const env = loadEnv();
  let host = env.TCP_HOST ?? "";
  let user = env.TCP_USERNAME ?? "admin";
  let password = env.TCP_PASSWORD ?? "";
  let durationMs = 30_000;
  let profile: Args["profile"] = "main";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") host = argv[++i];
    else if (a === "--user") user = argv[++i];
    else if (a === "--password") password = argv[++i];
    else if (a === "--duration") durationMs = Number(argv[++i]) * 1000;
    else if (a === "--profile") {
      const v = argv[++i];
      if (v !== "main" && v !== "sub" && v !== "ext") {
        die(`--profile must be main|sub|ext, got ${v}`);
      }
      profile = v;
    } else die(`unknown flag: ${a}`);
  }
  if (!host) die("--host required (or set TCP_HOST in .env)");
  if (!password) die("--password required (or set TCP_PASSWORD in .env)");
  return { host, user, password, durationMs, profile };
}

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const path = pathResolve(process.cwd(), ".env");
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    /* no .env, ok */
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  process.stdout.write(
    `Connecting to ${args.host} as ${args.user}, profile=${args.profile}, duration=${
      args.durationMs / 1000
    }s\n`,
  );

  const api = new ReolinkBaichuanApi({
    host: args.host,
    username: args.user,
    password: args.password,
  });

  const client = api["client"] as BaichuanClient; // private but exposed structurally
  const enc = () => (client as unknown as { enc: EncryptionProtocol }).enc;

  const counts = new Map<number, { n: number; firstAt: number; samples: string[] }>();
  const startedAt = Date.now();

  const tap = (frame: BaichuanFrame): void => {
    const cmd = frame.header.cmdId;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);

    // Always count
    let entry = counts.get(cmd);
    if (!entry) {
      entry = { n: 0, firstAt: Date.now() - startedAt, samples: [] };
      counts.set(cmd, entry);
    }
    entry.n += 1;

    // Only print things that look interesting:
    //   - non-video cmd_ids
    //   - video frames whose extension is non-empty (rare; would suggest metadata)
    const isVideo = cmd === 3;
    const hasExt = frame.extension.length > 0;
    if (isVideo && !hasExt) return;

    const xmlExt = tryDecodeXml(frame.extension, frame.header.channelId, enc());
    const xmlBody = isVideo ? undefined : tryDecodeXml(frame.payload, frame.header.channelId, enc());

    const tag = `${describeCmdId(cmd)} ch=${frame.header.channelId} class=${describeMessageClass(frame.header.messageClass)}`;
    process.stdout.write(`+${elapsed}s  cmd=${cmd}  ${tag}  ext=${frame.extension.length}B  body=${frame.payload.length}B\n`);
    if (xmlExt) process.stdout.write(`    ext: ${oneLine(xmlExt, 240)}\n`);
    if (xmlBody) process.stdout.write(`    body: ${oneLine(xmlBody, 240)}\n`);

    // Stash up to 5 samples per cmd for the final summary
    if (entry.samples.length < 5) {
      entry.samples.push((xmlBody ?? xmlExt ?? hexPreview(frame.body, 64)).slice(0, 200));
    }
  };
  client.on("frame", tap);

  await client.connect();
  await client.login("full_aes");
  process.stdout.write(`login OK (enc=${enc().kind})\n\n`);

  // Open the requested stream so the camera starts pushing video + any
  // co-stream metadata.
  await api.startVideoStream(0, args.profile);
  process.stdout.write(`stream ${args.profile} started, watching for ${args.durationMs / 1000}s …\n\n`);

  await new Promise<void>((resolve) => setTimeout(resolve, args.durationMs));

  try {
    await api.stopVideoStream(0, args.profile);
  } catch {
    /* ignore */
  }
  await api.close();

  process.stdout.write("\n=== summary ===\n");
  const rows = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [cmd, info] of rows) {
    process.stdout.write(`  cmd=${String(cmd).padStart(4)} n=${String(info.n).padStart(5)}  ${describeCmdId(cmd)}\n`);
  }
  process.stdout.write("\nNon-video samples:\n");
  for (const [cmd, info] of rows) {
    if (cmd === 3 || info.samples.length === 0) continue;
    process.stdout.write(`  cmd=${cmd} samples:\n`);
    for (const s of info.samples) process.stdout.write(`    | ${s}\n`);
  }
}

function tryDecodeXml(buf: Buffer, channelId: number, enc: EncryptionProtocol): string | undefined {
  if (buf.length === 0) return undefined;
  const candidates: Buffer[] = [];
  try {
    if (enc.kind === "aes" || enc.kind === "full_aes") candidates.push(aesDecrypt(buf, enc.key));
  } catch {/* ignore */}
  try { candidates.push(bcDecrypt(buf, channelId)); } catch {/* ignore */}
  candidates.push(buf);
  for (const c of candidates) {
    const s = c.toString("utf8");
    if (s.startsWith("<?xml") || s.startsWith("<body") || s.startsWith("<Extension")) {
      return s;
    }
  }
  return undefined;
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function hexPreview(buf: Buffer, max: number): string {
  return buf.subarray(0, max).toString("hex").match(/../g)?.join(" ") ?? "";
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
