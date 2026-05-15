#!/usr/bin/env tsx
/**
 * Pull a few seconds of video then dump the structure of every I-frame's
 * BcMedia `additionalHeader`: size, raw bytes, decoded `time` field, and
 * any leftover bytes after `time`.
 *
 * If Reolink piggybacks bounding-box coordinates anywhere, the leading
 * candidate is this per-keyframe metadata block (Hikvision / Dahua do this).
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
}

function parseArgs(): Args {
  const env = loadEnv();
  let host = env.TCP_HOST ?? "";
  let user = env.TCP_USERNAME ?? "admin";
  let password = env.TCP_PASSWORD ?? "";
  let durationMs = 12_000;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") host = argv[++i];
    else if (a === "--user") user = argv[++i];
    else if (a === "--password") password = argv[++i];
    else if (a === "--duration") durationMs = Number(argv[++i]) * 1000;
    else die(`unknown flag: ${a}`);
  }
  if (!host) die("--host required");
  if (!password) die("--password required");
  return { host, user, password, durationMs };
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

  const codec = new BcMediaCodec(false);
  let iframes = 0;

  const onFrame = (frame: BaichuanFrame): void => {
    if (frame.header.cmdId !== 3) return;
    if (frame.payload.length === 0) return;

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
      dec = Buffer.concat([aesDecryptor.update(encPart), clearPart]);
    } else {
      dec = aesDecryptor.update(frame.payload);
    }

    const packets = codec.decode(dec);
    for (const p of packets) {
      if (p.type !== "Iframe" && p.type !== "Pframe") continue;
      if (p.type !== "Iframe") continue;
      iframes += 1;
      const ah = p.additionalHeader;
      process.stdout.write(
        `[IFRAME #${iframes}] codec=${p.videoType} payload=${p.data.length}B  additionalHeaderSize=${p.additionalHeaderSize}\n`,
      );
      if (ah && ah.length > 0) {
        process.stdout.write(`  ah hex: ${ah.toString("hex").match(/../g)?.join(" ")}\n`);
        if (ah.length >= 4) {
          process.stdout.write(`  ah.time(u32 le) = ${ah.readUInt32LE(0)}  ah.time(epoch?) = ${new Date(ah.readUInt32LE(0) * 1000).toISOString()}\n`);
        }
        if (ah.length >= 8) {
          process.stdout.write(`  ah[4..8] = ${ah.readUInt32LE(4)} (0x${ah.readUInt32LE(4).toString(16)})\n`);
        }
        if (ah.length > 8) {
          process.stdout.write(`  ah[8..] hex: ${ah.subarray(8).toString("hex").match(/../g)?.join(" ")}\n`);
        }
      }
    }
  };
  client.on("frame", onFrame);

  await api.startVideoStream(0, "main");
  process.stdout.write(`stream main started — capturing ${args.durationMs / 1000}s …\n\n`);
  await new Promise<void>((r) => setTimeout(r, args.durationMs));
  try { await api.stopVideoStream(0, "main"); } catch { /* ignore */ }
  await api.close();
  process.stdout.write(`\nTotal I-frames inspected: ${iframes}\n`);
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
