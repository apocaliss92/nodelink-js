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

function shannonEntropy(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const counts = new Array<number>(256).fill(0);
  for (let i = 0; i < buf.length; i++) counts[buf[i]!] = (counts[buf[i]!] ?? 0) + 1;
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
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b >= 0x20 && b <= 0x7e) printable++;
  }
  return printable / buf.length;
}

function sha256_8(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function fmtHex(buf: Buffer, maxBytes: number): string {
  return buf.subarray(0, Math.min(maxBytes, buf.length)).toString('hex');
}

function parseTypesEnv(): number[] {
  const raw = env('TYPES', '0,1,2')!;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

function parseDir(entry: TranscriptEntry, hubIp: string): { srcIp: string; dstIp: string } | undefined {
  // dirKey format: "192.168.1.139:51183 -> 192.168.1.161:6666"
  const m = entry.dirKey.match(/^([^:]+):\d+\s+->\s+([^:]+):\d+$/);
  if (!m) return undefined;
  const srcIp = m[1]!;
  const dstIp = m[2]!;
  // normalize so hubIp is always one side
  if (srcIp !== hubIp && dstIp !== hubIp) return undefined;
  return { srcIp, dstIp };
}

function asciiRuns(buf: Buffer, minLen: number): Array<{ off: number; len: number; text: string }> {
  const out: Array<{ off: number; len: number; text: string }> = [];
  let runStart = -1;
  for (let i = 0; i <= buf.length; i++) {
    const b = i < buf.length ? buf[i]! : 0;
    const ok = i < buf.length && b >= 0x20 && b <= 0x7e;
    if (ok) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const len = i - runStart;
      if (len >= minLen) {
        const text = buf.subarray(runStart, i).toString('ascii');
        out.push({ off: runStart, len, text });
      }
      runStart = -1;
    }
  }
  return out;
}

function maybePkcs7Padding(buf: Buffer): { ok: boolean; pad: number } {
  if (buf.length === 0) return { ok: false, pad: 0 };
  const pad = buf[buf.length - 1]!;
  if (pad === 0 || pad > 16) return { ok: false, pad };
  if (buf.length < pad) return { ok: false, pad };
  for (let i = buf.length - pad; i < buf.length; i++) {
    if (buf[i]! !== pad) return { ok: false, pad };
  }
  return { ok: true, pad };
}

function derSequences(buf: Buffer, maxHits: number): Array<{ off: number; totalLen: number; headHex: string }> {
  const hits: Array<{ off: number; totalLen: number; headHex: string }> = [];
  for (let off = 0; off < buf.length - 2 && hits.length < maxHits; off++) {
    if (buf[off] !== 0x30) continue;
    const lenByte = buf[off + 1]!;
    let len = 0;
    let hdr = 2;
    if ((lenByte & 0x80) === 0) {
      len = lenByte;
    } else {
      const n = lenByte & 0x7f;
      if (n === 0 || n > 2) continue; // keep it simple
      if (off + 2 + n > buf.length) continue;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | buf[off + 2 + i]!;
      hdr = 2 + n;
    }
    const totalLen = hdr + len;
    if (totalLen <= 0 || off + totalLen > buf.length) continue;
    hits.push({ off, totalLen, headHex: fmtHex(buf.subarray(off, off + Math.min(totalLen, 32)), 32) });
  }
  return hits;
}

function parseDerEcdsaSignature(seq: Buffer):
  | { ok: true; r: Buffer; s: Buffer; totalLen: number }
  | { ok: false; reason: string } {
  if (seq.length < 8) return { ok: false, reason: 'too short' };
  if (seq[0] !== 0x30) return { ok: false, reason: 'not a sequence' };

  // Parse SEQUENCE length
  let off = 1;
  const lenByte = seq[off]!;
  off++;
  let len = 0;
  if ((lenByte & 0x80) === 0) {
    len = lenByte;
  } else {
    const n = lenByte & 0x7f;
    if (n === 0 || n > 2) return { ok: false, reason: 'long len unsupported' };
    if (off + n > seq.length) return { ok: false, reason: 'len overflow' };
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | seq[off + i]!;
    off += n;
  }
  const totalLen = off + len;
  if (totalLen > seq.length) return { ok: false, reason: 'seq truncated' };

  // INTEGER r
  if (seq[off] !== 0x02) return { ok: false, reason: 'missing INTEGER r' };
  off++;
  const rLen = seq[off]!;
  off++;
  if (off + rLen > totalLen) return { ok: false, reason: 'r overflow' };
  const r = seq.subarray(off, off + rLen);
  off += rLen;

  // INTEGER s
  if (seq[off] !== 0x02) return { ok: false, reason: 'missing INTEGER s' };
  off++;
  const sLen = seq[off]!;
  off++;
  if (off + sLen > totalLen) return { ok: false, reason: 's overflow' };
  const s = seq.subarray(off, off + sLen);
  off += sLen;

  if (off !== totalLen) return { ok: false, reason: 'trailing bytes' };
  return { ok: true, r, s, totalLen };
}

function parseAsn1Len(
  buf: Buffer,
  off: number,
): { len: number; lenBytes: number } | undefined {
  if (off >= buf.length) return undefined;
  const b0 = buf[off]!;
  if ((b0 & 0x80) === 0) return { len: b0, lenBytes: 1 };
  const n = b0 & 0x7f;
  if (n === 0 || n > 2) return undefined;
  if (off + 1 + n > buf.length) return undefined;
  let len = 0;
  for (let i = 0; i < n; i++) len = (len << 8) | buf[off + 1 + i]!;
  return { len, lenBytes: 1 + n };
}

function parseAsn1Tlv(
  buf: Buffer,
  off: number,
):
  | {
      tag: number;
      headerLen: number;
      len: number;
      totalLen: number;
      valOff: number;
      valEnd: number;
    }
  | undefined {
  if (off < 0 || off + 2 > buf.length) return undefined;
  const tag = buf[off]!;
  // Only handle single-byte tags; skip high-tag-number form.
  if ((tag & 0x1f) === 0x1f) return undefined;
  const l = parseAsn1Len(buf, off + 1);
  if (!l) return undefined;
  const headerLen = 1 + l.lenBytes;
  const valOff = off + headerLen;
  const valEnd = valOff + l.len;
  const totalLen = headerLen + l.len;
  if (valEnd > buf.length) return undefined;
  return { tag, headerLen, len: l.len, totalLen, valOff, valEnd };
}

function parseAsn1TlvBounded(
  buf: Buffer,
  off: number,
  end: number,
): ReturnType<typeof parseAsn1Tlv> {
  const tlv = parseAsn1Tlv(buf, off);
  if (!tlv) return undefined;
  if (tlv.valEnd > end) return undefined;
  return tlv;
}

function decodeOid(oidBytes: Buffer): string | undefined {
  if (!oidBytes.length) return undefined;
  const first = oidBytes[0]!;
  const parts: number[] = [Math.floor(first / 40), first % 40];
  let v = 0;
  for (let i = 1; i < oidBytes.length; i++) {
    const b = oidBytes[i]!;
    v = (v << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

function collectOidsInRegion(
  buf: Buffer,
  start: number,
  end: number,
  depth: number,
  maxNodes: number,
  out: string[],
): number {
  if (depth <= 0) return 0;
  let nodes = 0;
  let off = start;
  while (off < end && nodes < maxNodes) {
    const tlv = parseAsn1TlvBounded(buf, off, end);
    if (!tlv) break;
    nodes++;
    if (tlv.tag === 0x06) {
      const oid = decodeOid(buf.subarray(tlv.valOff, tlv.valEnd));
      if (oid) out.push(oid);
    }
    const isConstructed = (tlv.tag & 0x20) !== 0;
    if (isConstructed) {
      nodes += collectOidsInRegion(buf, tlv.valOff, tlv.valEnd, depth - 1, maxNodes - nodes, out);
    }
    off += tlv.totalLen;
  }
  return nodes;
}

function asn1SequenceHits(
  buf: Buffer,
  maxHits: number,
): Array<{
  off: number;
  totalLen: number;
  oids: string[];
  ecdsaSig: boolean;
  headHex: string;
  childTags: string;
}> {
  const hits: Array<{
    off: number;
    totalLen: number;
    oids: string[];
    ecdsaSig: boolean;
    headHex: string;
    childTags: string;
  }> = [];
  for (let off = 0; off < buf.length - 2 && hits.length < maxHits; off++) {
    if (buf[off] !== 0x30) continue;
    const tlv = parseAsn1Tlv(buf, off);
    if (!tlv) continue;
    const seq = buf.subarray(off, off + tlv.totalLen);
    const sig = parseDerEcdsaSignature(seq);
    const oids: string[] = [];
    collectOidsInRegion(buf, tlv.valOff, tlv.valEnd, 4, 300, oids);

    // Summarize immediate children tags/lengths (best-effort)
    const kids: string[] = [];
    let childOff = tlv.valOff;
    for (let i = 0; i < 8 && childOff < tlv.valEnd; i++) {
      const c = parseAsn1TlvBounded(buf, childOff, tlv.valEnd);
      if (!c) {
        kids.push('??');
        break;
      }
      kids.push(`0x${c.tag.toString(16).padStart(2, '0')}:${c.len}`);
      childOff += c.totalLen;
    }

    hits.push({
      off,
      totalLen: tlv.totalLen,
      oids: [...new Set(oids)],
      ecdsaSig: sig.ok,
      headHex: fmtHex(seq, 32),
      childTags: kids.join(', '),
    });
  }
  return hits;
}

function asn1OctetStringHits(
  buf: Buffer,
  maxHits: number,
): Array<{ off: number; totalLen: number; len: number; headHex: string }> {
  const hits: Array<{ off: number; totalLen: number; len: number; headHex: string }> = [];
  for (let off = 0; off < buf.length - 2 && hits.length < maxHits; off++) {
    if (buf[off] !== 0x04) continue;
    const tlv = parseAsn1Tlv(buf, off);
    if (!tlv) continue;
    // Avoid tiny noise hits.
    if (tlv.len < 32) continue;
    const slice = buf.subarray(off, off + tlv.totalLen);
    hits.push({ off, totalLen: tlv.totalLen, len: tlv.len, headHex: fmtHex(slice, 32) });
  }
  return hits;
}

function blocks16Stats(buf: Buffer): { blocks: number; unique: number; topRepeat: number } {
  const blocks = Math.floor(buf.length / 16);
  if (!blocks) return { blocks: 0, unique: 0, topRepeat: 0 };
  const map = new Map<string, number>();
  for (let i = 0; i < blocks; i++) {
    const key = buf.subarray(i * 16, i * 16 + 16).toString('hex');
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  let topRepeat = 0;
  for (const v of map.values()) topRepeat = Math.max(topRepeat, v);
  return { blocks, unique: map.size, topRepeat };
}

function xorHex(a: Buffer, b: Buffer, n: number): string {
  const m = Math.min(n, a.length, b.length);
  const out = Buffer.alloc(m);
  for (let i = 0; i < m; i++) out[i] = (a[i]! ^ b[i]!) & 0xff;
  return out.toString('hex');
}

function commonPrefixLen(a: Buffer, b: Buffer): number {
  const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i++) {
    if (a[i] !== b[i]) return i;
  }
  return m;
}

function commonSuffixLen(a: Buffer, b: Buffer): number {
  const m = Math.min(a.length, b.length);
  for (let i = 1; i <= m; i++) {
    if (a[a.length - i] !== b[b.length - i]) return i - 1;
  }
  return m;
}

function countNonZeroBytes(hex: string): { nonZero: number; total: number; positions: number[] } {
  const buf = Buffer.from(hex, 'hex');
  const positions: number[] = [];
  let nonZero = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) {
      nonZero++;
      positions.push(i);
    }
  }
  return { nonZero, total: buf.length, positions };
}

function sliceTail(buf: Buffer, n: number): Buffer {
  return buf.subarray(Math.max(0, buf.length - n));
}

function sliceHead(buf: Buffer, n: number): Buffer {
  return buf.subarray(0, Math.min(n, buf.length));
}

function isPrefixOf(shorter: Buffer, longer: Buffer): boolean {
  if (shorter.length > longer.length) return false;
  return longer.subarray(0, shorter.length).equals(shorter);
}

function isSuffixOf(shorter: Buffer, longer: Buffer): boolean {
  if (shorter.length > longer.length) return false;
  return longer.subarray(longer.length - shorter.length).equals(shorter);
}

function equalBytesAtSameOffsets(a: Buffer, b: Buffer): number {
  const m = Math.min(a.length, b.length);
  let eq = 0;
  for (let i = 0; i < m; i++) if (a[i] === b[i]) eq++;
  return eq;
}

function blocksEqual16AtSameOffsets(a: Buffer, b: Buffer): { blocks: number; eqBlocks: number } {
  const m = Math.min(a.length, b.length);
  const blocks = Math.floor(m / 16);
  let eqBlocks = 0;
  for (let i = 0; i < blocks; i++) {
    const aa = a.subarray(i * 16, i * 16 + 16);
    const bb = b.subarray(i * 16, i * 16 + 16);
    if (aa.equals(bb)) eqBlocks++;
  }
  return { blocks, eqBlocks };
}

function findU16leMatches(buf: Buffer, values: number[], maxHits: number): Array<{ off: number; v: number }> {
  const hits: Array<{ off: number; v: number }> = [];
  const set = new Set(values);
  for (let off = 0; off + 2 <= buf.length && hits.length < maxHits; off++) {
    const v = buf.readUInt16LE(off);
    if (set.has(v)) hits.push({ off, v });
  }
  return hits;
}

function findU32leMatches(buf: Buffer, values: number[], maxHits: number): Array<{ off: number; v: number }> {
  const hits: Array<{ off: number; v: number }> = [];
  const set = new Set(values);
  for (let off = 0; off + 4 <= buf.length && hits.length < maxHits; off++) {
    const v = buf.readUInt32LE(off);
    if (set.has(v)) hits.push({ off, v });
  }
  return hits;
}

function xorWithMask16(h: Buffer, maskHex: string): Buffer {
  const mask = Buffer.from(maskHex, 'hex');
  const out = Buffer.alloc(Math.min(16, h.length));
  for (let i = 0; i < out.length; i++) out[i] = (h[i]! ^ mask[i]!) & 0xff;
  return out;
}

function bytesNotEqualPositions(a: Buffer, b: Buffer, n: number, maxShow: number): number[] {
  const m = Math.min(n, a.length, b.length);
  const pos: number[] = [];
  for (let i = 0; i < m; i++) {
    if (a[i] !== b[i]) {
      pos.push(i);
      if (pos.length >= maxShow) break;
    }
  }
  return pos;
}

function analyzeType0(cam: Buffer, hub: Buffer): void {
  const maskHex = '0100000000000000c000000000000000';

  const camHead16 = sliceHead(cam, 16);
  const hubHead16 = sliceHead(hub, 16);
  const camNorm = xorWithMask16(camHead16, maskHex);
  const hubNorm = xorWithMask16(hubHead16, maskHex);

  console.log('  -- type=0 extra --');
  console.log(`  mask16=${maskHex}`);
  console.log(`  camHead16=${camHead16.toString('hex')}`);
  console.log(`  hubHead16=${hubHead16.toString('hex')}`);
  console.log(`  camHead16^mask=${camNorm.toString('hex')}`);
  console.log(`  hubHead16^mask=${hubNorm.toString('hex')}`);
  console.log(`  camHead16^mask == hubHead16 ? ${camNorm.equals(hubHead16) ? 'YES' : 'NO'}`);
  console.log(`  hubHead16^mask == camHead16 ? ${hubNorm.equals(camHead16) ? 'YES' : 'NO'}`);

  const camBody = cam.subarray(16);
  const hubBody = hub.subarray(16);

  const camBodyPad = maybePkcs7Padding(camBody);
  const hubBodyPad = maybePkcs7Padding(hubBody);
  const camBodyBlocks = blocks16Stats(camBody);
  const hubBodyBlocks = blocks16Stats(hubBody);
  const camAligned16 = camBody.length % 16 === 0;
  const hubAligned16 = hubBody.length % 16 === 0;
  const camAligned32 = camBody.length % 32 === 0;
  const hubAligned32 = hubBody.length % 32 === 0;

  // Heuristic: does the shorter message match prefix/suffix of the longer (after header)?
  const shorterBody = camBody.length <= hubBody.length ? camBody : hubBody;
  const longerBody = camBody.length <= hubBody.length ? hubBody : camBody;
  console.log(
    `  bodyLens cam=${camBody.length} hub=${hubBody.length} shorterIsPrefix=${isPrefixOf(shorterBody, longerBody)} shorterIsSuffix=${isSuffixOf(shorterBody, longerBody)}`,
  );

  console.log(
    `  bodyAlign: cam%16=${camAligned16 ? 'yes' : 'no'} cam%32=${camAligned32 ? 'yes' : 'no'} hub%16=${hubAligned16 ? 'yes' : 'no'} hub%32=${hubAligned32 ? 'yes' : 'no'}`,
  );
  console.log(
    `  bodyBlocks16: cam blocks=${camBodyBlocks.blocks} unique=${camBodyBlocks.unique} topRepeat=${camBodyBlocks.topRepeat} hub blocks=${hubBodyBlocks.blocks} unique=${hubBodyBlocks.unique} topRepeat=${hubBodyBlocks.topRepeat}`,
  );
  console.log(
    `  bodyPkcs7: cam=${camBodyPad.ok ? `yes(pad=${camBodyPad.pad})` : 'no'} hub=${hubBodyPad.ok ? `yes(pad=${hubBodyPad.pad})` : 'no'}`,
  );

  // Segment stats: if there's (nonce||ciphertext||tag), head/mid/tail might differ.
  for (const seg of [
    { label: 'head32', cam: sliceHead(camBody, 32), hub: sliceHead(hubBody, 32) },
    {
      label: 'mid32',
      cam: camBody.subarray(Math.max(0, Math.floor(camBody.length / 2) - 16), Math.min(camBody.length, Math.floor(camBody.length / 2) + 16)),
      hub: hubBody.subarray(Math.max(0, Math.floor(hubBody.length / 2) - 16), Math.min(hubBody.length, Math.floor(hubBody.length / 2) + 16)),
    },
    { label: 'tail32', cam: sliceTail(camBody, 32), hub: sliceTail(hubBody, 32) },
  ]) {
    console.log(
      `  seg.${seg.label}: cam.ent=${shannonEntropy(seg.cam).toFixed(3)} hub.ent=${shannonEntropy(seg.hub).toFixed(3)} cam.ascii=${printableRatio(seg.cam).toFixed(3)} hub.ascii=${printableRatio(seg.hub).toFixed(3)}`,
    );
  }

  // Candidate tag lengths at tail of body
  for (const n of [8, 12, 16, 24, 32]) {
    const camTag = sliceTail(camBody, n);
    const hubTag = sliceTail(hubBody, n);
    const xor = xorHex(camTag, hubTag, n);
    const nz = countNonZeroBytes(xor);
    console.log(
      `  tailTag${n}: cam.ent=${shannonEntropy(camTag).toFixed(3)} hub.ent=${shannonEntropy(hubTag).toFixed(3)} xor.nz=${nz.nonZero}/${nz.total}`,
    );
  }

  // Look for embedded length fields near the start (full payload + body lengths)
  const interesting = [
    cam.length,
    hub.length,
    camBody.length,
    hubBody.length,
    0,
    1,
    2,
    4,
    8,
    16,
    32,
    64,
    96,
    112,
    128,
    160,
    192,
    208,
    240,
    256,
  ];

  const camHead64 = sliceHead(cam, 64);
  const hubHead64 = sliceHead(hub, 64);
  const camU16 = findU16leMatches(camHead64, interesting, 12);
  const hubU16 = findU16leMatches(hubHead64, interesting, 12);
  const camU32 = findU32leMatches(camHead64, interesting, 12);
  const hubU32 = findU32leMatches(hubHead64, interesting, 12);

  console.log(
    `  u16le matches (first64): cam=[${camU16.map((h) => `@${h.off}=${h.v}`).join(' ')}] hub=[${hubU16
      .map((h) => `@${h.off}=${h.v}`)
      .join(' ')}]`,
  );
  console.log(
    `  u32le matches (first64): cam=[${camU32.map((h) => `@${h.off}=${h.v}`).join(' ')}] hub=[${hubU32
      .map((h) => `@${h.off}=${h.v}`)
      .join(' ')}]`,
  );

  // Where do bytes differ early on? (after header)
  const camBodyHead64 = sliceHead(camBody, 64);
  const hubBodyHead64 = sliceHead(hubBody, 64);
  const diffPos = bytesNotEqualPositions(camBodyHead64, hubBodyHead64, 64, 24);
  console.log(`  bodyHead64 diff positions (first24): [${diffPos.join(',')}]`);
}

function main(): void {
  const transcriptPath = env('TRANSCRIPT') ?? 'test/pcap/exports/hub_pairing_192.168.1.139_2-6666-transcript.json';
  const hubIp = env('HUB_IP', '192.168.1.161')!;
  const camIp = env('CAM_IP');
  const types = parseTypesEnv();
  const deepCompare = env('DEEP_COMPARE', '1') === '1';

  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const t = JSON.parse(raw) as Transcript;

  console.log('## 6666 pairing 0/1/2 payload scan');
  console.log(`transcript=${transcriptPath}`);
  console.log(`pcap=${t.pcapPath}`);
  console.log(`hubIp=${hubIp} camIp=${camIp ?? '(any)'} types=[${types.join(', ')}]`);

  const relevantEntries: Array<{ entry: TranscriptEntry; dir: { srcIp: string; dstIp: string } }> = [];
  for (const entry of t.entries) {
    const dir = parseDir(entry, hubIp);
    if (!dir) continue;
    if (camIp && dir.srcIp !== camIp && dir.dstIp !== camIp) continue;
    relevantEntries.push({ entry, dir });
  }

  if (!relevantEntries.length) {
    console.log('No matching entries. Check HUB_IP/CAM_IP/TRANSCRIPT.');
    return;
  }

  // index first record payload per (type, direction)
  const firstByKey = new Map<string, Buffer>();

  for (const { entry, dir } of relevantEntries) {
    const directionLabel = dir.srcIp === hubIp ? 'hub->cam' : 'cam->hub';
    console.log(`\n== ${entry.dirKey} (${directionLabel}) ==`);
    for (const r of entry.records) {
      if (!types.includes(r.type)) continue;
      const payload = Buffer.from(r.payloadB64, 'base64');
      const head32 = payload.subarray(0, Math.min(32, payload.length));
      const tail32 = payload.subarray(Math.max(0, payload.length - 32));

      const ent = shannonEntropy(payload);
      const pr = printableRatio(payload);
      const pad = maybePkcs7Padding(payload);
      const b16 = blocks16Stats(payload);
      const seqHits = asn1SequenceHits(payload, 3);
      const octets = asn1OctetStringHits(payload, 3);
      const runs = asciiRuns(payload, 12).slice(0, 3);

      console.log(
        `type=${r.type} len=${payload.length} relMs=${r.relMs.toFixed(1)} ent=${ent.toFixed(3)} ascii=${pr.toFixed(3)} sha256_8=${sha256_8(payload)}`,
      );
      console.log(` head32=${head32.toString('hex')}`);
      console.log(` tail32=${tail32.toString('hex')}`);
      console.log(
        ` blocks16=${b16.blocks} unique16=${b16.unique} topRepeat16=${b16.topRepeat} pkcs7=${pad.ok ? `yes(pad=${pad.pad})` : 'no'}`,
      );

      if (seqHits.length) {
        console.log(
          ` ASN.1 SEQUENCE hits: ${seqHits
            .map((h) =>
              `@${h.off} len=${h.totalLen} kids=[${h.childTags}] ecdsaSig=${h.ecdsaSig ? 'yes' : 'no'} oids=[${h.oids.join(',') || ''}] head=${h.headHex}`,
            )
            .join(' | ')}`,
        );
      }
      if (octets.length) {
        console.log(
          ` ASN.1 OCTET STRING hits: ${octets.map((h) => `@${h.off} len=${h.len} total=${h.totalLen} head=${h.headHex}`).join(' | ')}`,
        );
      }
      if (runs.length) console.log(` ASCII runs: ${runs.map((h) => `@${h.off} len=${h.len} "${h.text}"`).join(' | ')}`);

      const key = `${directionLabel}:type=${r.type}`;
      if (!firstByKey.has(key)) firstByKey.set(key, payload);
    }
  }

  // Cross-direction XOR on head16/head32 when both present
  console.log('\n== Cross-direction XOR (first record per type) ==');
  for (const type of types) {
    const cam = firstByKey.get(`cam->hub:type=${type}`);
    const hub = firstByKey.get(`hub->cam:type=${type}`);
    if (!cam || !hub) continue;
    console.log(`type=${type} xorHead16=${xorHex(cam, hub, 16)} xorHead32=${xorHex(cam, hub, 32)}`);
  }

  if (deepCompare) {
    console.log('\n== Deep compare (first record per type, cam<->hub) ==');
    for (const type of types) {
      const cam = firstByKey.get(`cam->hub:type=${type}`);
      const hub = firstByKey.get(`hub->cam:type=${type}`);
      if (!cam || !hub) continue;

      const minLen = Math.min(cam.length, hub.length);
      const maxLen = Math.max(cam.length, hub.length);
      const prefix = commonPrefixLen(cam, hub);
      const suffix = commonSuffixLen(cam, hub);
      const eqBytes = equalBytesAtSameOffsets(cam, hub);
      const b16 = blocksEqual16AtSameOffsets(cam, hub);

      const xorH16 = xorHex(cam, hub, 16);
      const xorT16 = xorHex(sliceTail(cam, 16), sliceTail(hub, 16), 16);
      const h16nz = countNonZeroBytes(xorH16);

      const shorter = cam.length <= hub.length ? cam : hub;
      const longer = cam.length <= hub.length ? hub : cam;

      console.log(
        `type=${type} lens cam=${cam.length} hub=${hub.length} min=${minLen} max=${maxLen} prefixEq=${prefix} suffixEq=${suffix} eqBytes=${eqBytes}/${minLen} eqBlocks16=${b16.eqBlocks}/${b16.blocks}`,
      );
      console.log(
        ` head16.xor=${xorH16} nonZero=${h16nz.nonZero}/${h16nz.total} pos=[${h16nz.positions.join(',')}] tail16.xor=${xorT16}`,
      );
      console.log(
        ` shorterIsPrefix=${isPrefixOf(shorter, longer)} shorterIsSuffix=${isSuffixOf(shorter, longer)} camHead16=${sliceHead(cam, 16).toString('hex')} hubHead16=${sliceHead(hub, 16).toString('hex')}`,
      );
      console.log(
        ` camTail16=${sliceTail(cam, 16).toString('hex')} hubTail16=${sliceTail(hub, 16).toString('hex')}`,
      );
      console.log(
        ` tailEntropy16 cam=${shannonEntropy(sliceTail(cam, 16)).toFixed(3)} hub=${shannonEntropy(sliceTail(hub, 16)).toFixed(3)} tailAscii16 cam=${printableRatio(sliceTail(cam, 16)).toFixed(3)} hub=${printableRatio(sliceTail(hub, 16)).toFixed(3)}`,
      );

      if (type === 0) analyzeType0(cam, hub);
    }
  }
}

main();
