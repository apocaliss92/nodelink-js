import crypto from 'node:crypto';
import fs from 'node:fs';

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
  udp7777Samples?: Array<{
    tsMs: number;
    dirKey: string;
    payloadLen: number;
    parsed?: {
      magicLE?: number;
      dataLen?: number;
      seq?: number;
      uid?: string;
      headerLen?: number;
      dataHeadHex?: string;
      dataTailHex?: string;
    };
  }>;
};

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v && v.length ? v : fallback;
}

function toHex(buf: Buffer, maxBytes?: number): string {
  const slice = typeof maxBytes === 'number' ? buf.subarray(0, maxBytes) : buf;
  return slice.toString('hex');
}

function shannonEntropy(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const counts = new Array<number>(256).fill(0);
  for (const b of buf) counts[b] = (counts[b] ?? 0) + 1;
  let ent = 0;
  const inv = 1 / buf.length;
  for (const c of counts) {
    if (!c) continue;
    const p = c * inv;
    ent -= p * Math.log2(p);
  }
  return ent;
}

function printableRatio(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let printable = 0;
  for (const b of buf) {
    const isAsciiPrintable = b >= 0x20 && b <= 0x7e;
    if (isAsciiPrintable) printable++;
  }
  return printable / buf.length;
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function safeU32le(buf: Buffer, off: number): number | undefined {
  if (off < 0 || off + 4 > buf.length) return undefined;
  return buf.readUInt32LE(off);
}

function fmtU32(v: number | undefined): string {
  if (typeof v !== 'number') return '--------';
  return `0x${v.toString(16).padStart(8, '0')}`;
}

function bytesEqualPrefix(a: Buffer, b: Buffer, n: number): number {
  const m = Math.min(n, a.length, b.length);
  let eq = 0;
  for (let i = 0; i < m; i++) {
    if (a[i] === b[i]) eq++;
  }
  return eq;
}

function findAsciiNeedle(haystack: Buffer, needle: string): number {
  if (!needle) return -1;
  return haystack.indexOf(Buffer.from(needle, 'ascii'));
}

function loadTranscript(path: string): Transcript {
  const raw = fs.readFileSync(path, 'utf8');
  return JSON.parse(raw) as Transcript;
}

function analyzePrefix(
  prefixHex: string,
  prefixTokens: string[],
): {
  prefixLen: number;
  u16le0: number | undefined;
  u16le1: number | undefined;
  token0: string | undefined;
  token1: string | undefined;
  token0Ok: boolean | undefined;
  token1Ok: boolean | undefined;
  derivedTailHex: string | undefined;
} {
  if (!prefixHex) {
    return {
      prefixLen: 0,
      u16le0: undefined,
      u16le1: undefined,
      token0: undefined,
      token1: undefined,
      token0Ok: undefined,
      token1Ok: undefined,
      derivedTailHex: undefined,
    };
  }
  const buf = Buffer.from(prefixHex, 'hex');
  const prefixLen = buf.length;
  const u16le0 = prefixLen >= 2 ? buf.readUInt16LE(0) : undefined;
  const u16le1 = prefixLen >= 4 ? buf.readUInt16LE(2) : undefined;

  const token0 = prefixTokens[0];
  const token1 = prefixTokens[1];

  // From observed pairing captures, the prefix is 100 bytes:
  // u16le length (100), u16le direction-ish (0 / 200)
  // token0 ASCII (28 bytes, MAC12+UID16)
  // padding 4x 0x00 (to align token0 to 32 bytes)
  // token1 ASCII (32 bytes, base62-ish)
  // tail 32 bytes binary (high-entropy)
  let derivedTailHex: string | undefined;
  let token0Ok: boolean | undefined;
  let token1Ok: boolean | undefined;

  if (prefixLen === 100 && token0 && token1) {
    const token0Buf = Buffer.from(token0, 'ascii');
    const token1Buf = Buffer.from(token1, 'ascii');

    token0Ok = buf.subarray(4, 4 + 28).equals(token0Buf);
    token1Ok = buf.subarray(4 + 32, 4 + 32 + 32).equals(token1Buf);

    const tail = buf.subarray(4 + 32 + 32);
    if (tail.length === 32) derivedTailHex = tail.toString('hex');
  }

  return {
    prefixLen,
    u16le0,
    u16le1,
    token0,
    token1,
    token0Ok,
    token1Ok,
    derivedTailHex,
  };
}

function summarizeEntry(entry: TranscriptEntry, maxRecords: number): void {
  console.log(`\n== ${entry.dirKey} ==`);
  console.log(`reassembledBytes=${entry.reassembledBytes} gaps=${entry.gaps} records=${entry.records.length}`);

  const p = analyzePrefix(entry.prefixHex, entry.prefixTokens);
  if (p.prefixLen) {
    console.log(
      `prefixLen=${p.prefixLen} u16le0=${p.u16le0} u16le1=${p.u16le1} token0Ok=${String(p.token0Ok)} token1Ok=${String(p.token1Ok)}`,
    );
    if (p.token0) console.log(`prefix.token0=${p.token0}`);
    if (p.token1) console.log(`prefix.token1=${p.token1}`);
    if (p.derivedTailHex) console.log(`prefix.tail32=${p.derivedTailHex}`);
  } else {
    console.log('prefixLen=0');
  }

  const byType = new Map<number, TranscriptRecord[]>();
  for (const r of entry.records) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }

  const typesSorted = [...byType.keys()].sort((a, b) => a - b);
  console.log(`types=[${typesSorted.join(', ')}]`);
  for (const t of typesSorted) {
    const rs = byType.get(t)!;
    const lens = [...new Set(rs.map((x) => x.len))].sort((a, b) => a - b);
    console.log(` type=${t} count=${rs.length} lens=[${lens.join(', ')}]`);
  }

  const take = entry.records.slice(0, maxRecords);
  for (const r of take) {
    const payload = Buffer.from(r.payloadB64, 'base64');
    const head = payload.subarray(0, Math.min(16, payload.length));
    const tail = payload.subarray(Math.max(0, payload.length - 16));
    const ent = shannonEntropy(payload);
    const pr = printableRatio(payload);
    const hash = sha256Hex(payload).slice(0, 16);

    const u32_0 = safeU32le(payload, 0);
    const u32_4 = safeU32le(payload, 4);
    const u32_8 = safeU32le(payload, 8);
    const u32_12 = safeU32le(payload, 12);

    const uidHit = p.token0 ? findAsciiNeedle(payload, p.token0.slice(12)) : -1; // UID is last 16 chars
    const macUidHit = p.token0 ? findAsciiNeedle(payload, p.token0) : -1;
    const token1Hit = p.token1 ? findAsciiNeedle(payload, p.token1) : -1;

    console.log(
      ` rec off=${r.streamOff} relMs=${Math.round(r.relMs)} type=${r.type} len=${r.len} sha256[:8]=${hash} ent=${ent.toFixed(2)} print=${pr.toFixed(2)} u32=[${fmtU32(u32_0)},${fmtU32(u32_4)},${fmtU32(u32_8)},${fmtU32(u32_12)}] head=${toHex(head)} tail=${toHex(tail)} hits={uid:${uidHit},macUid:${macUidHit},token1:${token1Hit}}`,
    );
  }
}

function comparePairDirections(pair: Transcript): void {
  if (pair.entries.length < 2) return;

  const a = pair.entries[0];
  const b = pair.entries[1];
  if (!a || !b) return;

  const aMap = new Map<number, TranscriptRecord>();
  const bMap = new Map<number, TranscriptRecord>();

  for (const r of a.records) aMap.set(r.type, r);
  for (const r of b.records) bMap.set(r.type, r);

  const types = [...new Set([...aMap.keys(), ...bMap.keys()])].sort((x, y) => x - y);
  console.log('\n-- PAIR direction diff (by type, first record each) --');
  console.log(`A=${a.dirKey}`);
  console.log(`B=${b.dirKey}`);
  for (const t of types) {
    const ar = aMap.get(t);
    const br = bMap.get(t);
    if (!ar || !br) {
      console.log(` type=${t} missingA=${String(!ar)} missingB=${String(!br)}`);
      continue;
    }

    const ap = Buffer.from(ar.payloadB64, 'base64');
    const bp = Buffer.from(br.payloadB64, 'base64');
    const eq16 = bytesEqualPrefix(ap, bp, 16);
    const eq32 = bytesEqualPrefix(ap, bp, 32);
    const eq64 = bytesEqualPrefix(ap, bp, 64);
    const uA0 = safeU32le(ap, 0);
    const uB0 = safeU32le(bp, 0);

    console.log(
      ` type=${t} lenA=${ar.len} lenB=${br.len} eq16=${eq16} eq32=${eq32} eq64=${eq64} u32A0=${fmtU32(uA0)} u32B0=${fmtU32(uB0)}`,
    );
  }
}

function printTimeline(label: string, t: Transcript): void {
  const events: Array<{ tsMs: number; s: string }> = [];
  for (const e of t.entries) {
    for (const r of e.records) {
      events.push({
        tsMs: r.tsMs,
        s: `TCP6666 ${e.dirKey} type=${r.type} len=${r.len}`,
      });
    }
  }

  for (const u of t.udp7777Samples ?? []) {
    const p = u.parsed;
    const meta = p
      ? `seq=${p.seq} dataLen=${p.dataLen} uid=${p.uid ?? ''} magic=${p.magicLE}`
      : '';
    events.push({
      tsMs: u.tsMs,
      s: `UDP7777 ${u.dirKey} payloadLen=${u.payloadLen} ${meta}`.trim(),
    });
  }

  events.sort((x, y) => x.tsMs - y.tsMs);
  const t0 = events[0]?.tsMs;
  if (!t0) return;

  console.log(`\n-- TIMELINE (${label}) --`);
  for (const ev of events) {
    const rel = Math.round(ev.tsMs - t0);
    console.log(` t+${rel.toString().padStart(6)}ms ${ev.s}`);
  }
}

function extractIpsFromDirKey(dirKey: string): string[] {
  // Examples:
  // - "192.168.1.139:63057 -> 192.168.1.161:6666"
  // - "192.168.1.139:64998 -> 192.168.1.161:7777"
  const ips = dirKey.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g);
  return ips ?? [];
}

function isDirKeyBetweenFocusIps(dirKey: string, focusIps: Set<string>): boolean {
  const ips = extractIpsFromDirKey(dirKey);
  if (ips.length < 2) return false;
  // Keep only if *all* IPs present are within the focus set.
  // (dirKey typically has exactly 2 IPs)
  return ips.every((ip) => focusIps.has(ip));
}

function filterTranscriptToFocusIps(t: Transcript, focusIps: Set<string>): Transcript {
  const entries = t.entries.filter((e) => isDirKeyBetweenFocusIps(e.dirKey, focusIps));
  const udp7777Samples = (t.udp7777Samples ?? []).filter((u) => isDirKeyBetweenFocusIps(u.dirKey, focusIps));
  return { ...t, entries, udp7777Samples };
}

function main(): void {
  const pairPath = env('PAIR_TRANSCRIPT_PATH', 'test/pcap/exports/pair-6666-transcript.json');
  const unpairPath = env('UNPAIR_TRANSCRIPT_PATH', 'test/pcap/exports/unpair-6666-transcript.json');
  const maxRecords = Number(env('MAX_RECORDS_PER_ENTRY', '6'));
  const focusIpsRaw = env('FOCUS_IPS', '192.168.1.161,192.168.1.139');
  const focusIps = new Set(
    (focusIpsRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

  if (!pairPath || !unpairPath) {
    throw new Error('Missing PAIR_TRANSCRIPT_PATH or UNPAIR_TRANSCRIPT_PATH');
  }

  const pair = filterTranscriptToFocusIps(loadTranscript(pairPath), focusIps);
  const unpair = filterTranscriptToFocusIps(loadTranscript(unpairPath), focusIps);

  console.log('## 6666 transcript compare');
  console.log(`pair:   ${pairPath}`);
  console.log(`unpair: ${unpairPath}`);
  console.log(`pair.pcapPath=${pair.pcapPath}`);
  console.log(`unpair.pcapPath=${unpair.pcapPath}`);
  console.log(`focusIps=[${[...focusIps].join(', ')}]`);

  console.log('\n-- PAIR --');
  for (const e of pair.entries) summarizeEntry(e, maxRecords);
  comparePairDirections(pair);
  printTimeline('PAIR', pair);

  console.log('\n-- UNPAIR --');
  for (const e of unpair.entries) summarizeEntry(e, maxRecords);
  printTimeline('UNPAIR', unpair);
}

main();
