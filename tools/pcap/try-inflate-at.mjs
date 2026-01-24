#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

function usage() {
    console.error(`Usage:
  node tools/pcap/try-inflate-at.mjs <input.bin> --at <offset> --out <prefix> [--dict-dir <dir>] [--max-dicts <n>]

Behavior:
  - Reads input starting at offset, tries zlib inflate.
  - Tries: no-dict first, then every *.bin file in dict-dir (up to max-dicts).
  - For each successful inflate, writes <prefix>.<try>.inflated.bin and prints a short summary.
`);
    process.exit(2);
}

function sigSummary(b) {
    const jpg = b.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    const png = b.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const ftyp = b.indexOf(Buffer.from("ftyp", "ascii"));
    const moov = b.indexOf(Buffer.from("moov", "ascii"));
    const startCode = b.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
    return { jpg, png, ftyp, moov, startCode };
}

const input = process.argv[2];
if (!input) usage();

let at = null;
let out = null;
let dictDir = "pcap/reports/apk/dicts";
let maxDicts = 2000;

for (let i = 3; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--at") at = Number(process.argv[++i] ?? "NaN");
    else if (a === "--out") out = String(process.argv[++i] ?? "");
    else if (a === "--dict-dir") dictDir = String(process.argv[++i] ?? dictDir);
    else if (a === "--max-dicts") maxDicts = Number(process.argv[++i] ?? "0") || maxDicts;
    else usage();
}

if (!Number.isFinite(at) || at < 0) usage();
if (!out) usage();

const buf = fs.readFileSync(input);
if (at >= buf.length) {
    console.error(`Offset out of range: at=${at}, len=${buf.length}`);
    process.exit(2);
}

const data = buf.subarray(at);

/** @type {{name:string, dict:Buffer|null}[]} */
const tries = [{ name: "no-dict", dict: null }];

if (fs.existsSync(dictDir) && fs.statSync(dictDir).isDirectory()) {
    const dictFiles = fs
        .readdirSync(dictDir)
        .filter((f) => f.endsWith(".bin"))
        .slice(0, Math.max(0, maxDicts))
        .map((f) => path.join(dictDir, f));

    for (const df of dictFiles) {
        tries.push({ name: path.basename(df), dict: fs.readFileSync(df) });
    }
}

fs.mkdirSync(path.dirname(out), { recursive: true });

let okCount = 0;
for (const t of tries) {
    try {
        const inflated = t.dict ? zlib.inflateSync(data, { dictionary: t.dict }) : zlib.inflateSync(data);
        okCount++;
        const outPath = `${out}.${t.name}.inflated.bin`;
        fs.writeFileSync(outPath, inflated);
        console.log(
            JSON.stringify(
                {
                    try: t.name,
                    ok: true,
                    outPath,
                    outLen: inflated.length,
                    sig: sigSummary(inflated),
                },
                null,
                2,
            ),
        );
    } catch (e) {
        const err = e && typeof e === "object" ? (e.code || e.message || String(e)) : String(e);
        console.log(JSON.stringify({ try: t.name, ok: false, err }, null, 2));
    }
}

console.log(JSON.stringify({ input, at, okCount, tries: tries.length }, null, 2));
