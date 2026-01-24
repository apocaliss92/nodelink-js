#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
    const args = { input: null, outDir: null, maxFound: 20 };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--out" || a === "--outDir") args.outDir = String(argv[++i] ?? "");
        else if (a === "--max" || a === "--max-found") args.maxFound = Number(argv[++i] ?? "20");
        else rest.push(a);
    }
    args.input = rest[0] ?? null;
    if (!args.input) throw new Error("Usage: node tools/pcap/extract-paramsets-from-annexb.mjs <input.bin> --out <dir>");
    if (!args.outDir) args.outDir = path.join(path.dirname(args.input), "_paramsets");
    if (!Number.isFinite(args.maxFound) || args.maxFound <= 0) args.maxFound = 20;
    return args;
}

function* iterStartCodes(buf) {
    for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] !== 0x00 || buf[i + 1] !== 0x00) continue;
        if (buf[i + 2] === 0x01) {
            yield { off: i, len: 3 };
            i += 2;
            continue;
        }
        if (buf[i + 2] === 0x00 && buf[i + 3] === 0x01) {
            yield { off: i, len: 4 };
            i += 3;
            continue;
        }
    }
}

function kindOfNalHeader(firstByte) {
    const h264Type = firstByte & 0x1f;
    const hevcType = (firstByte >> 1) & 0x3f;

    if (h264Type === 7) return { codec: "h264", kind: "sps" };
    if (h264Type === 8) return { codec: "h264", kind: "pps" };

    if (hevcType === 32) return { codec: "hevc", kind: "vps" };
    if (hevcType === 33) return { codec: "hevc", kind: "sps" };
    if (hevcType === 34) return { codec: "hevc", kind: "pps" };

    return null;
}

function main() {
    const { input, outDir, maxFound } = parseArgs(process.argv.slice(2));
    const absIn = path.resolve(process.cwd(), input);
    const buf = fs.readFileSync(absIn);

    fs.mkdirSync(outDir, { recursive: true });

    const starts = [...iterStartCodes(buf)];

    const found = [];
    const seen = new Set();

    for (let i = 0; i < starts.length; i++) {
        const { off, len } = starts[i];
        const nextOff = i + 1 < starts.length ? starts[i + 1].off : buf.length;
        const nalStart = off + len;
        if (nalStart >= nextOff) continue;
        const payload = buf.subarray(nalStart, nextOff);
        if (payload.length < 1) continue;

        const kind = kindOfNalHeader(payload[0]);
        if (!kind) continue;

        const key = `${kind.codec}.${kind.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const fileBase = `${kind.codec}.${kind.kind}.at${off}.len${payload.length}.annexb`;
        const outPath = path.join(outDir, fileBase + ".bin");
        fs.writeFileSync(outPath, Buffer.concat([buf.subarray(off, off + len), payload]));

        found.push({ ...kind, startCodeOff: off, startCodeLen: len, nalLen: payload.length, outPath });
        if (found.length >= maxFound) break;
    }

    // Also write convenient concatenations if we have complete sets.
    const h264 = {
        sps: found.find((x) => x.codec === "h264" && x.kind === "sps")?.outPath,
        pps: found.find((x) => x.codec === "h264" && x.kind === "pps")?.outPath,
    };
    const hevc = {
        vps: found.find((x) => x.codec === "hevc" && x.kind === "vps")?.outPath,
        sps: found.find((x) => x.codec === "hevc" && x.kind === "sps")?.outPath,
        pps: found.find((x) => x.codec === "hevc" && x.kind === "pps")?.outPath,
    };

    const report = {
        ok: true,
        input: absIn,
        bytes: buf.length,
        outDir: path.resolve(process.cwd(), outDir),
        startCodes: starts.length,
        found,
        h264,
        hevc,
    };

    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main();
