#!/usr/bin/env tsx
/**
 * Connect to the camera, open the mainStream, and dump every BcMedia I/P-frame
 * `additionalHeader` block we receive. Reolink uses these blocks for things
 * like the I-frame timestamp; in some firmwares they also carry side metadata
 * (e.g. AI bounding-box payloads) that the canonical parser doesn't surface.
 *
 * Output: a CSV of (frameIdx, type, additionalHeaderSize, hexPreview) so we
 * can spot unusual sizes (≠4 bytes for I-frame, ≠0 for P-frame) and inspect
 * their contents.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { BaichuanClient } from "../../src/client/BaichuanClient";
import { BcMediaCodec } from "../../src/baichuan/stream/BcMediaCodec";
import {
  AesStreamDecryptor,
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

function parseArgs(): Args {
  const env = loadEnv();
  let host = env.TCP_HOST ?? "";
  let user = env.TCP_USERNAME ?? "admin";
  let password = env.TCP_PASSWORD ?? "";
  let durationMs = 15_000;
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

async function main(): Promise<void> {
  const args = parseArgs();
  const api = new ReolinkBaichuanApi({
    host: args.host,
    username: args.user,
    password: args.password,
  });
  const client = api["client"] as BaichuanClient;

  await client.connect();
  await client.login("full_aes");
  const enc = (client as unknown as { enc: EncryptionProtocol }).enc;
  if (enc.kind !== "full_aes") die(`expected full_aes, got ${enc.kind}`);
  const aesDecryptor = new AesStreamDecryptor(enc.key);
  process.stdout.write(`login OK\n`);

  const codec = new BcMediaCodec(/* strict */ false);
  let iIdx = 0;
  let pIdx = 0;
  const headerStats = new Map<number, number>(); // additionalHeaderSize → count
  const headerSamples = new Map<number, string[]>();

  const onFrame = (frame: BaichuanFrame): void => {
    if (frame.header.cmdId !== 3) return;
    if (frame.payload.length === 0) return;

    // Reuse production decryption strategy
    let encryptLen: number | undefined;
    let payloadIsBinary = true;
    if (frame.extension.length > 0) {
      const extXml = tryDecryptXml(frame.extension, frame.header.channelId, enc);
      if (extXml) {
        const m = /<encryptLen>(\d+)<\/encryptLen>/.exec(extXml);
        if (m) encryptLen = Number(m[1]);
        const bd = /<binaryData>(\d+)<\/binaryData>/.exec(extXml);
        if (bd && bd[1] === "0") payloadIsBinary = false;
      }
    }

    let dec: Buffer;
    if (!payloadIsBinary) {
      dec = aesDecrypt(frame.payload, enc.key);
    } else if (encryptLen !== undefined && encryptLen > 0 && encryptLen < frame.payload.length) {
      const encPart = frame.payload.subarray(0, encryptLen);
      const clearPart = frame.payload.subarray(encryptLen);
      const decEnc = aesDecryptor.update(encPart);
      dec = Buffer.concat([decEnc, clearPart]);
    } else if (encryptLen !== undefined && encryptLen > 0) {
      dec = aesDecryptor.update(frame.payload);
    } else {
      // No encryptLen tag in this frame: it's a continuation chunk fully encrypted.
      dec = aesDecryptor.update(frame.payload);
    }

    const packets = codec.decode(dec);
    for (const p of packets) {
      if (p.type === "Iframe" || p.type === "Pframe") {
        const ahSize = p.additionalHeaderSize ?? 0;
        const ah = p.additionalHeader ?? Buffer.alloc(0);
        const key = ahSize;
        headerStats.set(key, (headerStats.get(key) ?? 0) + 1);
        let list = headerSamples.get(key);
        if (!list) { list = []; headerSamples.set(key, list); }
        if (list.length < 5) {
          list.push(`${p.type === "Iframe" ? "I" : "P"}#${p.type === "Iframe" ? ++iIdx : ++pIdx}  ${ah.toString("hex")}`);
        }
      }
    }
  };
  client.on("frame", onFrame);

  await api.startVideoStream(0, args.profile);
  process.stdout.write(`stream ${args.profile} started — listening ${args.durationMs / 1000}s …\n`);
  await new Promise<void>((r) => setTimeout(r, args.durationMs));
  try { await api.stopVideoStream(0, args.profile); } catch { /* ignore */ }
  await api.close();

  process.stdout.write(`\nadditionalHeaderSize distribution:\n`);
  for (const [size, count] of [...headerStats.entries()].sort((a, b) => a[0] - b[0])) {
    process.stdout.write(`  ${String(size).padStart(4)} bytes  × ${count}\n`);
  }
  process.stdout.write(`\nSamples per size:\n`);
  for (const [size, samples] of [...headerSamples.entries()].sort((a, b) => a[0] - b[0])) {
    process.stdout.write(`  --- size=${size} ---\n`);
    for (const s of samples) process.stdout.write(`    ${s}\n`);
  }
}

function tryDecryptXml(buf: Buffer, channelId: number, enc: EncryptionProtocol): string | undefined {
  const candidates: Buffer[] = [];
  try { if (enc.kind === "aes" || enc.kind === "full_aes") candidates.push(aesDecrypt(buf, enc.key)); } catch { /* ignore */ }
  try { candidates.push(bcDecrypt(buf, channelId)); } catch { /* ignore */ }
  candidates.push(buf);
  for (const c of candidates) {
    const s = c.toString("utf8");
    if (s.startsWith("<?xml") || s.startsWith("<body") || s.startsWith("<Extension")) return s;
  }
  return undefined;
}

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${msg}\n`);
  process.exit(1);
});
