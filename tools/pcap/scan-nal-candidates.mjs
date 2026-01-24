#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
    const args = { dir: "pcap/reports/dec", maxFiles: 2000, top: 50, pattern: null };
    const rest = [];

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--dir") args.dir = argv[++i];
        else if (a === "--max-files") args.maxFiles = Number(argv[++i]);
        else if (a === "--top") args.top = Number(argv[++i]);
        else if (a === "--pattern") args.pattern = String(argv[++i]);
        else rest.push(a);
    }
    return { args, rest };
}

function* walkDirFlat(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            yield* walkDirFlat(p);
            continue;
        }
        if (!ent.isFile()) continue;
        yield p;
    }
}

function countAnnexBParamSets(buf) {
    let startCodes = 0;
    const h264 = { sps: 0, pps: 0, idr: 0 };
    const hevc = { vps: 0, sps: 0, pps: 0, idr: 0 };

    for (let i = 0; i + 4 < buf.length; i++) {
        if (buf[i] !== 0x00 || buf[i + 1] !== 0x00) continue;

        let scLen = 0;
        if (buf[i + 2] === 0x01) scLen = 3;
        else if (buf[i + 2] === 0x00 && buf[i + 3] === 0x01) scLen = 4;
        else continue;

        startCodes++;
        const hdrOff = i + scLen;
        if (hdrOff >= buf.length) continue;
        const b = buf[hdrOff];

        const h264Type = b & 0x1f;
        if (h264Type === 7) h264.sps++;
        else if (h264Type === 8) h264.pps++;
        else if (h264Type === 5) h264.idr++;

        const hevcType = (b >> 1) & 0x3f;
        if (hevcType === 32) hevc.vps++;
        else if (hevcType === 33) hevc.sps++;
        else if (hevcType === 34) hevc.pps++;
        else if (hevcType === 19 || hevcType === 20) hevc.idr++;

        i += scLen - 1;
    }

    return { startCodes, h264, hevc };
}

function scoreCounts({ startCodes, h264, hevc }) {
    // Heuristic: parameter sets are much more important than raw start-codes.
    const score =
        hevc.vps * 1000 +
        hevc.sps * 800 +
        hevc.pps * 600 +
        hevc.idr * 200 +
        h264.sps * 400 +
        h264.pps * 300 +
        h264.idr * 100 +
        Math.min(startCodes, 500);
    return score;
}

const { args } = parseArgs(process.argv.slice(2));
if (!fs.existsSync(args.dir)) {
    console.error(JSON.stringify({ ok: false, error: `Missing dir: ${args.dir}` }));
    process.exit(2);
}

const patternRe = args.pattern ? new RegExp(args.pattern, "i") : null;

const rows = [];
let scanned = 0;
for (const filePath of walkDirFlat(args.dir)) {
    if (scanned >= args.maxFiles) break;
    const base = path.basename(filePath);
    if (patternRe && !patternRe.test(base)) continue;

    // Keep this default broad but avoid clearly irrelevant giant binary outputs if any.
    if (!base.match(/\.(bin|h26[45]|annexb|carved)$/i) && !base.includes("pt")) continue;

    let buf;
    try {
        buf = fs.readFileSync(filePath);
    } catch {
        continue;
    }

    const counts = countAnnexBParamSets(buf);
    const score = scoreCounts(counts);
    if (counts.startCodes === 0 && score === 0) {
        scanned++;
        continue;
    }

    rows.push({
        file: base,
        size: buf.length,
        startCodes: counts.startCodes,
        h264: counts.h264,
        hevc: counts.hevc,
        score,
    });

    scanned++;
}

rows.sort((a, b) => b.score - a.score);

console.log(
    JSON.stringify(
        {
            ok: true,
            dir: args.dir,
            scanned,
            top: rows.slice(0, args.top),
        },
        null,
        2,
    ),
);
