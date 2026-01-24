#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

function usage() {
    console.error(`Usage:
  node tools/pcap/try-decompress-at.mjs <input.bin> --at <offset> --out <prefix> [--scan +-N]

Behavior:
  - Tries to decompress starting at --at as:
    - zlib (RFC1950): inflate
    - raw deflate: inflateRaw
    - gzip: gunzip
  - Captures partial output even if the stream errors.
  - If --scan is provided, also tries offsets in [at-N, at+N].
`);
    process.exit(2);
}

function detectSig(buf) {
    const jpg = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    const png = buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const ftyp = buf.indexOf(Buffer.from("ftyp", "ascii"));
    const moov = buf.indexOf(Buffer.from("moov", "ascii"));
    const annexb = buf.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
    return { jpg, png, ftyp, moov, annexb };
}

function isRfc1950Header(cmf, flg) {
    if ((cmf & 0x0f) !== 8) return false;
    const cmfFlg = ((cmf << 8) | flg) & 0xffff;
    if (cmfFlg % 31 !== 0) return false;
    const cinfo = (cmf >> 4) & 0x0f;
    if (cinfo > 7) return false;
    return true;
}

async function tryStreamDecompress(kind, data) {
    /** @type {zlib.Zlib} */
    const z =
        kind === "zlib"
            ? zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
            : kind === "raw"
                ? zlib.createInflateRaw({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
                : zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });

    /** @type {Buffer[]} */
    const chunks = [];
    let err = null;

    z.on("data", (c) => chunks.push(Buffer.from(c)));
    z.on("error", (e) => {
        err = e;
        // Prevent unhandled errors from rejecting pipeline before we capture output.
        z.removeAllListeners("data");
    });

    try {
        await pipeline(Readable.from([data]), z);
    } catch (e) {
        // pipeline rejects on error; err already captured.
        if (!err) err = e;
    }

    const out = Buffer.concat(chunks);
    return { out, err: err ? (err.code || err.message || String(err)) : null };
}

const input = process.argv[2];
if (!input) usage();

let at = null;
let outPrefix = null;
let scan = 0;

for (let i = 3; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--at") at = Number(process.argv[++i] ?? "NaN");
    else if (a === "--out") outPrefix = String(process.argv[++i] ?? "");
    else if (a === "--scan") scan = Math.max(0, Number(process.argv[++i] ?? "0") | 0);
    else usage();
}

if (!Number.isFinite(at) || at < 0) usage();
if (!outPrefix) usage();

const buf = fs.readFileSync(input);
fs.mkdirSync(path.dirname(outPrefix), { recursive: true });

const start = Math.max(0, at - scan);
const end = Math.min(buf.length - 2, at + scan);

for (let off = start; off <= end; off++) {
    const cmf = buf[off];
    const flg = buf[off + 1];
    const hdr = `${cmf.toString(16).padStart(2, "0")} ${flg.toString(16).padStart(2, "0")}`;
    const zlibOk = isRfc1950Header(cmf, flg);

    if (scan === 0 || zlibOk || (cmf === 0x1f && flg === 0x8b)) {
        const data = buf.subarray(off);
        const head = data.subarray(0, 16);

        console.log(JSON.stringify({ off, hdr, zlibOk, headHex: head.toString("hex") }, null, 2));

        for (const kind of ["zlib", "raw", "gzip"]) {
            const res = await tryStreamDecompress(kind, data);
            const base = `${outPrefix}.at${off}.${kind}`;
            if (res.out.length) fs.writeFileSync(`${base}.inflated.bin`, res.out);
            console.log(
                JSON.stringify(
                    {
                        off,
                        kind,
                        outLen: res.out.length,
                        sig: res.out.length ? detectSig(res.out) : null,
                        err: res.err,
                        outPath: res.out.length ? `${base}.inflated.bin` : null,
                    },
                    null,
                    2,
                ),
            );
        }

        if (scan === 0) break;
    }
}
