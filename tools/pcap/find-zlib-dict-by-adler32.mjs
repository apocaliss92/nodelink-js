#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const MOD_ADLER = 65521;

function parseArgs(argv) {
    const args = {
        dir: "pcap/reports/dec",
        id: null,
        window: 32768,
        step: 1,
        maxFiles: 5000,
        maxFileSize: 50 * 1024 * 1024,
        outDir: null,
        pattern: null,
        top: 50,
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--dir") args.dir = argv[++i];
        else if (a === "--id") args.id = argv[++i];
        else if (a === "--window") args.window = Number(argv[++i]);
        else if (a === "--step") args.step = Number(argv[++i]);
        else if (a === "--max-files") args.maxFiles = Number(argv[++i]);
        else if (a === "--max-file-size") args.maxFileSize = Number(argv[++i]);
        else if (a === "--out") args.outDir = argv[++i];
        else if (a === "--pattern") args.pattern = argv[++i];
        else if (a === "--top") args.top = Number(argv[++i]);
    }

    if (!args.outDir) {
        args.outDir = path.join(args.dir, "_dicts_found");
    }

    return args;
}

function* walkFiles(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            yield* walkFiles(p);
            continue;
        }
        if (ent.isFile()) yield p;
    }
}

function mod(a) {
    const r = a % MOD_ADLER;
    return r < 0 ? r + MOD_ADLER : r;
}

function toHex32(n) {
    return (n >>> 0).toString(16).padStart(8, "0");
}

function parseId(idStr) {
    if (!idStr) return null;
    let s = String(idStr).trim().toLowerCase();
    if (s.startsWith("0x")) s = s.slice(2);
    if (!/^[0-9a-f]{1,8}$/.test(s)) throw new Error(`Invalid --id: ${idStr}`);
    return parseInt(s, 16) >>> 0;
}

function adler32InitWindow(buf, start, n) {
    let a = 1;
    let b = 0;
    for (let i = 0; i < n; i++) {
        a += buf[start + i];
        a %= MOD_ADLER;
        b += a;
        b %= MOD_ADLER;
    }
    return { a, b };
}

function adler32Value({ a, b }) {
    return (((b & 0xffff) << 16) | (a & 0xffff)) >>> 0;
}

function rollingAdler32Search(buf, windowSize, step, target) {
    const hits = [];
    if (buf.length < windowSize) return hits;

    let { a, b } = adler32InitWindow(buf, 0, windowSize);
    let value = adler32Value({ a, b });
    if (value === target) hits.push(0);

    // Note: true rolling is defined for step=1. For step>1 we iterate step times.
    for (let off = 0; off + windowSize < buf.length; off += step) {
        for (let k = 0; k < step; k++) {
            const i = off + k;
            if (i + windowSize >= buf.length) break;
            const outByte = buf[i];
            const inByte = buf[i + windowSize];
            a = mod(a - outByte + inByte);
            b = mod(b - windowSize * outByte + a - 1);
            value = adler32Value({ a, b });
            if (value === target) hits.push(i + 1);
        }
    }

    return hits;
}

function safeRel(baseDir, filePath) {
    const rel = path.relative(baseDir, filePath);
    return rel.startsWith("..") ? path.basename(filePath) : rel;
}

const args = parseArgs(process.argv.slice(2));
const target = parseId(args.id);
if (target == null) {
    console.error(JSON.stringify({ ok: false, error: "Missing --id <hex>" }, null, 2));
    process.exit(2);
}

if (!fs.existsSync(args.dir)) {
    console.error(JSON.stringify({ ok: false, error: `Missing dir: ${args.dir}` }, null, 2));
    process.exit(2);
}

const patternRe = args.pattern ? new RegExp(args.pattern, "i") : null;

const results = [];
let scanned = 0;

for (const filePath of walkFiles(args.dir)) {
    if (scanned >= args.maxFiles) break;
    const rel = safeRel(args.dir, filePath);
    const base = path.basename(filePath);
    if (patternRe && !patternRe.test(rel) && !patternRe.test(base)) continue;

    let st;
    try {
        st = fs.statSync(filePath);
    } catch {
        continue;
    }
    if (!st.isFile()) continue;
    if (st.size < args.window) {
        scanned++;
        continue;
    }
    if (st.size > args.maxFileSize) {
        scanned++;
        continue;
    }

    let buf;
    try {
        buf = fs.readFileSync(filePath);
    } catch {
        scanned++;
        continue;
    }

    const hits = rollingAdler32Search(buf, args.window, args.step, target);
    for (const at of hits) {
        results.push({ file: rel, size: buf.length, at });
    }

    scanned++;
}

results.sort((a, b) => a.file.localeCompare(b.file) || a.at - b.at);

const outBase = path.join(args.outDir, `dictid-${toHex32(target)}`);
fs.mkdirSync(outBase, { recursive: true });

const written = [];
for (const r of results.slice(0, args.top)) {
    const srcPath = path.join(args.dir, r.file);
    const buf = fs.readFileSync(srcPath);
    const slice = buf.subarray(r.at, r.at + args.window);

    const safeName = r.file.replaceAll(path.sep, "__");
    const outPath = path.join(outBase, `${safeName}.at${r.at}.len${args.window}.dict.bin`);
    fs.writeFileSync(outPath, slice);
    written.push(path.relative(process.cwd(), outPath));
}

const report = {
    ok: true,
    dir: args.dir,
    target: `0x${toHex32(target)}`,
    window: args.window,
    step: args.step,
    scanned,
    hits: results.length,
    extracted: written,
};

console.log(JSON.stringify(report, null, 2));
