#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function usage() {
    console.error(`Usage:
  node tools/pcap/carve-media.mjs <input.bin> --out <dir-or-prefix>

Options:
    --jpeg-strict            Parse JPEG markers (fewer false positives; default: false)
    --annexb-min-nals <n>     Minimum NAL units per Annex-B segment (default: 30)
    --annexb-min-bytes <n>    Minimum bytes per Annex-B segment (default: 1024)
    --annexb-max-gap <n>      Max gap between start codes to keep same segment (default: 65536)
    --annexb-max-out <n>      Max Annex-B segments to write (default: 20)
    --nallen-min-nals <n>     Minimum NALs for length-prefixed sequences (default: 60)
    --nallen-max-scan <n>     Max bytes scanned for NAL-length sequences (default: 524288)

Behavior:
  - Finds and extracts all JPEGs by SOI (FFD8FF...) and EOI (FFD9) when available.
  - Finds and extracts PNGs by signature and IEND marker.
  - Attempts to extract MP4/fMP4 by parsing ISO-BMFF boxes starting at ftyp/moov/moof.
    - Attempts to extract Annex-B H.264/H.265 elementary streams by start-code scanning.

Outputs:
  Writes carved files and a JSON report next to --out prefix.
`);
    process.exit(2);
}

function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}

function u32be(b, off) {
    return b.readUInt32BE(off) >>> 0;
}

function u64be(b, off) {
    // JS number is safe up to 2^53-1; box sizes should be small enough.
    const hi = BigInt(b.readUInt32BE(off) >>> 0);
    const lo = BigInt(b.readUInt32BE(off + 4) >>> 0);
    return Number((hi << 32n) | lo);
}

function findAll(buf, needle) {
    const hits = [];
    let at = 0;
    while (at >= 0 && at < buf.length) {
        at = buf.indexOf(needle, at);
        if (at < 0) break;
        hits.push(at);
        at += 1;
    }
    return hits;
}

function u16be(b, off) {
    return b.readUInt16BE(off) >>> 0;
}

function tryParseJpegAt(buf, start) {
    // Minimal structural validation to avoid false positives.
    if (start + 4 > buf.length) return null;
    if (buf[start] !== 0xff || buf[start + 1] !== 0xd8) return null;

    let off = start + 2;
    let sawSOF = false;

    while (off + 2 <= buf.length) {
        if (buf[off] !== 0xff) return null;

        // Skip fill bytes 0xFF.
        while (off < buf.length && buf[off] === 0xff) off++;
        if (off >= buf.length) return null;

        const marker = buf[off];
        off += 1;

        // Standalone markers.
        if (marker === 0xd9) {
            if (!sawSOF) return null;
            return { end: off };
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            continue;
        }

        if (off + 2 > buf.length) return null;
        const segLen = u16be(buf, off);
        if (segLen < 2) return null;
        const segEnd = off + segLen;
        if (segEnd > buf.length) return null;

        // SOF markers indicate width/height etc.
        if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            sawSOF = true;
        }

        if (marker === 0xda) {
            // SOS: after its header, scan entropy-coded data until EOI.
            let scan = segEnd;
            while (scan + 1 < buf.length) {
                const b = buf[scan];
                if (b !== 0xff) {
                    scan += 1;
                    continue;
                }
                const b2 = buf[scan + 1];
                if (b2 === 0x00) {
                    // Stuffed 0xFF in entropy data.
                    scan += 2;
                    continue;
                }
                if (b2 === 0xd9) {
                    if (!sawSOF) return null;
                    return { end: scan + 2 };
                }
                if (b2 >= 0xd0 && b2 <= 0xd7) {
                    // Restart markers.
                    scan += 2;
                    continue;
                }
                // Some other marker inside scan; continue from there.
                scan += 2;
            }
            return null;
        }

        off = segEnd;
    }

    return null;
}

function carveJpegsStrict(buf, outBase) {
    const soi2 = Buffer.from([0xff, 0xd8]);
    const starts = findAll(buf, soi2);

    /** @type {{index:number,start:number,end:number,outPath:string,size:number}[]} */
    const carved = [];

    let outIndex = 0;
    for (const start of starts) {
        const parsed = tryParseJpegAt(buf, start);
        if (!parsed) continue;
        const end = parsed.end;
        if (end <= start + 64) continue;

        const outPath = `${outBase}.jpgStrict.${String(outIndex).padStart(4, "0")}.at${start}.len${end - start}.jpg`;
        fs.writeFileSync(outPath, buf.subarray(start, end));
        carved.push({ index: outIndex, start, end, outPath, size: end - start });
        outIndex++;
        if (outIndex >= 50) break;
    }

    return { count: carved.length, starts: starts.length, carved };
}

function carveJpegs(buf, outBase) {
    const soi3 = Buffer.from([0xff, 0xd8, 0xff]);
    const eoi2 = Buffer.from([0xff, 0xd9]);
    const starts = findAll(buf, soi3);

    /** @type {{index:number,start:number,end:number,hasEoi:boolean,outPath:string,size:number}[]} */
    const carved = [];

    for (let i = 0; i < starts.length; i++) {
        const start = starts[i];
        const nextStart = i + 1 < starts.length ? starts[i + 1] : buf.length;
        let end = -1;
        let hasEoi = false;

        const eoi = buf.indexOf(eoi2, start + 2);
        if (eoi >= 0 && eoi + 2 <= nextStart) {
            end = eoi + 2;
            hasEoi = true;
        } else {
            // Fallback: cut until next SOI (keeps most viewers happy if stream is contiguous)
            end = nextStart;
        }

        if (end <= start + 8) continue;

        const outPath = `${outBase}.jpg.${String(i).padStart(4, "0")}.at${start}.len${end - start}.jpg`;
        fs.writeFileSync(outPath, buf.subarray(start, end));
        carved.push({ index: i, start, end, hasEoi, outPath, size: end - start });
    }

    return { count: carved.length, starts: starts.length, carved };
}

function carvePngs(buf, outBase) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const iendTail = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const starts = findAll(buf, sig);

    /** @type {{index:number,start:number,end:number,outPath:string,size:number}[]} */
    const carved = [];

    for (let i = 0; i < starts.length; i++) {
        const start = starts[i];
        const nextStart = i + 1 < starts.length ? starts[i + 1] : buf.length;
        const iend = buf.indexOf(iendTail, start + sig.length);
        let end = -1;
        if (iend >= 0 && iend + iendTail.length <= nextStart) {
            end = iend + iendTail.length;
        } else {
            end = nextStart;
        }
        if (end <= start + 16) continue;
        const outPath = `${outBase}.png.${String(i).padStart(4, "0")}.at${start}.len${end - start}.png`;
        fs.writeFileSync(outPath, buf.subarray(start, end));
        carved.push({ index: i, start, end, outPath, size: end - start });
    }

    return { count: carved.length, starts: starts.length, carved };
}

function looksLikeBoxType(typeBytes) {
    for (const c of typeBytes) {
        const ok =
            (c >= 0x61 && c <= 0x7a) || // a-z
            (c >= 0x41 && c <= 0x5a) || // A-Z
            (c >= 0x30 && c <= 0x39) || // 0-9
            c === 0x20; // space (rare)
        if (!ok) return false;
    }
    return true;
}

function parseMp4BoxesFrom(buf, start) {
    const boxes = [];
    let off = start;
    while (off + 8 <= buf.length) {
        const size32 = u32be(buf, off);
        const type = buf.subarray(off + 4, off + 8);
        if (!looksLikeBoxType(type)) break;

        let size = size32;
        let header = 8;
        if (size32 === 1) {
            if (off + 16 > buf.length) break;
            size = u64be(buf, off + 8);
            header = 16;
        } else if (size32 === 0) {
            // extends to EOF
            size = buf.length - off;
        }

        if (!Number.isFinite(size) || size < header || off + size > buf.length) break;

        const typeStr = type.toString("ascii");
        boxes.push({ off, size, type: typeStr });
        off += size;

        // Stop if we parsed a lot without seeing media boxes
        if (boxes.length > 20000) break;
    }

    return boxes;
}

function carveMp4(buf, outBase) {
    const ftyp = Buffer.from("ftyp", "ascii");
    const moov = Buffer.from("moov", "ascii");
    const moof = Buffer.from("moof", "ascii");

    const hits = [];
    for (const [kind, needle] of [
        ["ftyp", ftyp],
        ["moov", moov],
        ["moof", moof],
    ]) {
        for (const at of findAll(buf, needle)) {
            if (at < 4) continue;
            hits.push({ kind, at });
        }
    }

    // Prefer earlier hits.
    hits.sort((a, b) => a.at - b.at);

    /** @type {{kind:string,start:number,end:number,boxes:any[],outPath:string,size:number,reason:string}[]} */
    const carved = [];

    // Try a few candidates (avoid pathological scans)
    for (const cand of hits.slice(0, 50)) {
        const start = cand.at - 4; // size field
        const boxes = parseMp4BoxesFrom(buf, start);
        if (boxes.length < 2) continue;

        // Require the first parsed type to match our hit kind (common sanity)
        if (boxes[0].type !== cand.kind) continue;

        const end = boxes[boxes.length - 1].off + boxes[boxes.length - 1].size;
        const size = end - start;
        if (size < 1024) continue;

        const outPath = `${outBase}.mp4.${cand.kind}.at${start}.len${size}.mp4`;
        fs.writeFileSync(outPath, buf.subarray(start, end));
        carved.push({ kind: cand.kind, start, end, boxes, outPath, size, reason: `boxes:${boxes.length}` });

        // If we got an ftyp-based parse, that's usually the best standalone MP4.
        if (cand.kind === "ftyp") break;
    }

    return { candidates: hits.length, carvedCount: carved.length, carved };
}

function findAnnexBStartCodes(buf) {
    /** @type {{at:number,len:3|4}[]} */
    const hits = [];
    // Scan for 00 00 01 or 00 00 00 01.
    for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] !== 0x00 || buf[i + 1] !== 0x00) continue;
        if (buf[i + 2] === 0x01) {
            hits.push({ at: i, len: 3 });
            i += 2;
            continue;
        }
        if (buf[i + 2] === 0x00 && buf[i + 3] === 0x01) {
            hits.push({ at: i, len: 4 });
            i += 3;
        }
    }
    return hits;
}

function carveAnnexB(buf, outBase, opts = {}) {
    const hits = findAnnexBStartCodes(buf);
    /** @type {{index:number,start:number,end:number,nalCount:number,codecGuess:string,counts:any,outPath:string,size:number,reason:string}[]} */
    const carved = [];

    // Heuristics: group start-codes into segments when they're reasonably close.
    const maxGap = Number.isFinite(opts.maxGap) ? opts.maxGap : 64 * 1024;
    const minNalCount = Number.isFinite(opts.minNalCount) ? opts.minNalCount : 30;
    const minBytes = Number.isFinite(opts.minBytes) ? opts.minBytes : 1024;
    const maxOut = Number.isFinite(opts.maxOut) ? opts.maxOut : 20;

    /** @type {{startHit:number,endHit:number}[]} */
    const segments = [];
    if (hits.length > 0) {
        let segStart = 0;
        for (let i = 1; i < hits.length; i++) {
            if (hits[i].at - hits[i - 1].at > maxGap) {
                segments.push({ startHit: segStart, endHit: i - 1 });
                segStart = i;
            }
        }
        segments.push({ startHit: segStart, endHit: hits.length - 1 });
    }

    let outIndex = 0;
    for (const seg of segments) {
        const start = hits[seg.startHit].at;
        const end = seg.endHit + 1 < hits.length ? hits[seg.endHit + 1].at : buf.length;
        const nalCount = seg.endHit - seg.startHit + 1;
        if (end - start < minBytes) continue;
        if (nalCount < minNalCount) continue;

        const counts = {
            h264: { sps: 0, pps: 0, idr: 0, other: 0 },
            hevc: { vps: 0, sps: 0, pps: 0, idr: 0, other: 0 },
        };

        for (let i = seg.startHit; i <= seg.endHit; i++) {
            const hdrOff = hits[i].at + hits[i].len;
            if (hdrOff >= buf.length) continue;
            const b = buf[hdrOff];

            const h264Type = b & 0x1f;
            if (h264Type === 7) counts.h264.sps++;
            else if (h264Type === 8) counts.h264.pps++;
            else if (h264Type === 5) counts.h264.idr++;
            else counts.h264.other++;

            const hevcType = (b >> 1) & 0x3f;
            if (hevcType === 32) counts.hevc.vps++;
            else if (hevcType === 33) counts.hevc.sps++;
            else if (hevcType === 34) counts.hevc.pps++;
            else if (hevcType === 19 || hevcType === 20) counts.hevc.idr++;
            else counts.hevc.other++;
        }

        let codecGuess = "bin";
        if (counts.hevc.vps + counts.hevc.sps + counts.hevc.pps > 0) codecGuess = "h265";
        else if (counts.h264.sps + counts.h264.pps > 0) codecGuess = "h264";

        // If we don't see SPS at all, it's likely not decodable standalone; still keep if it's dense.
        const hasParamSets =
            codecGuess === "h265"
                ? counts.hevc.sps + counts.hevc.pps + counts.hevc.vps > 0
                : counts.h264.sps + counts.h264.pps > 0;
        const reason = `${codecGuess};nals:${nalCount};paramSets:${hasParamSets}`;

        const size = end - start;
        const outPath = `${outBase}.annexb.${String(outIndex).padStart(4, "0")}.at${start}.len${size}.${codecGuess}`;
        fs.writeFileSync(outPath, buf.subarray(start, end));
        carved.push({ index: outIndex, start, end, nalCount, codecGuess, counts, outPath, size, reason });
        outIndex++;

        if (outIndex >= maxOut) break;
    }

    return { startCodes: hits.length, segments: segments.length, carvedCount: carved.length, carved };
}

function looksLikeNalHeaderByte(b) {
    // Forbidden zero bit must be 0 for both H.264 and H.265.
    return (b & 0x80) === 0;
}

function parseLengthPrefixedNalSequence(buf, start, { maxNals = 2000 } = {}) {
    let off = start;
    let nalCount = 0;

    const counts = {
        h264: { sps: 0, pps: 0, idr: 0, other: 0 },
        hevc: { vps: 0, sps: 0, pps: 0, idr: 0, other: 0 },
    };

    while (off + 4 <= buf.length && nalCount < maxNals) {
        const len = u32be(buf, off);
        if (len === 0) break;
        if (len > buf.length - off - 4) break;
        if (len > 512 * 1024) break;

        const hdrOff = off + 4;
        const b = buf[hdrOff];
        if (!looksLikeNalHeaderByte(b)) break;

        const h264Type = b & 0x1f;
        if (h264Type === 7) counts.h264.sps++;
        else if (h264Type === 8) counts.h264.pps++;
        else if (h264Type === 5) counts.h264.idr++;
        else counts.h264.other++;

        const hevcType = (b >> 1) & 0x3f;
        if (hevcType === 32) counts.hevc.vps++;
        else if (hevcType === 33) counts.hevc.sps++;
        else if (hevcType === 34) counts.hevc.pps++;
        else if (hevcType === 19 || hevcType === 20) counts.hevc.idr++;
        else counts.hevc.other++;

        off += 4 + len;
        nalCount++;
    }

    return { start, end: off, nalCount, counts };
}

function carveLengthPrefixedNals(buf, outBase, opts = {}) {
    /** @type {{index:number,start:number,end:number,nalCount:number,codecGuess:string,counts:any,outPath:string,size:number,reason:string}[]} */
    const carved = [];
    const startCode = Buffer.from([0x00, 0x00, 0x00, 0x01]);

    const minNalCount = Number.isFinite(opts.minNalCount) ? opts.minNalCount : 60;
    const maxScanLimit = Number.isFinite(opts.maxScan) ? opts.maxScan : 512 * 1024;
    const maxScan = Math.min(buf.length - 8, maxScanLimit);

    let outIndex = 0;
    for (let i = 0; i < maxScan; i++) {
        if (i + 8 > buf.length) break;
        const len = u32be(buf, i);
        if (len === 0) continue;
        if (len > buf.length - i - 4) continue;
        if (len > 512 * 1024) continue;

        const hdr = buf[i + 4];
        if (!looksLikeNalHeaderByte(hdr)) continue;

        // Quick sanity: H.264 types are small; HEVC types too, but different distribution.
        const h264Type = hdr & 0x1f;
        const hevcType = (hdr >> 1) & 0x3f;
        const plausible = (h264Type >= 1 && h264Type <= 12) || (hevcType >= 0 && hevcType <= 40);
        if (!plausible) continue;

        const seq = parseLengthPrefixedNalSequence(buf, i);
        if (seq.nalCount < minNalCount) continue;

        let codecGuess = "bin";
        if (seq.counts.hevc.vps + seq.counts.hevc.sps + seq.counts.hevc.pps > 0) codecGuess = "h265";
        else if (seq.counts.h264.sps + seq.counts.h264.pps > 0) codecGuess = "h264";

        const hasParamSets =
            codecGuess === "h265"
                ? seq.counts.hevc.vps + seq.counts.hevc.sps + seq.counts.hevc.pps > 0
                : seq.counts.h264.sps + seq.counts.h264.pps > 0;
        if (!hasParamSets) continue;

        // Convert to Annex-B.
        /** @type {Buffer[]} */
        const outChunks = [];
        let off = i;
        for (let n = 0; n < seq.nalCount && off + 4 <= seq.end; n++) {
            const nlen = u32be(buf, off);
            if (nlen === 0 || nlen > seq.end - off - 4) break;
            outChunks.push(startCode);
            outChunks.push(buf.subarray(off + 4, off + 4 + nlen));
            off += 4 + nlen;
        }

        const outBuf = Buffer.concat(outChunks);
        const outPath = `${outBase}.nallen.${String(outIndex).padStart(4, "0")}.at${i}.nals${seq.nalCount}.len${outBuf.length}.${codecGuess}`;
        fs.writeFileSync(outPath, outBuf);
        carved.push({
            index: outIndex,
            start: i,
            end: seq.end,
            nalCount: seq.nalCount,
            codecGuess,
            counts: seq.counts,
            outPath,
            size: outBuf.length,
            reason: `nals:${seq.nalCount};${codecGuess}`,
        });
        outIndex++;

        // Skip ahead to avoid O(n^2) rescans on the same sequence.
        i = Math.max(i, seq.end - 1);
        if (outIndex >= 10) break;
    }

    return { carvedCount: carved.length, carved };
}

function main() {
    const input = process.argv[2];
    if (!input) usage();

    let out = null;
    let jpegStrict = false;
    const annexb = { minNalCount: null, minBytes: null, maxGap: null, maxOut: null };
    const nallen = { minNalCount: null, maxScan: null };
    for (let i = 3; i < process.argv.length; i++) {
        if (process.argv[i] === "--out") out = String(process.argv[++i] ?? "");
        else if (process.argv[i] === "--jpeg-strict") jpegStrict = true;
        else if (process.argv[i] === "--annexb-min-nals") annexb.minNalCount = Number(process.argv[++i]);
        else if (process.argv[i] === "--annexb-min-bytes") annexb.minBytes = Number(process.argv[++i]);
        else if (process.argv[i] === "--annexb-max-gap") annexb.maxGap = Number(process.argv[++i]);
        else if (process.argv[i] === "--annexb-max-out") annexb.maxOut = Number(process.argv[++i]);
        else if (process.argv[i] === "--nallen-min-nals") nallen.minNalCount = Number(process.argv[++i]);
        else if (process.argv[i] === "--nallen-max-scan") nallen.maxScan = Number(process.argv[++i]);
    }
    if (!out) usage();

    const buf = fs.readFileSync(input);

    // If --out is a directory, place files inside it using the input basename.
    let outBase = out;
    if (out.endsWith(path.sep) || (fs.existsSync(out) && fs.statSync(out).isDirectory())) {
        ensureDir(out);
        outBase = path.join(out, path.basename(input));
    } else {
        ensureDir(path.dirname(outBase));
    }

    const report = {
        input,
        len: buf.length,
        outBase,
        params: {
            jpegStrict,
            annexb: {
                minNalCount: Number.isFinite(annexb.minNalCount) ? annexb.minNalCount : 30,
                minBytes: Number.isFinite(annexb.minBytes) ? annexb.minBytes : 1024,
                maxGap: Number.isFinite(annexb.maxGap) ? annexb.maxGap : 64 * 1024,
                maxOut: Number.isFinite(annexb.maxOut) ? annexb.maxOut : 20,
            },
            nallen: {
                minNalCount: Number.isFinite(nallen.minNalCount) ? nallen.minNalCount : 60,
                maxScan: Number.isFinite(nallen.maxScan) ? nallen.maxScan : 512 * 1024,
            },
        },
        jpg: jpegStrict ? carveJpegsStrict(buf, outBase) : carveJpegs(buf, outBase),
        png: carvePngs(buf, outBase),
        mp4: carveMp4(buf, outBase),
        annexb: carveAnnexB(buf, outBase, annexb),
        nallen: carveLengthPrefixedNals(buf, outBase, nallen),
    };

    const outReport = `${outBase}.carve.report.json`;
    fs.writeFileSync(outReport, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: true, outReport }, null, 2));
}

main();
