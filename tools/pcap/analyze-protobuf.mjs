#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

function usage() {
    console.error(
        `Usage: node ${path.basename(process.argv[1])} <file> [--outdir DIR] [--max-fields N] [--offset N]`,
    );
    process.exit(2);
}

const file = process.argv[2];
if (!file) usage();

let outdir = "";
let maxFields = 200;
let startOffset = 0;
for (let i = 3; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--outdir") outdir = String(process.argv[++i] ?? "");
    else if (a === "--max-fields") maxFields = Number.parseInt(String(process.argv[++i] ?? "200"), 10);
    else if (a === "--offset") startOffset = Number.parseInt(String(process.argv[++i] ?? "0"), 10);
    else usage();
}

const buf = fs.readFileSync(file);

function readVarintAt(b, off) {
    let v = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
        if (off + i >= b.length) return null;
        const byte = b[off + i];
        v |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return { v, len: i + 1 };
        shift += 7n;
    }
    return null;
}

function hex(b) {
    return Buffer.from(b).toString("hex");
}

function detectMagic(b) {
    const magics = [
        { name: "jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff]) },
        { name: "png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
        { name: "mp4.ftyp", bytes: Buffer.from("ftyp", "ascii") },
        { name: "annexb", bytes: Buffer.from([0x00, 0x00, 0x00, 0x01]) },
        { name: "zlib", bytes: Buffer.from([0x78, 0x01]) },
        { name: "zlib", bytes: Buffer.from([0x78, 0x9c]) },
        { name: "zlib", bytes: Buffer.from([0x78, 0xda]) },
        { name: "gzip", bytes: Buffer.from([0x1f, 0x8b, 0x08]) },
    ];
    for (const m of magics) {
        const idx = b.indexOf(m.bytes);
        if (idx !== -1) return { name: m.name, offset: idx };
    }
    return null;
}

function ensureDir(p) {
    if (!p) return;
    fs.mkdirSync(p, { recursive: true });
}

console.log(`file=${file}`);
console.log(`bytes=${buf.length}`);
console.log(`offset=${startOffset}`);

let off = startOffset;
let fieldCount = 0;
let dumped = 0;

ensureDir(outdir);

while (off < buf.length && fieldCount < maxFields) {
    const key = readVarintAt(buf, off);
    if (!key) {
        console.log(`STOP: bad key varint at off=${off}`);
        break;
    }
    off += key.len;

    const fieldNo = Number(key.v >> 3n);
    const wire = Number(key.v & 0x7n);

    if (wire === 0) {
        const val = readVarintAt(buf, off);
        if (!val) {
            console.log(`STOP: bad varint value at off=${off} (field=${fieldNo})`);
            break;
        }
        off += val.len;
        console.log(`#${fieldCount} field=${fieldNo} wire=varint value=${val.v}`);
    } else if (wire === 1) {
        if (off + 8 > buf.length) {
            console.log(`STOP: fixed64 overruns at off=${off} (field=${fieldNo})`);
            break;
        }
        const v = buf.readBigUInt64LE(off);
        off += 8;
        console.log(`#${fieldCount} field=${fieldNo} wire=fixed64(le) value=${v}`);
    } else if (wire === 5) {
        if (off + 4 > buf.length) {
            console.log(`STOP: fixed32 overruns at off=${off} (field=${fieldNo})`);
            break;
        }
        const v = buf.readUInt32LE(off);
        off += 4;
        console.log(`#${fieldCount} field=${fieldNo} wire=fixed32(le) value=${v}`);
    } else if (wire === 2) {
        const len = readVarintAt(buf, off);
        if (!len) {
            console.log(`STOP: bad len varint at off=${off} (field=${fieldNo})`);
            break;
        }
        off += len.len;
        const L = Number(len.v);
        const start = off;
        const end = off + L;
        if (L < 0 || end > buf.length) {
            console.log(`STOP: length overruns (field=${fieldNo}) start=${start} len=${L} end=${end} total=${buf.length}`);
            break;
        }

        const slice = buf.subarray(start, end);
        const head = hex(slice.subarray(0, Math.min(16, slice.length)));
        const magic = detectMagic(slice);

        let note = "";
        if (magic) note += ` magic=${magic.name}@${magic.offset}`;
        console.log(`#${fieldCount} field=${fieldNo} wire=bytes len=${L} head=${head}${note}`);

        // Try inflate if it looks like zlib.
        if (slice.length >= 2 && slice[0] === 0x78 && (slice[1] === 0x01 || slice[1] === 0x9c || slice[1] === 0xda)) {
            try {
                const out = zlib.inflateSync(slice);
                console.log(`  inflate: ok outLen=${out.length} outHead=${hex(out.subarray(0, Math.min(16, out.length)))}`);
                if (outdir) {
                    const outPath = path.join(outdir, `${path.basename(file)}.field${fieldNo}.inflated.bin`);
                    fs.writeFileSync(outPath, out);
                    dumped++;
                    console.log(`  wrote ${outPath}`);
                }
            } catch {
                console.log(`  inflate: failed`);
            }
        }

        // Dump big-ish blobs for offline inspection.
        if (outdir && slice.length >= 4096) {
            let ext = "bin";
            if (slice.length >= 3 && slice[0] === 0xff && slice[1] === 0xd8 && slice[2] === 0xff) ext = "jpg";
            if (slice.length >= 8 && slice.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = "png";
            const outPath = path.join(outdir, `${path.basename(file)}.field${fieldNo}.${ext}`);
            fs.writeFileSync(outPath, slice);
            dumped++;
            console.log(`  wrote ${outPath}`);
        }

        off = end;
    } else {
        console.log(`#${fieldCount} field=${fieldNo} wire=${wire} (unknown) at off=${off}`);
        break;
    }

    fieldCount++;
}

console.log(`done fields=${fieldCount} stoppedOff=${off} dumped=${dumped}`);
