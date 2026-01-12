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

function parseEndpoints(dirKey: string): { srcIp?: string; dstIp?: string } {
  const m = dirKey.match(/(\d{1,3}(?:\.\d{1,3}){3}):\d+\s*->\s*(\d{1,3}(?:\.\d{1,3}){3}):\d+/);
  if (!m) return {};
  const out: { srcIp?: string; dstIp?: string } = {};
  if (m[1]) out.srcIp = m[1];
  if (m[2]) out.dstIp = m[2];
  return out;
}

function xor16(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = ((a[i] ?? 0) ^ (b[i] ?? 0)) & 0xff;
  return out;
}

function commonPrefixLen(a: Buffer, b: Buffer): number {
  const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i++) if (a[i] !== b[i]) return i;
  return m;
}

function commonSuffixLen(a: Buffer, b: Buffer): number {
  const m = Math.min(a.length, b.length);
  for (let i = 1; i <= m; i++) if (a[a.length - i] !== b[b.length - i]) return i - 1;
  return m;
}

function eqBytesAtSameOffsets(a: Buffer, b: Buffer): number {
  const m = Math.min(a.length, b.length);
  let eq = 0;
  for (let i = 0; i < m; i++) if (a[i] === b[i]) eq++;
  return eq;
}

function sliceHead(buf: Buffer, n: number): Buffer {
  return buf.subarray(0, Math.min(n, buf.length));
}

function sliceTail(buf: Buffer, n: number): Buffer {
  return buf.subarray(Math.max(0, buf.length - n));
}

function summarizeConstants(buffers: Buffer[], startOff: number): { offsets: number; examples: Array<{ off: number; hex: string }> } {
  const minLen = Math.min(...buffers.map((b) => b.length));
  let offsets = 0;
  const examples: Array<{ off: number; hex: string }> = [];
  for (let off = startOff; off < minLen; off++) {
    const v0 = buffers[0]![off]!;
    let allSame = true;
    for (let i = 1; i < buffers.length; i++) {
      if (buffers[i]![off] !== v0) {
        allSame = false;
        break;
      }
    }
    if (allSame) {
      offsets++;
      if (examples.length < 16) examples.push({ off, hex: v0.toString(16).padStart(2, '0') });
    }
  }
  return { offsets, examples };
}

type PayloadInfo = {
  name: string;
  transcript: string;
  pcapPath: string;
  dirLabel: 'cam->hub' | 'hub->cam';
  payload: Buffer;
};

function loadType0(
  transcriptPath: string,
  hubIp: string,
  camIp: string,
  dirLabel: 'cam->hub' | 'hub->cam',
): PayloadInfo {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const t = JSON.parse(raw) as Transcript;

  const src = dirLabel === 'cam->hub' ? camIp : hubIp;
  const dst = dirLabel === 'cam->hub' ? hubIp : camIp;

  const entry = t.entries.find((e) => {
    const ep = parseEndpoints(e.dirKey);
    return ep.srcIp === src && ep.dstIp === dst;
  });

  if (!entry) throw new Error(`No entry for ${src} -> ${dst} in ${transcriptPath}`);
  const rec = entry.records.find((r) => r.type === 0);
  if (!rec) throw new Error(`No record type=0 for ${src} -> ${dst} in ${transcriptPath}`);

  const payload = Buffer.from(rec.payloadB64, 'base64');
  return {
    name: `${dirLabel} ${payload.length}B`,
    transcript: transcriptPath,
    pcapPath: t.pcapPath,
    dirLabel,
    payload,
  };
}

function pairwiseReport(items: PayloadInfo[], title: string, startOff: number): void {
  console.log(`\n== ${title} ==`);
  for (const it of items) {
    const head16 = sliceHead(it.payload, 16);
    console.log(`- ${it.transcript}`);
    console.log(`  pcap=${it.pcapPath}`);
    console.log(`  payloadLen=${it.payload.length} head16=${head16.toString('hex')} tail16=${sliceTail(it.payload, 16).toString('hex')}`);
  }

  const mask = Buffer.from('0100000000000000c000000000000000', 'hex');
  console.log('\nPairwise comparisons:');
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      const minLen = Math.min(a.payload.length, b.payload.length);
      const prefix = commonPrefixLen(a.payload, b.payload);
      const suffix = commonSuffixLen(a.payload, b.payload);
      const eq = eqBytesAtSameOffsets(a.payload, b.payload);

      const aH = sliceHead(a.payload, 16);
      const bH = sliceHead(b.payload, 16);
      const aN = xor16(aH, mask);
      const bN = xor16(bH, mask);

      const eqHead16 = aH.equals(bH);
      const eqHead16Norm = aN.equals(bN);

      const aBody = a.payload.subarray(16);
      const bBody = b.payload.subarray(16);
      const minBody = Math.min(aBody.length, bBody.length);
      const eqBody = eqBytesAtSameOffsets(aBody, bBody);
      const prefixBody = commonPrefixLen(aBody, bBody);
      const suffixBody = commonSuffixLen(aBody, bBody);

      console.log(
        `- [${i} vs ${j}] minLen=${minLen} prefixEq=${prefix} suffixEq=${suffix} eqBytes=${eq}/${minLen} head16Equal=${eqHead16 ? 'YES' : 'NO'} head16NormEqual=${eqHead16Norm ? 'YES' : 'NO'}`,
      );
      console.log(
        `           body(min=${minBody}) prefixEq=${prefixBody} suffixEq=${suffixBody} eqBytes=${eqBody}/${minBody} (startOff=${startOff})`,
      );
    }
  }

  const bufs = items.map((x) => x.payload);
  const constantsAll = summarizeConstants(bufs, startOff);
  console.log(`\nConstants across ALL sessions (same byte at same offset, offset>=${startOff}): ${constantsAll.offsets}`);
  if (constantsAll.examples.length) {
    console.log(`Examples: ${constantsAll.examples.map((e) => `@${e.off}=0x${e.hex}`).join(' ')}`);
  }
}

function main(): void {
  const hubIp = env('HUB_IP', '192.168.1.161')!;
  const camIp = env('CAM_IP', '192.168.1.139')!;

  const transcriptsRaw = env(
    'TRANSCRIPTS',
    [
      'test/pcap/exports/hub_pairing_192.168.1.139_2-6666-transcript.json',
      'test/pcap/exports/hub_pairing_192.168.1.139_3-6666-transcript.json',
      'test/pcap/exports/pair-6666-transcript.json',
    ].join(','),
  )!;

  const transcripts = transcriptsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const startOff = Number(env('START_OFF', '16')!); // default: skip the known directional header

  console.log('## 6666 type=0 cross-session');
  console.log(`hubIp=${hubIp} camIp=${camIp}`);
  console.log(`transcripts=[${transcripts.join(', ')}]`);
  console.log(`START_OFF=${startOff}`);

  const camToHub = transcripts.map((p) => loadType0(p, hubIp, camIp, 'cam->hub'));
  const hubToCam = transcripts.map((p) => loadType0(p, hubIp, camIp, 'hub->cam'));

  pairwiseReport(camToHub, 'cam->hub', startOff);
  pairwiseReport(hubToCam, 'hub->cam', startOff);

  // Compare normalized head16 across all sessions (within a direction)
  const mask = Buffer.from('0100000000000000c000000000000000', 'hex');
  const camHeadsNorm = camToHub.map((x) => xor16(sliceHead(x.payload, 16), mask));
  const hubHeadsNorm = hubToCam.map((x) => xor16(sliceHead(x.payload, 16), mask));

  const camHeadConst = summarizeConstants(camHeadsNorm, 0);
  const hubHeadConst = summarizeConstants(hubHeadsNorm, 0);

  console.log('\n== Normalized head16 stability (within direction) ==');
  console.log(`cam->hub head16^mask constant-bytes=${camHeadConst.offsets}/16`);
  if (camHeadConst.examples.length) console.log(` cam examples: ${camHeadConst.examples.map((e) => `@${e.off}=0x${e.hex}`).join(' ')}`);
  console.log(`hub->cam head16^mask constant-bytes=${hubHeadConst.offsets}/16`);
  if (hubHeadConst.examples.length) console.log(` hub examples: ${hubHeadConst.examples.map((e) => `@${e.off}=0x${e.hex}`).join(' ')}`);
}

main();
