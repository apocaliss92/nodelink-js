import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

function parseEnvTypeList(name: string): number[] | undefined {
  const raw = env(name);
  if (!raw) return undefined;
  const out = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  return out.length ? out : undefined;
}

function sha256Short(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
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
    if (c === 0) continue;
    const p = c / buf.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function extractIpsFromDirKey(dirKey: string): string[] {
  const ips = dirKey.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g);
  return ips ?? [];
}

function parseDirKeyEndpoints(dirKey: string): { srcIp: string | undefined; dstIp: string | undefined } {
  const m = dirKey.match(
    /(\d{1,3}(?:\.\d{1,3}){3}):\d+\s*->\s*(\d{1,3}(?:\.\d{1,3}){3}):\d+/,
  );
  if (!m) return { srcIp: undefined, dstIp: undefined };
  return { srcIp: m[1], dstIp: m[2] };
}

function normalizeDirKey(dirKey: string, hubIp: string, camIp: string): string {
  const { srcIp, dstIp } = parseDirKeyEndpoints(dirKey);
  if (srcIp === camIp && dstIp === hubIp) return `${camIp} -> ${hubIp} (cam->hub)`;
  if (srcIp === hubIp && dstIp === camIp) return `${hubIp} -> ${camIp} (hub->cam)`;
  return dirKey;
}

function isEntryBetweenIps(entry: TranscriptEntry, focusIps: Set<string>): boolean {
  const ips = extractIpsFromDirKey(entry.dirKey);
  if (ips.length < 2) return false;
  return ips.every((ip) => focusIps.has(ip));
}

function pickBestEntry(entries: TranscriptEntry[], focusIps: Set<string>): TranscriptEntry | undefined {
  const relevant = entries.filter((e) => isEntryBetweenIps(e, focusIps));
  if (relevant.length === 0) return undefined;
  // Prefer one with prefix (pairing), then most records/bytes
  relevant.sort((a, b) => {
    const ap = a.prefixHex.length ? 1 : 0;
    const bp = b.prefixHex.length ? 1 : 0;
    if (ap !== bp) return bp - ap;
    if (a.records.length !== b.records.length) return b.records.length - a.records.length;
    return b.reassembledBytes - a.reassembledBytes;
  });
  return relevant[0];
}

function commonPrefixLen(buffers: Buffer[]): number {
  if (buffers.length === 0) return 0;
  let n = Math.min(...buffers.map((b) => b.length));
  for (let i = 0; i < n; i++) {
    const v = buffers[0]![i];
    for (let j = 1; j < buffers.length; j++) {
      if (buffers[j]![i] !== v) return i;
    }
  }
  return n;
}

function commonSuffixLen(buffers: Buffer[]): number {
  if (buffers.length === 0) return 0;
  let n = Math.min(...buffers.map((b) => b.length));
  for (let i = 1; i <= n; i++) {
    const v = buffers[0]![buffers[0]!.length - i];
    for (let j = 1; j < buffers.length; j++) {
      const bj = buffers[j]!;
      if (bj[bj.length - i] !== v) return i - 1;
    }
  }
  return n;
}

function equalCountAtOffsets(buffers: Buffer[], max: number): number {
  if (buffers.length === 0) return 0;
  const n = Math.min(max, ...buffers.map((b) => b.length));
  let eq = 0;
  for (let i = 0; i < n; i++) {
    const v = buffers[0]![i];
    let allEq = true;
    for (let j = 1; j < buffers.length; j++) {
      if (buffers[j]![i] !== v) {
        allEq = false;
        break;
      }
    }
    if (allEq) eq++;
  }
  return eq;
}

function equalCountPairwiseAtOffsets(a: Buffer, b: Buffer, max: number): number {
  const n = Math.min(max, a.length, b.length);
  let eq = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) eq++;
  return eq;
}

function buffersEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sliceEquals(a: Buffer, b: Buffer, mode: 'prefix' | 'suffix'): boolean {
  if (b.length > a.length) return false;
  const slice = mode === 'prefix' ? a.subarray(0, b.length) : a.subarray(a.length - b.length);
  return buffersEqual(slice, b);
}

function xorMaskFirstN(a: Buffer, b: Buffer, n: number): Buffer {
  const out = Buffer.alloc(Math.min(n, a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

function isExpectedType0DirectionMask(mask16: Buffer): boolean {
  if (mask16.length < 16) return false;
  if (mask16[0] !== 0x01) return false;
  if (mask16[8] !== 0xc0) return false;
  for (let i = 0; i < 16; i++) {
    if (i === 0 || i === 8) continue;
    if (mask16[i] !== 0x00) return false;
  }
  return true;
}

function countNonZeroBytes(buf: Buffer): number {
  let c = 0;
  for (const b of buf) if (b !== 0) c++;
  return c;
}

function loadTranscript(p: string): Transcript {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw) as Transcript;
}

function fileLabel(p: string): string {
  return path.basename(p);
}

type SessionView = {
  label: string;
  pcapPath: string;
  entries: TranscriptEntry[];
  bestEntry: TranscriptEntry | undefined;
};

function summarizePrefix(sessions: SessionView[]): void {
  console.log('\n-- Prefix summary (best entry each transcript) --');
  for (const s of sessions) {
    const e = s.bestEntry;
    if (!e) {
      console.log(` ${s.label}: entry=none`);
      continue;
    }
    const prefixLen = e.prefixHex.length ? Buffer.from(e.prefixHex, 'hex').length : 0;
    const token0 = e.prefixTokens[0];
    const token1 = e.prefixTokens[1];
    const tail32 = prefixLen >= 32 ? Buffer.from(e.prefixHex, 'hex').subarray(prefixLen - 32).toString('hex') : '';
    console.log(` ${s.label}: prefixLen=${prefixLen} token0=${token0 ?? ''} token1=${token1 ?? ''} tail32=${tail32}`);
  }
}

function summarizeTypes(sessions: SessionView[]): void {
  const hubIp = env('HUB_IP', '192.168.1.161') ?? '192.168.1.161';
  const camIp = env('CAM_IP');
  if (!camIp) {
    console.log('Missing CAM_IP env; cannot normalize directions across sessions');
    return;
  }

  const onlyTypes = parseEnvTypeList('ONLY_TYPES');

  // First: print per-session type sets (helps when flows differ and there is no overlap).
  const perSessionDirs = new Map<
    string,
    Map<string, { typesInOrder: number[]; recordCount: number; reassembledBytes: number }>
  >();
  for (const s of sessions) {
    const dirs = new Map<string, { typesInOrder: number[]; recordCount: number; reassembledBytes: number }>();
    for (const e of s.entries) {
      const normDir = normalizeDirKey(e.dirKey, hubIp, camIp);
      const seen = new Set<number>();
      const typesInOrder: number[] = [];
      for (const r of e.records) {
        if (!seen.has(r.type)) {
          seen.add(r.type);
          typesInOrder.push(r.type);
        }
      }
      dirs.set(normDir, { typesInOrder, recordCount: e.records.length, reassembledBytes: e.reassembledBytes });
    }
    perSessionDirs.set(s.label, dirs);
  }

  console.log('\n-- Type sets (per transcript, per direction) --');
  for (const s of sessions) {
    const dirs = perSessionDirs.get(s.label) ?? new Map();
    if (dirs.size === 0) {
      console.log(` ${s.label}: (no entries between focusIps)`);
      continue;
    }
    console.log(` ${s.label}:`);
    for (const [dir, info] of [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(
        `  - ${dir}: records=${info.recordCount} bytes=${info.reassembledBytes} types=[${info.typesInOrder.join(', ')}]`,
      );
    }
  }

  function intersectTypeSets(directionKey: string): number[] {
    const sets: Array<Set<number>> = [];
    for (const s of sessions) {
      const dirs = perSessionDirs.get(s.label);
      const info = dirs?.get(directionKey);
      if (!info) continue;
      sets.push(new Set(info.typesInOrder));
    }
    if (sets.length === 0) return [];
    const out: number[] = [];
    const base = [...sets[0]!];
    for (const t of base) {
      if (sets.every((st) => st.has(t))) out.push(t);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  const camToHubKey = `${camIp} -> ${hubIp} (cam->hub)`;
  const hubToCamKey = `${hubIp} -> ${camIp} (hub->cam)`;
  const iCamHub = intersectTypeSets(camToHubKey);
  const iHubCam = intersectTypeSets(hubToCamKey);
  console.log(`\n-- Type intersection across sessions --`);
  console.log(` ${camToHubKey}: [${iCamHub.join(', ')}]`);
  console.log(` ${hubToCamKey}: [${iHubCam.join(', ')}]`);

  // Intra-session compare: for each transcript, compare cam->hub vs hub->cam for the same type.
  console.log(`\n-- Intra-session cam<->hub similarity (same type) --`);
  for (const s of sessions) {
    const camEntry = s.entries.find((e) => normalizeDirKey(e.dirKey, hubIp, camIp) === camToHubKey);
    const hubEntry = s.entries.find((e) => normalizeDirKey(e.dirKey, hubIp, camIp) === hubToCamKey);
    if (!camEntry || !hubEntry) {
      console.log(` ${s.label}: missing cam->hub or hub->cam entry`);
      continue;
    }

    const camByType = new Map<number, TranscriptRecord>();
    for (const r of camEntry.records) if (!camByType.has(r.type)) camByType.set(r.type, r);
    const hubByType = new Map<number, TranscriptRecord>();
    for (const r of hubEntry.records) if (!hubByType.has(r.type)) hubByType.set(r.type, r);

    let sharedTypes = [...camByType.keys()].filter((t) => hubByType.has(t)).sort((a, b) => a - b);
    if (onlyTypes) sharedTypes = sharedTypes.filter((t) => onlyTypes.includes(t));
    if (sharedTypes.length === 0) {
      console.log(` ${s.label}: sharedTypes=[]`);
      continue;
    }

    console.log(` ${s.label}: sharedTypes=[${sharedTypes.join(', ')}]`);
    for (const t of sharedTypes) {
      const cr = camByType.get(t)!;
      const hr = hubByType.get(t)!;
      const cb = Buffer.from(cr.payloadB64, 'base64');
      const hb = Buffer.from(hr.payloadB64, 'base64');
      const pre = commonPrefixLen([cb, hb]);
      const suf = commonSuffixLen([cb, hb]);
      const eq16 = equalCountPairwiseAtOffsets(cb, hb, 16);
      const eq64 = equalCountPairwiseAtOffsets(cb, hb, 64);
      console.log(
        `  - type=${t} camLen=${cb.length} hubLen=${hb.length} commonPrefix=${pre} commonSuffix=${suf} eqFirst16=${eq16}/16 eqFirst64=${eq64}/64`,
      );

      // Look for other types that have a very small directional mask in the first 16 bytes.
      const mask16General = xorMaskFirstN(cb, hb, 16);
      const maskNonZero = countNonZeroBytes(mask16General);
      if (t !== 0 && mask16General.length === 16 && maskNonZero > 0 && maskNonZero <= 2) {
        console.log(`    sparseMask16(nonZero=${maskNonZero})=${mask16General.toString('hex')}`);
      }

      if (t === 0) {
        const mask16 = mask16General;
        const cbNorm = Buffer.from(cb);
        if (cbNorm.length >= 9) {
          cbNorm[0] = cbNorm[0]! ^ 0x01;
          cbNorm[8] = cbNorm[8]! ^ 0xc0;
        }

        const overlap = Math.min(cb.length, hb.length);
        let eqAfter16 = 0;
        for (let i = 16; i < overlap; i++) if (cb[i]! === hb[i]!) eqAfter16++;

        console.log(
          `    type0Mask16=${mask16.toString('hex')} maskMatchesExpected=${isExpectedType0DirectionMask(mask16) ? 'YES' : 'NO'} eqBytes[16..minLen)=` +
            `${eqAfter16}/${Math.max(0, overlap - 16)}`,
        );
        console.log(
          `    type0AfterNorm hubIsCamPrefix=${sliceEquals(cbNorm, hb, 'prefix') ? 'YES' : 'NO'} hubIsCamSuffix=${sliceEquals(cbNorm, hb, 'suffix') ? 'YES' : 'NO'}`,
        );

        const headerEq = buffersEqual(cbNorm.subarray(0, 16), hb.subarray(0, 16));
        console.log(`    type0Header16AfterNormEqual=${headerEq ? 'YES' : 'NO'}`);
      }
    }
  }

  // Pairing-focused report (useful for types 0/1/2): timing, header/body entropy, cross-type header similarity.
  if (env('PAIRING_REPORT_012') === '1') {
    const targetTypes = onlyTypes ?? [0, 1, 2];
    console.log(`\n-- Pairing report (types=[${targetTypes.join(', ')}]) --`);

    for (const s of sessions) {
      const camEntry = s.entries.find((e) => normalizeDirKey(e.dirKey, hubIp, camIp) === camToHubKey);
      const hubEntry = s.entries.find((e) => normalizeDirKey(e.dirKey, hubIp, camIp) === hubToCamKey);
      console.log(`\n${s.label}`);
      if (!camEntry || !hubEntry) {
        console.log(' missing cam->hub or hub->cam entry');
        continue;
      }

      const entriesByDir: Array<{ dir: string; entry: TranscriptEntry }> = [
        { dir: camToHubKey, entry: camEntry },
        { dir: hubToCamKey, entry: hubEntry },
      ];

      // Cross-direction ordering per type (absolute timestamps)
      console.log(' cross-direction ordering (tsMs)');
      for (const t of targetTypes) {
        const cr = camEntry.records.find((x) => x.type === t);
        const hr = hubEntry.records.find((x) => x.type === t);
        if (!cr || !hr) {
          console.log(`  - type=${t}: missing in one direction`);
          continue;
        }
        const delta = hr.tsMs - cr.tsMs;
        const who = delta < 0 ? 'hub-first' : delta > 0 ? 'cam-first' : 'same-ts';
        console.log(`  - type=${t}: ${who} deltaMs=${Math.round(delta)}`);
      }

      for (const { dir, entry } of entriesByDir) {
        console.log(` ${dir}`);
        for (const t of targetTypes) {
          const r = entry.records.find((x) => x.type === t);
          if (!r) {
            console.log(`  - type=${t}: missing`);
            continue;
          }
          const p = Buffer.from(r.payloadB64, 'base64');
          const head16 = p.subarray(0, Math.min(16, p.length));
          const body = p.length > 16 ? p.subarray(16) : Buffer.alloc(0);
          console.log(
            `  - type=${t} relMs=${Math.round(r.relMs)} len=${p.length} head16=${head16.toString('hex')} bodyLen=${body.length} bodyEntropy=${shannonEntropy(body).toFixed(3)}`,
          );
        }

        // Compare header16 across types within this direction
        const headByType = new Map<number, Buffer>();
        for (const t of targetTypes) {
          const r = entry.records.find((x) => x.type === t);
          if (!r) continue;
          const p = Buffer.from(r.payloadB64, 'base64');
          if (p.length < 16) continue;
          headByType.set(t, p.subarray(0, 16));
        }

        for (let i = 0; i < targetTypes.length; i++) {
          for (let j = i + 1; j < targetTypes.length; j++) {
            const aT = targetTypes[i]!;
            const bT = targetTypes[j]!;
            const aH = headByType.get(aT);
            const bH = headByType.get(bT);
            if (!aH || !bH) continue;
            const eq16 = equalCountPairwiseAtOffsets(aH, bH, 16);
            if (eq16 > 0) console.log(`  headerEq type${aT} vs type${bT}: ${eq16}/16`);
          }
        }
      }
    }
  }

  const byTypeDir = new Map<string, Array<{ session: string; record: TranscriptRecord }>>();

  for (const s of sessions) {
    for (const e of s.entries) {
      const normDir = normalizeDirKey(e.dirKey, hubIp, camIp);
      // pick first record per type
      const firstByType = new Map<number, TranscriptRecord>();
      for (const r of e.records) {
        if (!firstByType.has(r.type)) firstByType.set(r.type, r);
      }
      for (const [t, r] of firstByType.entries()) {
        if (onlyTypes && !onlyTypes.includes(t)) continue;
        const key = `${normDir} | type=${t}`;
        const list = byTypeDir.get(key) ?? [];
        list.push({ session: s.label, record: r });
        byTypeDir.set(key, list);
      }
    }
  }

  const keys = [...byTypeDir.keys()].sort();
  console.log('\n-- Per-type multi-session compare (first record each) --');
  for (const key of keys) {
    const list = byTypeDir.get(key)!;
    if (list.length < 2) continue;
    const payloads = list.map((x) => Buffer.from(x.record.payloadB64, 'base64'));
    const lens = list.map((x) => x.record.len);
    const minLen = Math.min(...lens);
    const pre = commonPrefixLen(payloads);
    const suf = commonSuffixLen(payloads);
    const eq64 = equalCountAtOffsets(payloads, 64);

    console.log(`\n${key}`);
    console.log(` sessions=${list.length} lens=[${lens.join(', ')}] minLen=${minLen} commonPrefix=${pre} commonSuffix=${suf} eqFirst64=${eq64}/64`);
    for (const x of list) {
      const p = Buffer.from(x.record.payloadB64, 'base64');
      console.log(
        `  - ${x.session} off=${x.record.streamOff} relMs=${Math.round(x.record.relMs)} sha256[:8]=${sha256Short(p)} head8=${p.subarray(0, 8).toString('hex')} tail8=${p.subarray(Math.max(0, p.length - 8)).toString('hex')}`,
      );
    }
  }
}

function main(): void {
  const focusIpsRaw = env('FOCUS_IPS');
  const focusIps = new Set(
    (focusIpsRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

  const transcriptsRaw = env('TRANSCRIPTS');
  if (!transcriptsRaw) {
    throw new Error('Missing TRANSCRIPTS env (comma-separated transcript JSON paths)');
  }
  if (focusIps.size < 2) {
    throw new Error('Missing/invalid FOCUS_IPS (e.g. "192.168.1.161,192.168.1.139")');
  }

  const hubIp = env('HUB_IP', '192.168.1.161') ?? '192.168.1.161';
  const camIp = env('CAM_IP');
  if (!camIp) {
    const other = [...focusIps].find((ip) => ip !== hubIp);
    if (!other) throw new Error('Cannot infer CAM_IP from FOCUS_IPS; set CAM_IP env');
    process.env.CAM_IP = other;
  }

  const paths = transcriptsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const sessions: SessionView[] = paths.map((p) => {
    const t = loadTranscript(p);
    const entries = t.entries.filter((e) => isEntryBetweenIps(e, focusIps));
    const bestEntry = pickBestEntry(t.entries, focusIps);
    return { label: fileLabel(p), pcapPath: t.pcapPath, entries, bestEntry };
  });

  console.log('## 6666 multi-session compare');
  console.log(`focusIps=[${[...focusIps].join(', ')}]`);
  console.log(`transcripts=${sessions.length}`);
  for (const s of sessions) console.log(` - ${s.label}`);

  summarizePrefix(sessions);
  summarizeTypes(sessions);
}

main();
