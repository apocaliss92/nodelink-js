#!/usr/bin/env node
import fs from "node:fs";
import zlib from "node:zlib";

function isZlibHeader(b0, b1) {
    if (b0 !== 0x78) return false;
    const v = (b0 << 8) | b1;
    return v % 31 === 0;
}

function sniff(pt) {
    const head = pt.subarray(0, 16);
    const jpg = pt.length >= 3 && pt[0] === 0xff && pt[1] === 0xd8 && pt[2] === 0xff;
    const png =
        pt.length >= 8 &&
        pt[0] === 0x89 &&
        pt[1] === 0x50 &&
        pt[2] === 0x4e &&
        pt[3] === 0x47 &&
        pt[4] === 0x0d &&
        pt[5] === 0x0a &&
        pt[6] === 0x1a &&
        pt[7] === 0x0a;
    const ftyp = pt.length >= 8 && pt.subarray(4, 8).toString("ascii") === "ftyp";
    return { headHex: head.toString("hex"), jpg, png, ftyp };
}

function main() {
    const file = process.argv[2];
    if (!file) {
        console.error("Usage: node tools/pcap/try-inflate.mjs <file> [--limit <bytes>] [--write <outFile>]");
        process.exit(2);
    }

    let limit = 1024 * 1024;
    let write = null;
    for (let i = 3; i < process.argv.length; i++) {
        if (process.argv[i] === "--limit") limit = Number(process.argv[++i] ?? "0") || limit;
        else if (process.argv[i] === "--write") write = String(process.argv[++i] ?? "");
    }

    const buf = fs.readFileSync(file);
    const max = Math.min(buf.length - 2, limit);

    const headers = [];
    for (let i = 0; i < max; i++) {
        const b0 = buf[i];
        const b1 = buf[i + 1];
        if (isZlibHeader(b0, b1)) headers.push(i);
    }

    console.log(JSON.stringify({ file, len: buf.length, zlibHeaders: headers.slice(0, 50) }, null, 2));

    for (const off of headers.slice(0, 50)) {
        const slice = buf.subarray(off);
        for (const kind of ["inflate", "inflateRaw"]) {
            try {
                const out = kind === "inflate" ? zlib.inflateSync(slice) : zlib.inflateRawSync(slice);
                const s = sniff(out);
                console.log(JSON.stringify({ ok: true, off, kind, outLen: out.length, ...s }, null, 2));
                if (write) {
                    fs.writeFileSync(write, out);
                    console.log(`Wrote ${out.length} bytes to ${write}`);
                }
                if (s.jpg || s.png || s.ftyp) return;
            } catch {
                // ignore
            }
        }
    }
}

main();
