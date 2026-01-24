#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function readUInt(buf, offset, byteLen, endian) {
    if (offset + byteLen > buf.length) return null;
    if (byteLen === 1) return buf.readUInt8(offset);
    if (byteLen === 2) return endian === "be" ? buf.readUInt16BE(offset) : buf.readUInt16LE(offset);
    if (byteLen === 4) return endian === "be" ? buf.readUInt32BE(offset) : buf.readUInt32LE(offset);
    return null;
}

function readVarintAt(buf, offset, maxBytes = 10) {
    let v = 0n;
    let shift = 0n;
    for (let i = 0; i < maxBytes; i++) {
        if (offset + i >= buf.length) return null;
        const byte = buf[offset + i];
        v |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return { v, len: i + 1 };
        shift += 7n;
    }
    return null;
}

function topTags(tagCounts, n = 12) {
    const entries = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
    return entries.slice(0, n);
}

function iterateTlvFixed(buf, { tagBytes, lenBytes, endian, maxItems = 2_000_000 }, onItem) {
    let offset = 0;
    let items = 0;

    while (offset < buf.length) {
        if (items >= maxItems) return { ok: false, reason: "maxItems reached" };

        const tag = readUInt(buf, offset, tagBytes, endian);
        if (tag == null) return { ok: false, reason: "truncated tag", offset, items };
        offset += tagBytes;

        const len = readUInt(buf, offset, lenBytes, endian);
        if (len == null) return { ok: false, reason: "truncated len", offset, items };
        offset += lenBytes;

        if (len <= 0) return { ok: false, reason: "non-positive len", offset, items, tag, len };
        if (len > buf.length - offset) return { ok: false, reason: "len overruns buffer", offset, items, tag, len };

        const valueStart = offset;
        const valueEnd = offset + len;
        const value = buf.subarray(valueStart, valueEnd);

        onItem?.({ index: items, tag, len, valueStart, valueEnd, value });

        offset = valueEnd;
        items++;
    }

    return { ok: true, items };
}

function tryTlvFixed(buf, { tagBytes, lenBytes, endian, maxItems = 2_000_000 }) {
    let items = 0;
    let bytesValueTotal = 0;
    let minLen = Number.POSITIVE_INFINITY;
    let maxLen = 0;
    const tagCounts = new Map();

    const it = iterateTlvFixed(
        buf,
        { tagBytes, lenBytes, endian, maxItems },
        ({ tag, len }) => {
            bytesValueTotal += len;
            minLen = Math.min(minLen, len);
            maxLen = Math.max(maxLen, len);
            tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        },
    );

    if (!it.ok) return it;
    items = it.items;

    const headerBytes = items * (tagBytes + lenBytes);
    return {
        ok: true,
        items,
        headerBytes,
        valueBytes: bytesValueTotal,
        totalBytes: buf.length,
        tagBytes,
        lenBytes,
        endian,
        minLen: Number.isFinite(minLen) ? minLen : 0,
        maxLen,
        uniqueTags: tagCounts.size,
        topTags: topTags(tagCounts),
    };
}

function iterateTlvVarint(buf, { maxItems = 2_000_000, maxTagBytes = 5, maxLenBytes = 5 }, onItem) {
    let offset = 0;
    let items = 0;

    while (offset < buf.length) {
        if (items >= maxItems) return { ok: false, reason: "maxItems reached" };

        const tag = readVarintAt(buf, offset, maxTagBytes);
        if (!tag) return { ok: false, reason: "truncated tag", offset, items };
        offset += tag.len;

        const len = readVarintAt(buf, offset, maxLenBytes);
        if (!len) return { ok: false, reason: "truncated len", offset, items };
        offset += len.len;

        const L = Number(len.v);
        if (!Number.isFinite(L)) return { ok: false, reason: "len not finite", offset, items };
        if (L <= 0) return { ok: false, reason: "non-positive len", offset, items, tag: Number(tag.v), len: L };
        if (L > buf.length - offset) return { ok: false, reason: "len overruns buffer", offset, items, tag: Number(tag.v), len: L };

        const valueStart = offset;
        const valueEnd = offset + L;
        const value = buf.subarray(valueStart, valueEnd);

        onItem?.({ index: items, tag: Number(tag.v), len: L, tagLen: tag.len, lenLen: len.len, valueStart, valueEnd, value });

        offset = valueEnd;
        items++;
    }

    return { ok: true, items };
}

function tryTlvVarint(buf, { maxItems = 2_000_000, maxTagBytes = 5, maxLenBytes = 5 }) {
    let items = 0;
    let bytesValueTotal = 0;
    let minLen = Number.POSITIVE_INFINITY;
    let maxLen = 0;
    let headerBytes = 0;
    const tagCounts = new Map();

    const it = iterateTlvVarint(buf, { maxItems, maxTagBytes, maxLenBytes }, ({ tag, len, tagLen, lenLen }) => {
        bytesValueTotal += len;
        minLen = Math.min(minLen, len);
        maxLen = Math.max(maxLen, len);
        headerBytes += tagLen + lenLen;
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    });

    if (!it.ok) return it;
    items = it.items;

    return {
        ok: true,
        items,
        headerBytes,
        valueBytes: bytesValueTotal,
        totalBytes: buf.length,
        tagBytes: "varint",
        lenBytes: "varint",
        endian: "n/a",
        minLen: Number.isFinite(minLen) ? minLen : 0,
        maxLen,
        uniqueTags: tagCounts.size,
        topTags: topTags(tagCounts),
    };
}

function findMagic(buf) {
    const scanZlib = (maxHits = 8) => {
        const hits = [];
        for (let i = 0; i + 1 < buf.length && hits.length < maxHits; i++) {
            const b0 = buf[i];
            const b1 = buf[i + 1];
            if (b0 !== 0x78) continue;
            const v = (b0 << 8) | b1;
            if (v % 31 !== 0) continue;

            const fdict = (b1 & 0x20) !== 0;
            let name = `zlib.${b0.toString(16).padStart(2, "0")}${b1.toString(16).padStart(2, "0")}`;
            if (fdict && i + 6 <= buf.length) {
                const dictid = buf.readUInt32BE(i + 2);
                name += `.dictid=${dictid.toString(16).padStart(8, "0")}`;
            }
            hits.push({ name, offset: i });
        }
        return hits;
    };

    const scanLz4Frame = (maxHits = 8) => {
        const hits = [];

        // LZ4 frame magic is 0x184D2204 in LE.
        const frameMagic = Buffer.from([0x04, 0x22, 0x4d, 0x18]);
        let start = 0;
        while (start < buf.length && hits.length < maxHits) {
            const idx = buf.indexOf(frameMagic, start);
            if (idx === -1) break;
            hits.push({ name: "lz4f.frame", offset: idx });
            start = idx + 1;
        }

        // Skippable frames: 0x184D2A50..0x184D2A5F (LE bytes 50 2A 4D 18 ... 5F 2A 4D 18)
        for (let i = 0; i + 3 < buf.length && hits.length < maxHits; i++) {
            const b0 = buf[i];
            if (b0 < 0x50 || b0 > 0x5f) continue;
            if (buf[i + 1] !== 0x2a || buf[i + 2] !== 0x4d || buf[i + 3] !== 0x18) continue;
            hits.push({ name: `lz4f.skippable.${b0.toString(16)}`, offset: i });
        }

        return hits;
    };

    const magics = [
        { name: "mp4.ftyp", bytes: Buffer.from("ftyp", "ascii") },
        { name: "jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff]) },
        { name: "png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
        { name: "annexb", bytes: Buffer.from([0x00, 0x00, 0x00, 0x01]) },
        { name: "gzip", bytes: Buffer.from([0x1f, 0x8b, 0x08]) },
    ];

    const hits = [];
    for (const m of magics) {
        let start = 0;
        let guard = 0;
        while (start < buf.length && guard++ < 20) {
            const idx = buf.indexOf(m.bytes, start);
            if (idx === -1) break;
            hits.push({ name: m.name, offset: idx });
            start = idx + 1;
        }
    }

    hits.push(...scanZlib());
    hits.push(...scanLz4Frame());
    hits.sort((a, b) => a.offset - b.offset);
    return hits;
}

function printResult(r) {
    const pctHeader = ((r.headerBytes / r.totalBytes) * 100).toFixed(2);
    const pctValue = ((r.valueBytes / r.totalBytes) * 100).toFixed(2);
    console.log(`OK tlv tag=${r.tagBytes} len=${r.lenBytes} ${r.endian} items=${r.items} uniqueTags=${r.uniqueTags}`);
    console.log(`  bytes: total=${r.totalBytes} header=${r.headerBytes} (${pctHeader}%) values=${r.valueBytes} (${pctValue}%)`);
    console.log(`  len: min=${r.minLen} max=${r.maxLen}`);
    console.log(`  topTags: ${r.topTags.map(([t, c]) => `${t}:${c}`).join(" ")}`);
}

function usage() {
    console.error(
        `Usage: node ${path.basename(process.argv[1])} <file> [--offset N] [--max-bytes N] [--dump-first-items N --out-dir DIR] [--scan-values]`,
    );
    process.exit(2);
}

const file = process.argv[2];
if (!file) usage();

let offset = 0;
let maxBytes = undefined;
let dumpFirstItems = 0;
let outDir = undefined;
let scanValues = false;
for (let i = 3; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--offset") offset = Number.parseInt(process.argv[++i] ?? "0", 10);
    else if (a === "--max-bytes") maxBytes = Number.parseInt(process.argv[++i] ?? "0", 10);
    else if (a === "--dump-first-items") dumpFirstItems = Number.parseInt(process.argv[++i] ?? "0", 10);
    else if (a === "--out-dir") outDir = process.argv[++i];
    else if (a === "--scan-values") scanValues = true;
    else usage();
}

const raw = fs.readFileSync(file);
const buf = maxBytes ? raw.subarray(offset, Math.min(raw.length, offset + maxBytes)) : raw.subarray(offset);

console.log(`file=${file}`);
console.log(`sliceOffset=${offset} sliceBytes=${buf.length} totalBytes=${raw.length}`);

const magicHits = findMagic(buf);
if (magicHits.length) {
    console.log("magicHits:");
    for (const h of magicHits.slice(0, 20)) console.log(`  - ${h.name}@${h.offset}`);
} else {
    console.log("magicHits: (none)");
}

const candidates = [
    { tagBytes: 1, lenBytes: 2, endian: "be" },
    { tagBytes: 1, lenBytes: 2, endian: "le" },
    { tagBytes: 1, lenBytes: 4, endian: "be" },
    { tagBytes: 1, lenBytes: 4, endian: "le" },
    { tagBytes: 2, lenBytes: 2, endian: "be" },
    { tagBytes: 2, lenBytes: 2, endian: "le" },
    { tagBytes: 2, lenBytes: 4, endian: "be" },
    { tagBytes: 2, lenBytes: 4, endian: "le" },
    { tagBytes: 4, lenBytes: 4, endian: "be" },
    { tagBytes: 4, lenBytes: 4, endian: "le" },
];

let anyOk = false;
for (const c of candidates) {
    const r = tryTlvFixed(buf, c);
    if (r.ok && r.items >= 5) {
        anyOk = true;
        printResult(r);

        if (dumpFirstItems > 0) {
            const dir = outDir ?? `${path.basename(file)}.tlv_dump`;
            fs.mkdirSync(dir, { recursive: true });
            let dumped = 0;
            iterateTlvFixed(buf, c, ({ index, tag, len, value }) => {
                if (dumped >= dumpFirstItems) return;
                const name = path.join(dir, `item_${String(index).padStart(6, "0")}_tag${tag}_len${len}.bin`);
                fs.writeFileSync(name, value);
                dumped++;
            });
            console.log(`  dumped: firstItems=${dumped} outDir=${dir}`);
        }

        if (scanValues) {
            const byTag = new Map();
            iterateTlvFixed(buf, c, ({ tag, value }) => {
                const hits = findMagic(value);
                if (!hits.length) return;
                const rec = byTag.get(tag) ?? { tag, count: 0, hitNames: new Map() };
                rec.count++;
                for (const h of hits) rec.hitNames.set(h.name, (rec.hitNames.get(h.name) ?? 0) + 1);
                byTag.set(tag, rec);
            });

            const rows = [...byTag.values()].sort((a, b) => b.count - a.count);
            if (rows.length) {
                console.log("  valueMagicHitsByTag:");
                for (const row of rows.slice(0, 20)) {
                    const names = [...row.hitNames.entries()]
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 8)
                        .map(([n, cnt]) => `${n}:${cnt}`)
                        .join(" ");
                    console.log(`    - tag=${row.tag} items=${row.count} ${names}`);
                }
            } else {
                console.log("  valueMagicHitsByTag: (none)");
            }
        }
    }
}

// Also try varint TLV (common in custom packed payloads).
{
    const r = tryTlvVarint(buf, { maxItems: 2_000_000, maxTagBytes: 5, maxLenBytes: 5 });
    if (r.ok && r.items >= 5) {
        anyOk = true;
        printResult(r);

        if (dumpFirstItems > 0) {
            const dir = outDir ?? `${path.basename(file)}.tlv_varint_dump`;
            fs.mkdirSync(dir, { recursive: true });
            let dumped = 0;
            iterateTlvVarint(buf, { maxItems: 2_000_000, maxTagBytes: 5, maxLenBytes: 5 }, ({ index, tag, len, value }) => {
                if (dumped >= dumpFirstItems) return;
                const name = path.join(dir, `item_${String(index).padStart(6, "0")}_tag${tag}_len${len}.bin`);
                fs.writeFileSync(name, value);
                dumped++;
            });
            console.log(`  dumped: firstItems=${dumped} outDir=${dir}`);
        }

        if (scanValues) {
            const byTag = new Map();
            iterateTlvVarint(buf, { maxItems: 2_000_000, maxTagBytes: 5, maxLenBytes: 5 }, ({ tag, value }) => {
                const hits = findMagic(value);
                if (!hits.length) return;
                const rec = byTag.get(tag) ?? { tag, count: 0, hitNames: new Map() };
                rec.count++;
                for (const h of hits) rec.hitNames.set(h.name, (rec.hitNames.get(h.name) ?? 0) + 1);
                byTag.set(tag, rec);
            });

            const rows = [...byTag.values()].sort((a, b) => b.count - a.count);
            if (rows.length) {
                console.log("  valueMagicHitsByTag (varintTLV):");
                for (const row of rows.slice(0, 20)) {
                    const names = [...row.hitNames.entries()]
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 8)
                        .map(([n, cnt]) => `${n}:${cnt}`)
                        .join(" ");
                    console.log(`    - tag=${row.tag} items=${row.count} ${names}`);
                }
            } else {
                console.log("  valueMagicHitsByTag (varintTLV): (none)");
            }
        }
    }
}

if (!anyOk) {
    console.log("No plausible fixed TLV parse found (with basic heuristics). Try --offset to skip a prelude.");
}
