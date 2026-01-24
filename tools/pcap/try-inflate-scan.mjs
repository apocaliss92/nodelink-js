#!/usr/bin/env node
import fs from "node:fs";
import zlib from "node:zlib";

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function isZlibHeader(b0, b1) {
    // RFC1950: CMF/FLG where (CMF*256 + FLG) % 31 == 0.
    // Most captures show CMF=0x78; keep it strict to reduce false positives.
    if (b0 !== 0x78) return false;
    const v = (b0 << 8) | b1;
    return v % 31 === 0;
}

function sniff(pt) {
    const head = pt.subarray(0, 32);
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

async function inflatePartial(slice, kind) {
    const chunks = [];
    let outLen = 0;
    let endedOk = false;

    const stream =
        kind === "inflate"
            ? zlib.createInflate()
            : zlib.createInflateRaw();

    const done = new Promise((resolve) => {
        stream.on("data", (c) => {
            chunks.push(c);
            outLen += c.length;
        });
        stream.on("end", () => {
            endedOk = true;
            resolve({ ok: true });
        });
        stream.on("error", (err) => resolve({ ok: false, err }));
    });

    stream.end(slice);
    const r = await done;
    const out = chunks.length ? Buffer.concat(chunks, outLen) : Buffer.alloc(0);
    return { out, endedOk, err: r.ok ? undefined : r.err };
}

async function main() {
    const file = process.argv[2];
    if (!file) {
        console.error(
            "Usage: node tools/pcap/try-inflate-scan.mjs <file> [--limit <bytes>] [--max-window <bytes>] [--to-eof] [--step <bytes>] [--write] [--out-dir <dir>]",
        );
        process.exit(2);
    }

    let limit = 4096;
    let maxWindow = 128 * 1024;
    let step = 512;
    let toEof = false;
    let write = false;
    let outDir = "pcap/reports/dec/inflated";
    let partial = false;

    for (let i = 3; i < process.argv.length; i++) {
        if (process.argv[i] === "--limit") limit = Number(process.argv[++i] ?? "0") || limit;
        else if (process.argv[i] === "--max-window") maxWindow = Number(process.argv[++i] ?? "0") || maxWindow;
        else if (process.argv[i] === "--to-eof") toEof = true;
        else if (process.argv[i] === "--step") step = Number(process.argv[++i] ?? "0") || step;
        else if (process.argv[i] === "--write") write = true;
        else if (process.argv[i] === "--out-dir") outDir = String(process.argv[++i] ?? outDir);
        else if (process.argv[i] === "--partial") partial = true;
    }

    const buf = fs.readFileSync(file);
    const headers = [];
    const scanMax = Math.min(buf.length - 2, limit);
    for (let off = 0; off < scanMax; off++) {
        const b0 = buf[off];
        const b1 = buf[off + 1];
        if (isZlibHeader(b0, b1)) headers.push(off);
    }

    console.log(JSON.stringify({ file, len: buf.length, scanMax, headers }, null, 2));

    if (write) ensureDir(outDir);
    const base = file.split("/").pop() ?? "out";


    for (const off of headers) {
        const maxEnd = toEof ? buf.length : Math.min(buf.length, off + maxWindow);

        if (partial) {
            const slice = buf.subarray(off, maxEnd);
            for (const kind of ["inflate", "inflateRaw"]) {
                const { out, endedOk, err } = await inflatePartial(slice, kind);
                const s = sniff(out);
                console.log(
                    JSON.stringify(
                        {
                            ok: endedOk,
                            partial: true,
                            off,
                            end: maxEnd,
                            win: maxEnd - off,
                            kind,
                            outLen: out.length,
                            err: err ? String(err.message ?? err) : undefined,
                            ...s,
                        },
                        null,
                        2,
                    ),
                );
                if (write && out.length) {
                    const outPath = `${outDir}/${base}.zlib@${off}.${kind}.partial.win${maxEnd - off}.out${out.length}.bin`;
                    fs.writeFileSync(outPath, out);
                }
                if (s.jpg || s.png || s.ftyp) return;
            }
            continue;
        }

        for (let end = off + 32; end <= maxEnd; end += step) {
            const slice = buf.subarray(off, end);
            for (const kind of ["inflate", "inflateRaw"]) {
                try {
                    const out = kind === "inflate" ? zlib.inflateSync(slice) : zlib.inflateRawSync(slice);
                    const s = sniff(out);
                    console.log(JSON.stringify({ ok: true, off, end, win: end - off, kind, outLen: out.length, ...s }, null, 2));
                    if (write) {
                        const outPath = `${outDir}/${base}.zlib@${off}.${kind}.win${end - off}.out${out.length}.bin`;
                        fs.writeFileSync(outPath, out);
                    }
                    if (s.jpg || s.png || s.ftyp) return;
                } catch {
                    // ignore
                }
            }
        }
    }
}

main();
