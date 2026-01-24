#!/usr/bin/env node
/**
 * Find preset dictionaries embedded in binaries by matching zlib DictID (RFC1950 FDICT Adler32).
 *
 * DictID = Adler32(dictionaryBytes) (big-endian 32-bit, equals (B<<16)|A).
 *
 * This tool scans files with a rolling Adler32 over fixed window sizes.
 */

import fs from "node:fs";
import path from "node:path";

const MOD = 65521;

function usage() {
    console.error(`Usage:
    node tools/pcap/find-zlib-dict.mjs --dictid <hex> <file...> [options]
    node tools/pcap/find-zlib-dict.mjs --dictid <hex> --dir <dir> [options]
    node tools/pcap/find-zlib-dict.mjs --dictid <hex> --files-from <path> [options]

Options:
  --dictid <hex>        DictID from zlib header (e.g. d8eb54ed)
    --dir <dir>           Recursively scan all files under dir (optionally filtered by --ext)
    --ext <csv>           Extensions to include when using --dir (default: so,dex,odex,vdex,bin)
    --files-from <path>   Read newline-delimited file paths from a text file
  --win-sizes <csv>     Window sizes to scan (default: 256,512,1024,2048,4096,8192,16384,32768)
  --max-hits <n>        Max hits per file per window (default: 5)
    --stop-after <n>      Stop scanning after N total hits across all files (default: 0 = no limit)
  --out-dir <dir>       Where to write extracted dict candidates (default: pcap/reports/apk/dicts)
`);
    process.exit(2);
}

function parseHex32(s) {
    const t = String(s ?? "").trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{1,8}$/.test(t)) throw new Error(`Invalid hex32: ${s}`);
    return Number.parseInt(t, 16) >>> 0;
}

function mod(x) {
    x %= MOD;
    if (x < 0) x += MOD;
    return x;
}

function adler32_initWindow(buf, start, win) {
    let a = 1;
    let b = 0;
    const end = start + win;
    for (let i = start; i < end; i++) {
        a += buf[i];
        a %= MOD;
        b += a;
        b %= MOD;
    }
    return { a, b };
}

function adler32_roll({ a, b }, win, oldByte, newByte) {
    // Rolling Adler32 for fixed window length win.
    // A' = (A - old + new) mod MOD
    // B' = (B - win*old + A' - 1) mod MOD
    const a2 = mod(a - oldByte + newByte);
    const b2 = mod(b - win * oldByte + a2 - 1);
    return { a: a2, b: b2 };
}

function combineAdler({ a, b }) {
    return (((b & 0xffff) << 16) | (a & 0xffff)) >>> 0;
}

function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}

function listFilesRecursive(dirPath) {
    const out = [];
    const stack = [dirPath];
    while (stack.length) {
        const cur = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const p = path.join(cur, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (e.isFile()) out.push(p);
        }
    }
    return out;
}

function normalizeExtList(extCsv) {
    return String(extCsv ?? "")
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)
        .map((x) => (x.startsWith(".") ? x : `.${x}`));
}

function readFilesFromListFile(listPath) {
    const txt = fs.readFileSync(listPath, "utf8");
    return txt
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
}

function scanFile(filePath, dictId, winSizes, maxHits) {
    const buf = fs.readFileSync(filePath);
    const results = [];

    for (const win of winSizes) {
        if (win <= 0 || win > buf.length) continue;
        let state = adler32_initWindow(buf, 0, win);
        let v = combineAdler(state);

        let hits = 0;
        if (v === dictId) {
            results.push({ off: 0, win });
            hits++;
        }

        for (let off = 0; off + win < buf.length; off++) {
            if (hits >= maxHits) break;
            const oldByte = buf[off];
            const newByte = buf[off + win];
            state = adler32_roll(state, win, oldByte, newByte);
            v = combineAdler(state);
            if (v === dictId) {
                results.push({ off: off + 1, win });
                hits++;
            }
        }
    }

    return { len: buf.length, results, buf };
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.length < 2) usage();

    let dictId = null;
    let winSizes = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
    let maxHits = 5;
    let outDir = "pcap/reports/apk/dicts";
    let stopAfter = 0;

    let scanDir = null;
    let extCsv = "so,dex,odex,vdex,bin";
    let filesFrom = null;

    const files = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--dictid") dictId = parseHex32(argv[++i]);
        else if (a === "--dir") scanDir = String(argv[++i] ?? "");
        else if (a === "--ext") extCsv = String(argv[++i] ?? extCsv);
        else if (a === "--files-from") filesFrom = String(argv[++i] ?? "");
        else if (a === "--win-sizes") {
            winSizes = String(argv[++i] ?? "")
                .split(",")
                .map((x) => Number.parseInt(x.trim(), 10))
                .filter((n) => Number.isFinite(n) && n > 0);
        } else if (a === "--max-hits") maxHits = Number(argv[++i] ?? "0") || maxHits;
        else if (a === "--stop-after") stopAfter = Number(argv[++i] ?? "0") || 0;
        else if (a === "--out-dir") outDir = String(argv[++i] ?? outDir);
        else if (a.startsWith("-")) usage();
        else files.push(a);
    }

    if (dictId == null) throw new Error("Missing --dictid");

    let resolvedFiles = files;
    if (filesFrom) {
        resolvedFiles = resolvedFiles.concat(readFilesFromListFile(filesFrom));
    }
    if (scanDir) {
        const exts = normalizeExtList(extCsv);
        const all = listFilesRecursive(scanDir);
        const filtered = exts.length
            ? all.filter((p) => exts.includes(path.extname(p).toLowerCase()))
            : all;
        resolvedFiles = resolvedFiles.concat(filtered);
    }

    resolvedFiles = Array.from(new Set(resolvedFiles)).filter((p) => {
        try {
            return fs.statSync(p).isFile();
        } catch {
            return false;
        }
    });

    if (resolvedFiles.length === 0) usage();

    ensureDir(outDir);

    const report = {
        dictId: `0x${dictId.toString(16).padStart(8, "0")}`,
        winSizes,
        maxHits,
        stopAfter,
        outDir,
        scanDir,
        extCsv,
        filesFrom,
        files: [],
    };

    let totalHits = 0;
    for (const file of resolvedFiles) {
        const { len, results, buf } = scanFile(file, dictId, winSizes, maxHits);
        const base = path.basename(file);

        const fileEntry = { file, base, len, hits: [] };
        for (const r of results) {
            const outName = `dictid-${dictId.toString(16).padStart(8, "0")}.win${r.win}.${base}.off${r.off}.bin`;
            const outPath = path.join(outDir, outName);
            fs.writeFileSync(outPath, buf.subarray(r.off, r.off + r.win));
            fileEntry.hits.push({ ...r, outPath });
        }

        totalHits += fileEntry.hits.length;

        report.files.push(fileEntry);
        console.log(JSON.stringify({ file, len, hits: fileEntry.hits.length, firstHits: fileEntry.hits.slice(0, 3) }, null, 2));

        if (stopAfter > 0 && totalHits >= stopAfter) break;
    }

    const reportPath = path.join(outDir, `dictid-${dictId.toString(16).padStart(8, "0")}.report.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

main();
