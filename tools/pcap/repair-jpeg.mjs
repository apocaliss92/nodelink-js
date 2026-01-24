#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function usage() {
    console.error(`Usage:
  node tools/pcap/repair-jpeg.mjs --in <file> [--out <file>] [--drop-app 1|0] [--resync 1|0]

Attempts to salvage JPEGs that have corrupted APP/COM segments by removing them and (optionally) resyncing marker parsing.
This is a best-effort tool; output may still be invalid.`);
    process.exit(2);
}

function readU16BE(buf, off) {
    if (off + 2 > buf.length) return null;
    return (buf[off] << 8) | buf[off + 1];
}

function findNextMarker(buf, start) {
    // Finds the next 0xFFxx marker where xx != 0x00 and xx != 0xFF.
    for (let i = start; i + 1 < buf.length; i++) {
        if (buf[i] !== 0xff) continue;
        let j = i;
        while (j < buf.length && buf[j] === 0xff) j++;
        if (j >= buf.length) return null;
        const m = buf[j];
        if (m === 0x00 || m === 0xff) continue;
        return i;
    }
    return null;
}

function isStandaloneMarker(m) {
    // Markers without length.
    if (m === 0xd8 || m === 0xd9) return true; // SOI/EOI
    if (m >= 0xd0 && m <= 0xd7) return true; // RST0..RST7
    if (m === 0x01) return true; // TEM
    return false;
}

function main() {
    const argv = process.argv.slice(2);
    let inPath = null;
    let outPath = null;
    let dropApp = true;
    let resync = true;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--in") inPath = String(argv[++i] ?? "");
        else if (a === "--out") outPath = String(argv[++i] ?? "");
        else if (a === "--drop-app") dropApp = (String(argv[++i] ?? "1") !== "0");
        else if (a === "--resync") resync = (String(argv[++i] ?? "1") !== "0");
        else usage();
    }

    if (!inPath) usage();
    if (!outPath) outPath = `${inPath}.repaired.jpg`;

    const buf = fs.readFileSync(inPath);
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
        throw new Error(`Not a JPEG (missing SOI): ${inPath}`);
    }

    const out = [];
    out.push(buf.subarray(0, 2)); // SOI

    let pos = 2;
    let sawSOS = false;

    while (pos < buf.length) {
        // Expect a marker.
        if (buf[pos] !== 0xff) {
            const next = resync ? findNextMarker(buf, pos) : null;
            if (next == null) break;
            pos = next;
        }

        // Skip fill 0xFF.
        let ff = pos;
        while (ff < buf.length && buf[ff] === 0xff) ff++;
        if (ff >= buf.length) break;
        const marker = buf[ff];
        if (marker === 0x00) {
            // Stuffed byte, should only happen after SOS; if we see it here, resync.
            const next = resync ? findNextMarker(buf, ff + 1) : null;
            if (next == null) break;
            pos = next;
            continue;
        }

        const markerStart = pos;
        pos = ff + 1; // now points to marker byte

        // Consume marker byte.
        pos += 1;

        if (marker === 0xd9) {
            out.push(buf.subarray(markerStart, pos));
            break;
        }

        if (marker === 0xda) {
            // Start of Scan: copy the SOS segment and the rest of the file as-is.
            const len = readU16BE(buf, pos);
            if (len == null || len < 2 || pos + len > buf.length) {
                // Corrupted SOS length; just copy rest.
                out.push(buf.subarray(markerStart));
            } else {
                out.push(buf.subarray(markerStart, pos + len));
                out.push(buf.subarray(pos + len));
            }
            sawSOS = true;
            break;
        }

        if (isStandaloneMarker(marker)) {
            out.push(buf.subarray(markerStart, pos));
            continue;
        }

        const segLen = readU16BE(buf, pos);
        if (segLen == null || segLen < 2) {
            const next = resync ? findNextMarker(buf, pos + 1) : null;
            if (next == null) break;
            pos = next;
            continue;
        }

        const segEnd = pos + segLen;
        if (segEnd > buf.length) {
            const next = resync ? findNextMarker(buf, pos + 1) : null;
            if (next == null) break;
            pos = next;
            continue;
        }

        const isApp = marker >= 0xe0 && marker <= 0xef;
        const isCom = marker === 0xfe;

        if (!(dropApp && (isApp || isCom))) {
            out.push(buf.subarray(markerStart, segEnd));
        }

        pos = segEnd;
    }

    fs.writeFileSync(outPath, Buffer.concat(out));

    const summary = {
        ok: true,
        inPath,
        outPath,
        inLen: buf.length,
        outLen: fs.statSync(outPath).size,
        dropApp,
        resync,
        sawSOS,
    };
    console.log(JSON.stringify(summary, null, 2));
}

main();
