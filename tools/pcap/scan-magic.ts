#!/usr/bin/env tsx
/**
 * Replicate `BaichuanVideoStream` decryption, but instead of running the data
 * through `parseBcMedia` (which silently swallows unknown chunks), enumerate
 * every distinct 4-byte magic that appears in the decrypted stream.
 *
 * Goal: catch any "Motion Mark" metadata sub-packet that the production parser
 * ignores because its magic isn't in the known set (InfoV1/V2, cd0x, cd1x, bw50, bw10).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { BaichuanClient } from "../../src/client/BaichuanClient";
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

const KNOWN_BCMEDIA_MAGICS = new Set<number>([
  0x31303031, // InfoV1
  0x32303031, // InfoV2
  0x62773530, // AAC
  0x62773130, // ADPCM
]);

function isKnownMagic(m: number): boolean {
  if (KNOWN_BCMEDIA_MAGICS.has(m)) return true;
  if (m >= 0x63643030 && m <= 0x63643039) return true; // I-frame cd0x
  if (m >= 0x63643130 && m <= 0x63643139) return true; // P-frame cd1x
  return false;
}

function magicAscii(m: number): string {
  return Buffer.from([m & 0xff, (m >>> 8) & 0xff, (m >>> 16) & 0xff, (m >>> 24) & 0xff])
    .toString("ascii")
    .replace(/[^\x20-\x7e]/g, ".");
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
  process.stdout.write(`login OK (full_aes)\n`);

  // Concatenate decrypted payload across all video frames, then scan for magics.
  let allDecrypted = Buffer.alloc(0);

  const onFrame = (frame: BaichuanFrame): void => {
    if (frame.header.cmdId !== 3) return;
    if (frame.payload.length === 0) return;

    // Parse extension to get encryptLen / binaryData hints.
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
      // Non-binary payload (rare for video) — use ad-hoc AES on full payload.
      dec = aesDecrypt(frame.payload, enc.key);
    } else if (encryptLen !== undefined && encryptLen > 0 && encryptLen < frame.payload.length) {
      // Mixed: first `encryptLen` bytes AES-encrypted, rest clear.
      const encPart = frame.payload.subarray(0, encryptLen);
      const clearPart = frame.payload.subarray(encryptLen);
      const decEnc = aesDecryptor.update(encPart);
      dec = Buffer.concat([decEnc, clearPart]);
    } else {
      // Whole payload AES-stream encrypted (continuation of a previous fragment).
      dec = aesDecryptor.update(frame.payload);
    }
    allDecrypted = Buffer.concat([allDecrypted, dec]);
  };
  client.on("frame", onFrame);

  await api.startVideoStream(0, args.profile);
  process.stdout.write(`stream ${args.profile} started — listening ${args.durationMs / 1000}s …\n`);
  await new Promise<void>((r) => setTimeout(r, args.durationMs));
  try { await api.stopVideoStream(0, args.profile); } catch { /* ignore */ }
  await api.close();

  process.stdout.write(`\nDecrypted ${allDecrypted.length} bytes total\n`);

  // Walk the buffer 4 bytes at a time. Each time we see a known magic we skip
  // by its payload size; if we don't recognise the magic we record it and
  // step forward one byte. This surfaces every potential sub-packet type.
  const counts = new Map<number, { n: number; firstOff: number; samples: string[] }>();
  let i = 0;
  while (i < allDecrypted.length - 4) {
    const m = allDecrypted.readUInt32LE(i);
    const ascii = magicAscii(m);
    // Heuristic: only consider 4-byte sequences that look "printable" or are in known range
    const printable = /^[a-zA-Z0-9._-]{4}$/.test(ascii);
    if (printable || isKnownMagic(m)) {
      let entry = counts.get(m);
      if (!entry) {
        entry = { n: 0, firstOff: i, samples: [] };
        counts.set(m, entry);
      }
      entry.n += 1;
      if (entry.samples.length < 3) {
        entry.samples.push(allDecrypted.subarray(i, Math.min(i + 48, allDecrypted.length)).toString("hex"));
      }
    }
    i += 1;
  }

  const rows = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
  process.stdout.write(`\nMagic occurrences (printable ASCII or known BcMedia magics):\n`);
  process.stdout.write(`  magic     ascii  count   firstOff   known   sample\n`);
  for (const [m, info] of rows.slice(0, 60)) {
    process.stdout.write(
      `  ${m.toString(16).padStart(8, "0")}  ${magicAscii(m).padEnd(5, " ")}  ${String(info.n).padStart(5, " ")}  ${String(info.firstOff).padStart(9, " ")}   ${isKnownMagic(m) ? "yes" : "NO "}    ${info.samples[0].slice(0, 60)}\n`,
    );
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
