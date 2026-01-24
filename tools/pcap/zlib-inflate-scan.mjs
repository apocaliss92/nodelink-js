#!/usr/bin/env node

import fs from "node:fs";
import zlib from "node:zlib";

const MOD_ADLER = 65521;

function adler32(buf) {
    let a = 1;
    let b = 0;
    for (let i = 0; i < buf.length; i++) {
        a += buf[i];
        a %= MOD_ADLER;
        b += a;
        b %= MOD_ADLER;
    }
    return (((b & 0xffff) << 16) | (a & 0xffff)) >>> 0;
}

function toHex32(n) {
    return (n >>> 0).toString(16).padStart(8, "0");
}

function findZlibHeaders(buf, max = 2000) {
    const hits = [];
    for (let i = 0; i + 1 < buf.length && hits.length < max; i++) {
        if (buf[i] !== 0x78) continue;
        const cmf = buf[i];
        const flg = buf[i + 1];
        const hdr = (cmf << 8) | flg;
        if (hdr % 31 !== 0) continue;
        const fdict = (flg >> 5) & 1;
        hits.push({ at: i, cmf, flg, fdict });
    }
    return hits;
}

function main() {
    const filePath = process.argv[2];
    if (!filePath) {
        console.error("Usage: node tools/pcap/zlib-inflate-scan.mjs <file.bin>");
        process.exit(2);
    }

    const buf = fs.readFileSync(filePath);
    const hits = findZlibHeaders(buf);

    const out = {
        ok: true,
        file: filePath,
        size: buf.length,
        zlibHeaders: hits.length,
        headers: [],
    };

    for (const h of hits) {
        const start = h.at;
        if (h.fdict) {
            const dictId = buf.readUInt32BE(start + 2) >>> 0;
            out.headers.push({
                at: start,
                cmf: `0x${h.cmf.toString(16).padStart(2, "0")}`,
                flg: `0x${h.flg.toString(16).padStart(2, "0")}`,
                fdict: true,
                dictId: `0x${toHex32(dictId)}`,
                inflate: { ok: false, error: "FDICT" },
            });
            continue;
        }

        try {
            const inflated = zlib.inflateSync(buf.subarray(start), {
                finishFlush: zlib.constants.Z_SYNC_FLUSH,
            });
            const last32k = inflated.subarray(Math.max(0, inflated.length - 32768));
            out.headers.push({
                at: start,
                cmf: `0x${h.cmf.toString(16).padStart(2, "0")}`,
                flg: `0x${h.flg.toString(16).padStart(2, "0")}`,
                fdict: false,
                inflate: {
                    ok: true,
                    outLen: inflated.length,
                    last32kAdler32: `0x${toHex32(adler32(last32k))}`,
                },
            });
        } catch (e) {
            out.headers.push({
                at: start,
                cmf: `0x${h.cmf.toString(16).padStart(2, "0")}`,
                flg: `0x${h.flg.toString(16).padStart(2, "0")}`,
                fdict: false,
                inflate: { ok: false, error: String(e?.message ?? e) },
            });
        }
    }

    console.log(JSON.stringify(out, null, 2));
}

main();
