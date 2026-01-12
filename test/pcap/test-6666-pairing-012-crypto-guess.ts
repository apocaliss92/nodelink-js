import { createDecipheriv, createHash } from "node:crypto";
import fs from "node:fs";

type TranscriptRecord = {
  tsMs: number;
  relMs: number;
  streamOff: number;
  type: number;
  len: number;
  payloadB64: string;
};

type TranscriptEntry = {
  dirKey: string;
  reassembledBytes: number;
  gaps: number;
  prefixHex: string;
  prefixTokens: string[];
  records: TranscriptRecord[];
};

type Transcript = {
  generatedAt: string;
  pcapPath: string;
  hubIp?: string;
  entries: TranscriptEntry[];
};

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v && v.length ? v : fallback;
}

function parseEndpoints(dirKey: string): { srcIp?: string; dstIp?: string } {
  const m = dirKey.match(/(\d{1,3}(?:\.\d{1,3}){3}):\d+\s*->\s*(\d{1,3}(?:\.\d{1,3}){3}):\d+/);
  if (!m) return {};
  const out: { srcIp?: string; dstIp?: string } = {};
  if (m[1]) out.srcIp = m[1];
  if (m[2]) out.dstIp = m[2];
  return out;
}

function shannonEntropy(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const freq = new Array<number>(256).fill(0);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i] ?? 0;
    freq[b] = (freq[b] ?? 0) + 1;
  }
  let h = 0;
  for (const c of freq) {
    if (!c) continue;
    const p = c / buf.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function printableAsciiRatio(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let ok = 0;
  for (const b of buf) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) ok++;
    else if (b >= 0x20 && b <= 0x7e) ok++;
  }
  return ok / buf.length;
}

function zeroRatio(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let z = 0;
  for (const b of buf) if (b === 0) z++;
  return z / buf.length;
}

function md5Raw(input: Buffer | string): Buffer {
  return createHash("md5").update(input).digest();
}

function sha256Raw(input: Buffer | string): Buffer {
  return createHash("sha256").update(input).digest();
}

function xor16(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = ((a[i] ?? 0) ^ (b[i] ?? 0)) & 0xff;
  return out;
}

type Candidate = { label: string; key: Buffer };

type Mode = { label: string; algo: string };

function tryDecrypt(mode: Mode, key: Buffer, iv: Buffer, ciphertext: Buffer): Buffer | undefined {
  try {
    const decipher = createDecipheriv(mode.algo, key, iv);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return undefined;
  }
}

function main(): void {
  const transcriptPath = env("TRANSCRIPT");
  if (!transcriptPath) throw new Error("Missing TRANSCRIPT env");

  const hubIp = env("HUB_IP", "192.168.1.161") ?? "192.168.1.161";
  const camIp = env("CAM_IP", "192.168.1.139") ?? "192.168.1.139";
  const dir = env("DIR", "cam") ?? "cam";
  const type = Number(env("TYPE", "1") ?? "1");

  const raw = fs.readFileSync(transcriptPath, "utf8");
  const t = JSON.parse(raw) as Transcript;

  const src = dir === "hub" ? hubIp : camIp;
  const dst = dir === "hub" ? camIp : hubIp;

  const entry = t.entries.find((e) => {
    const ep = parseEndpoints(e.dirKey);
    return ep.srcIp === src && ep.dstIp === dst;
  });

  if (!entry) throw new Error(`No entry for ${src} -> ${dst}`);
  const rec = entry.records.find((r) => r.type === type);
  if (!rec) throw new Error(`No record type=${type} in ${src} -> ${dst}`);

  const payload = Buffer.from(rec.payloadB64, "base64");
  const ivRaw = payload.subarray(0, 16);
  const body = payload.subarray(16);

  // Observed for type=0: cam<->hub head16 differs by a constant XOR mask on byte 0 and 8.
  // Try both raw and normalized IV variants.
  const type0Mask = Buffer.from("0100000000000000c000000000000000", "hex");
  const ivCandidates: Array<{ label: string; iv: Buffer }> = [
    { label: "iv=head16.raw", iv: ivRaw },
    { label: "iv=head16^type0Mask", iv: xor16(ivRaw, type0Mask) },
  ];

  const token0 = entry.prefixTokens[0] ?? "";
  const token1 = entry.prefixTokens[1] ?? "";
  const prefix = entry.prefixHex.length ? Buffer.from(entry.prefixHex, "hex") : Buffer.alloc(0);
  const tail32 = prefix.length >= 32 ? prefix.subarray(prefix.length - 32) : Buffer.alloc(0);

  const candidates: Candidate[] = [];

  if (tail32.length === 32) {
    candidates.push({ label: "tail32.first16", key: tail32.subarray(0, 16) });
    candidates.push({ label: "tail32.last16", key: tail32.subarray(16, 32) });
    candidates.push({ label: "md5(tail32).raw", key: md5Raw(tail32) });
    candidates.push({ label: "sha256(tail32).first16", key: sha256Raw(tail32).subarray(0, 16) });
  }

  if (token1.length) {
    candidates.push({ label: "md5(token1).raw", key: md5Raw(token1) });
    candidates.push({ label: "sha256(token1).first16", key: sha256Raw(token1).subarray(0, 16) });
  }
  if (token0.length) {
    candidates.push({ label: "md5(token0).raw", key: md5Raw(token0) });
    candidates.push({ label: "sha256(token0).first16", key: sha256Raw(token0).subarray(0, 16) });
  }
  if (token0.length && token1.length) {
    candidates.push({ label: "md5(token0|token1).raw", key: md5Raw(`${token0}|${token1}`) });
    candidates.push({ label: "md5(token1|token0).raw", key: md5Raw(`${token1}|${token0}`) });
  }

  // De-dupe by hex
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const h = c.key.toString("hex");
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });

  const modes: Mode[] = [
    { label: "aes-128-cbc", algo: "aes-128-cbc" },
    { label: "aes-128-cfb", algo: "aes-128-cfb" },
    { label: "aes-128-ofb", algo: "aes-128-ofb" },
    { label: "aes-128-ctr", algo: "aes-128-ctr" },
  ];

  type Result = {
    mode: string;
    keyLabel: string;
    score: number;
    entropy: number;
    ascii: number;
    zeros: number;
    head16: string;
  };

  const results: Result[] = [];

  for (const m of modes) {
    for (const c of unique) {
      for (const ivc of ivCandidates) {
        const pt = tryDecrypt(m, c.key, ivc.iv, body);
        if (!pt) continue;
        const ent = shannonEntropy(pt);
        const ascii = printableAsciiRatio(pt);
        const zeros = zeroRatio(pt);
        // Heuristic: prefer printable, lower entropy, or non-trivial zeros.
        const score = ascii * 3 + (7.5 - ent) + zeros;
        results.push({
          mode: `${m.label} (${ivc.label})`,
          keyLabel: c.label,
          score,
          entropy: ent,
          ascii,
          zeros,
          head16: pt.subarray(0, 16).toString("hex"),
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);

  console.log("## 6666 pairing 0/1/2 crypto guess");
  console.log(`pcap=${t.pcapPath}`);
  console.log(`dir=${src} -> ${dst} type=${type}`);
  console.log(`payloadLen=${payload.length} bodyLen=${body.length}`);
  console.log(`iv16.raw=${ivRaw.toString("hex")}`);
  console.log(`iv16^type0Mask=${xor16(ivRaw, type0Mask).toString("hex")}`);
  console.log(`token0=${token0}`);
  console.log(`token1=${token1}`);
  console.log(`tail32=${tail32.length ? tail32.toString("hex") : ""}`);
  console.log("\n-- Top candidates --");
  for (const r of results.slice(0, 12)) {
    console.log(
      `mode=${r.mode} key=${r.keyLabel} score=${r.score.toFixed(3)} entropy=${r.entropy.toFixed(3)} ascii=${r.ascii.toFixed(3)} zeros=${r.zeros.toFixed(3)} head16=${r.head16}`,
    );
  }
}

main();
