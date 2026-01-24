#!/usr/bin/env node
/**
 * Decrypt a set of exported Baichuan binary chunks (e.g. cmd5 payloads),
 * concatenate decrypted bytes, and try to zlib-inflate (optionally with a preset dict).
 *
 * This is meant for PCAP reverse-engineering workflows where single chunks are
 * insufficient to inflate successfully.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

import "dotenv/config";
import { deriveAesKey } from "../../dist/index.cjs";
import { BC_AES_IV } from "../../dist/src/protocol/constants.js";

function usage() {
    console.error(`Usage:
  node tools/pcap/decrypt-concat-inflate.mjs --glob <pattern> --nonce <nonce> --out <prefix> [options]

Options:
  --glob <pattern>         Glob pattern (shell-expanded) for input files
  --nonce <nonce>          Nonce from negotiation (cmdId=1)
  --skip <n>               Skip N bytes at start of each file before parsing header (default: 0)
  --header-len <n>         Header length (default: 32)
    --encrypt-len <n>        Per-chunk decrypt length (default: 1024)
    --encrypt-lens <csv>     Try multiple encryptLen values (overrides --encrypt-len)
    --chunk-size <n>         Chunk size for perChunkFirstN (default: 1024)
    --chunk-sizes <csv>      Try multiple chunkSize values (overrides --chunk-size)
  --mode <name>            aes-128-ctr | aes-128-cfb | aes-128-cbc (default: aes-128-ctr)
    --modes <csv>            Try multiple AES modes (overrides --mode)
    --strategy <name>        firstN | all | perBlockReset | dropIvFirstN | dropIvAll | perChunkFirstN | perChunkAll | perChunkDropIvFirstN | perChunkDropIvAll
                          | concatFirstN | concatAll | concatDropIvFirstN | concatDropIvAll (default: perChunkFirstN)
    --strategies <csv>       Try multiple strategies (overrides --strategy)
    --block <n>              Block size for perBlockReset (default: 0 = encryptLen)
  --key <spec>             sessionKey | xor(sessionKey_header0) | xor(sessionKey_header1) | hkdf(sessionKey_salt_header0_info_header1) | md5(sessionKey_header0) | md5(sessionKey_header1)
                          | md5(header0) | md5(header1) | md5(header0_header1) | md5(header1_header0) | sha256(header0_header1) | sha256(header1_header0)
                          | md5(header0_sessionKey) | md5(header1_sessionKey) | md5(sessionKey_header0) | md5(sessionKey_header1)
    --iv <spec>              fixedIv | bcIv | sessionKey | header0 | header1 | xor(header0_header1)
                                                    | md5(header0_header1) | md5(header1_header0)
                                                    | md5(header0) | md5(header1) | md5(sessionKey)
                                                    | md5(sessionKey_header0) | md5(sessionKey_header1)
                                                    | md5(header0_sessionKey) | md5(header1_sessionKey)
    --auto                   Try a built-in set of key/iv combos (scanner-like)
    --max-param-combos <n>   Limit number of (mode,key,iv) combinations in --auto (0 = no limit)
  --dictid <hex>           Optional zlib DictID (e.g. edaefd54)
  --dict-dir <dir>         Where to look for dict files (default: pcap/reports/apk/dicts)
    --dict-sweep             If a dict is required but missing, try all *.bin dict files found in --dict-dir
    --dict-sweep-always      For each inflate candidate, also try all dict *.bin files (even if no dict is required)
  --zlib-at <n>            Force inflate start offset (otherwise scans for zlib header)
    --max-zlib-hits <n>       When scanning for zlib headers, try up to N candidates (default: 32)
        --zlib-max-output <n>     Cap zlib output bytes to avoid OOM (default: 67108864)
        --no-inflate            Skip all zlib inflate attempts (plaintext signature scan only)
        --inflate-accept-len     Consider inflate success also by size-only heuristic (weaker; default: false)
        --attempts-max <n>        Keep at most N attempt entries in the report (default: 20000)
`);
    process.exit(2);
}

function readEnvPassword() {
    return (
        process.env.BAICHUAN_PASSWORD ??
        process.env.TCP_PASSWORD ??
        process.env.NVR_PASSWORD ??
        ""
    ).trim();
}

function parseHex32(s) {
    const t = String(s ?? "").trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{1,8}$/.test(t)) throw new Error(`Invalid hex32: ${s}`);
    return Number.parseInt(t, 16) >>> 0;
}

function md5_16(buf) {
    return crypto.createHash("md5").update(buf).digest().subarray(0, 16);
}

function sha256_16(buf) {
    return crypto.createHash("sha256").update(buf).digest().subarray(0, 16);
}

function hkdfSha256_16(ikm, salt, info) {
    return crypto.hkdfSync("sha256", ikm, salt ?? Buffer.alloc(0), info ?? Buffer.alloc(0), 16);
}

function xor16(a, b) {
    const out = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) out[i] = (a[i] ^ b[i]) & 0xff;
    return out;
}

function aesDec(mode, key, iv, buf) {
    if (mode.endsWith("-cbc") && (buf.length % 16) !== 0) {
        buf = buf.subarray(0, buf.length - (buf.length % 16));
    }
    const d = crypto.createDecipheriv(mode, key, iv);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(buf), d.final()]);
}

function decLenForMode(mode, ctLen) {
    if (ctLen <= 0) return 0;
    if (mode.endsWith("-cbc")) return ctLen - (ctLen % 16);
    return ctLen;
}

function estimatePlainLen({ mode, strategy, ctLen, encryptLen, chunkSize, block }) {
    const firstNLen = (len, n) => {
        const nn = Math.min(n, len);
        const decHead = decLenForMode(mode, nn);
        return decHead + (len - nn);
    };

    switch (strategy) {
        case "firstN":
            return firstNLen(ctLen, encryptLen);
        case "all":
            return decLenForMode(mode, ctLen);
        case "concatFirstN":
            return firstNLen(ctLen, encryptLen);
        case "concatAll":
            return decLenForMode(mode, ctLen);
        case "perBlockReset": {
            const b = block > 0 ? block : encryptLen;
            let out = 0;
            for (let off = 0; off < ctLen; off += b) {
                out += decLenForMode(mode, Math.min(b, ctLen - off));
            }
            return out;
        }
        case "dropIvFirstN": {
            if (ctLen < 16) return ctLen;
            const encLen = ctLen - 16;
            return firstNLen(encLen, encryptLen);
        }
        case "dropIvAll": {
            if (ctLen < 16) return ctLen;
            return decLenForMode(mode, ctLen - 16);
        }
        case "concatDropIvFirstN": {
            if (ctLen < 16) return ctLen;
            const encLen = ctLen - 16;
            return firstNLen(encLen, encryptLen);
        }
        case "concatDropIvAll": {
            if (ctLen < 16) return ctLen;
            return decLenForMode(mode, ctLen - 16);
        }
        case "perChunkFirstN": {
            let out = 0;
            for (let off = 0; off < ctLen; off += chunkSize) {
                out += firstNLen(Math.min(chunkSize, ctLen - off), encryptLen);
            }
            return out;
        }
        case "perChunkAll": {
            let out = 0;
            for (let off = 0; off < ctLen; off += chunkSize) {
                out += decLenForMode(mode, Math.min(chunkSize, ctLen - off));
            }
            return out;
        }
        case "perChunkDropIvFirstN": {
            let out = 0;
            for (let off = 0; off < ctLen; off += chunkSize) {
                const segLen = Math.min(chunkSize, ctLen - off);
                if (segLen < 16) out += segLen;
                else out += firstNLen(segLen - 16, encryptLen);
            }
            return out;
        }
        case "perChunkDropIvAll": {
            let out = 0;
            for (let off = 0; off < ctLen; off += chunkSize) {
                const segLen = Math.min(chunkSize, ctLen - off);
                if (segLen < 16) out += segLen;
                else out += decLenForMode(mode, segLen - 16);
            }
            return out;
        }
        default:
            return ctLen;
    }
}

function concatAllCiphertexts(inputs) {
    let total = 0;
    for (const it of inputs) total += it.ct.length;
    const out = Buffer.allocUnsafe(total);
    let off = 0;
    for (const it of inputs) {
        it.ct.copy(out, off);
        off += it.ct.length;
    }
    return out;
}

function decryptFirstN({ mode, key, iv, ct, n }) {
    const head = aesDec(mode, key, iv, ct.subarray(0, Math.min(n, ct.length)));
    return Buffer.concat([head, ct.subarray(Math.min(n, ct.length))]);
}

function decryptAll({ mode, key, iv, ct }) {
    return aesDec(mode, key, iv, ct);
}

function decryptPerBlockReset({ mode, key, iv, ct, block }) {
    const out = [];
    for (let off = 0; off < ct.length; off += block) {
        const chunk = ct.subarray(off, Math.min(ct.length, off + block));
        out.push(aesDec(mode, key, iv, chunk));
    }
    return Buffer.concat(out);
}

function decryptDropIvFirstN({ mode, key, ct, n }) {
    if (ct.length < 16) return ct;
    const iv = ct.subarray(0, 16);
    const enc = ct.subarray(16);
    const head = aesDec(mode, key, iv, enc.subarray(0, Math.min(n, enc.length)));
    return Buffer.concat([head, enc.subarray(Math.min(n, enc.length))]);
}

function decryptDropIvAll({ mode, key, ct }) {
    if (ct.length < 16) return ct;
    const iv = ct.subarray(0, 16);
    const enc = ct.subarray(16);
    return aesDec(mode, key, iv, enc);
}

function decryptPerChunkDropIvFirstN({ mode, key, ct, chunkSize, encryptLen }) {
    const outParts = [];
    for (let off = 0; off < ct.length; off += chunkSize) {
        const chunk = ct.subarray(off, Math.min(ct.length, off + chunkSize));
        if (chunk.length < 16) {
            outParts.push(chunk);
            continue;
        }
        const iv = chunk.subarray(0, 16);
        const enc = chunk.subarray(16);
        const n = Math.min(encryptLen, enc.length);
        const head = aesDec(mode, key, iv, enc.subarray(0, n));
        outParts.push(head);
        if (n < enc.length) outParts.push(enc.subarray(n));
    }
    return Buffer.concat(outParts);
}

function decryptPerChunkFirstN({ mode, key, iv, ct, chunkSize, encryptLen }) {
    const out = Buffer.allocUnsafe(ct.length);
    for (let off = 0; off < ct.length; off += chunkSize) {
        const chunk = ct.subarray(off, Math.min(ct.length, off + chunkSize));
        const n = Math.min(encryptLen, chunk.length);
        const head = aesDec(mode, key, iv, chunk.subarray(0, n));
        head.copy(out, off);
        if (n < chunk.length) chunk.subarray(n).copy(out, off + n);
    }
    return out;
}

function decryptPerChunkAll({ mode, key, iv, ct, chunkSize }) {
    const out = Buffer.allocUnsafe(ct.length);
    for (let off = 0; off < ct.length; off += chunkSize) {
        const chunk = ct.subarray(off, Math.min(ct.length, off + chunkSize));
        const dec = aesDec(mode, key, iv, chunk);
        dec.copy(out, off);
    }
    return out;
}

function decryptPerChunkDropIvAll({ mode, key, ct, chunkSize }) {
    const outParts = [];
    for (let off = 0; off < ct.length; off += chunkSize) {
        const chunk = ct.subarray(off, Math.min(ct.length, off + chunkSize));
        if (chunk.length < 16) {
            outParts.push(chunk);
            continue;
        }
        const iv = chunk.subarray(0, 16);
        const enc = chunk.subarray(16);
        outParts.push(aesDec(mode, key, iv, enc));
    }
    return Buffer.concat(outParts);
}

function isRfc1950ZlibHeader(cmf, flg) {
    if ((cmf & 0x0f) !== 8) return false;
    const cmfFlg = ((cmf << 8) | flg) & 0xffff;
    if (cmfFlg % 31 !== 0) return false;
    const cinfo = (cmf >> 4) & 0x0f;
    if (cinfo > 7) return false;
    return true;
}

function findFirstZlib(buf, maxScan = 256 * 1024) {
    const limit = Math.min(buf.length - 6, maxScan);
    for (let i = 0; i < limit; i++) {
        const cmf = buf[i];
        const flg = buf[i + 1];
        if (!isRfc1950ZlibHeader(cmf, flg)) continue;
        const fdict = (flg & 0x20) !== 0;
        const dictId = fdict ? buf.readUInt32BE(i + 2) >>> 0 : null;
        return { at: i, dictId };
    }
    return null;
}

function findZlibHeaders(buf, { maxScan = 256 * 1024, maxHits = 32 } = {}) {
    const hits = [];
    const limit = Math.min(buf.length - 6, maxScan);
    for (let i = 0; i < limit; i++) {
        const cmf = buf[i];
        const flg = buf[i + 1];
        if (!isRfc1950ZlibHeader(cmf, flg)) continue;
        const fdict = (flg & 0x20) !== 0;
        const dictId = fdict ? buf.readUInt32BE(i + 2) >>> 0 : null;
        hits.push({ at: i, dictId });
        if (hits.length >= maxHits) break;
    }
    return hits;
}

function findNeedle(buf, needle) {
    return buf.indexOf(needle);
}

function detectMediaSignature(buf, { maxAt = 512 * 1024 } = {}) {
    if (!buf || buf.length === 0) return { kind: null, at: -1 };
    // Common container signatures
    const jpg = Buffer.from([0xff, 0xd8, 0xff]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ftyp = Buffer.from("ftyp", "ascii");
    const moov = Buffer.from("moov", "ascii");
    const mdat = Buffer.from("mdat", "ascii");
    const lz4f = Buffer.from([0x04, 0x22, 0x4d, 0x18]);
    const annexB = Buffer.from([0x00, 0x00, 0x00, 0x01]);

    const checks = [
        ["jpg", jpg],
        ["png", png],
        ["ftyp", ftyp],
        ["moov", moov],
        ["mdat", mdat],
        ["lz4f", lz4f],
        ["annexb", annexB],
    ];
    for (const [k, n] of checks) {
        const at = findNeedle(buf, n);
        if (at >= 0 && at < maxAt) return { kind: k, at };
    }
    return { kind: null, at: -1 };
}

function extensionForSigKind(kind) {
    switch (kind) {
        case "jpg":
            return ".jpg";
        case "png":
            return ".png";
        case "ftyp":
        case "moov":
        case "mdat":
            return ".mp4";
        case "lz4f":
            return ".lz4";
        case "annexb":
            return ".annexb.bin";
        default:
            return ".bin";
    }
}

function carveBySignature(buf, sig) {
    if (!sig || !sig.kind || sig.at < 0 || sig.at >= buf.length) return null;
    const start = sig.at;
    let end = buf.length;

    if (sig.kind === "jpg") {
        const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), start);
        if (eoi < 0) return null;
        end = eoi + 2;
    } else if (sig.kind === "png") {
        // IEND chunk tail: 00 00 00 00 49 45 4E 44 AE 42 60 82
        const iend = buf.indexOf(Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]), start);
        if (iend < 0) return null;
        end = iend + 8;
    }

    return buf.subarray(start, end);
}

function isProbablyValidJpeg(jpgBuf) {
    if (!jpgBuf || jpgBuf.length < 4) return false;
    if (jpgBuf[0] !== 0xff || jpgBuf[1] !== 0xd8) return false; // SOI
    if (jpgBuf[jpgBuf.length - 2] !== 0xff || jpgBuf[jpgBuf.length - 1] !== 0xd9) return false; // EOI

    let off = 2;
    let sawSOF = false;
    let sawDQT = false;
    let sawDHT = false;
    let sawSOS = false;

    const isStandalone = (m) =>
        m === 0xd8 || // SOI
        m === 0xd9 || // EOI
        m === 0x01 || // TEM
        (m >= 0xd0 && m <= 0xd7); // RST

    while (off < jpgBuf.length) {
        if (jpgBuf[off] !== 0xff) return false;
        while (off < jpgBuf.length && jpgBuf[off] === 0xff) off++;
        if (off >= jpgBuf.length) return false;
        const marker = jpgBuf[off++];

        if (marker === 0xd9) {
            break;
        }

        if (isStandalone(marker)) continue;

        if (off + 2 > jpgBuf.length) return false;
        const segLen = jpgBuf.readUInt16BE(off);
        if (segLen < 2) return false;
        const segStart = off;
        const segEnd = segStart + segLen;
        if (segEnd > jpgBuf.length) return false;

        if (marker === 0xc0 || marker === 0xc2) sawSOF = true; // SOF0/SOF2
        if (marker === 0xdb) sawDQT = true; // DQT
        if (marker === 0xc4) sawDHT = true; // DHT
        if (marker === 0xda) {
            sawSOS = true;
            // After SOS, entropy-coded data continues until EOI.
            // We already require EOI at end; accept here.
            break;
        }

        off = segEnd;
    }

    return sawSOF && sawDQT && sawDHT && sawSOS;
}

function isProbablyValidPng(pngBuf) {
    if (!pngBuf || pngBuf.length < 8) return false;
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!pngBuf.subarray(0, 8).equals(sig)) return false;
    const iendTail = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const iend = pngBuf.indexOf(iendTail);
    if (iend < 0) return false;
    // Very light sanity: must have IHDR chunk type at offset 12.
    if (pngBuf.length >= 16) {
        const ihdr = pngBuf.subarray(12, 16).toString("ascii");
        if (ihdr !== "IHDR") return false;
    }
    return true;
}

function isProbablyValidAnnexB(buf) {
    if (!buf || buf.length < 128) return false;

    const starts = [];
    const maxScan = Math.min(buf.length, 256 * 1024);
    for (let i = 0; i < maxScan - 4; i++) {
        if (buf[i] === 0x00 && buf[i + 1] === 0x00) {
            if (buf[i + 2] === 0x01) {
                starts.push({ off: i, len: 3 });
                i += 2;
            } else if (buf[i + 2] === 0x00 && buf[i + 3] === 0x01) {
                starts.push({ off: i, len: 4 });
                i += 3;
            }
        }
        if (starts.length >= 200) break;
    }

    if (starts.length < 8) return false;

    // Score first N NAL headers for H.264 vs H.265 plausibility.
    let h264Ok = 0;
    let h264Sps = 0;
    let h264Pps = 0;

    let h265Ok = 0;
    let h265Vps = 0;
    let h265Sps = 0;
    let h265Pps = 0;

    const sampleN = Math.min(starts.length, 50);
    for (let i = 0; i < sampleN; i++) {
        const s = starts[i];
        const at = s.off + s.len;
        if (at >= buf.length) continue;

        const b0 = buf[at];
        // H.264: forbidden_zero_bit must be 0, nal_unit_type in 1..23 (0 reserved).
        const h264Forbidden = (b0 & 0x80) !== 0;
        const h264Type = b0 & 0x1f;
        if (!h264Forbidden && h264Type >= 1 && h264Type <= 23) {
            h264Ok++;
            if (h264Type === 7) h264Sps++;
            if (h264Type === 8) h264Pps++;
        }

        // H.265: needs 2 bytes; forbidden_zero_bit must be 0; nal_unit_type is bits 1..6 of first byte.
        if (at + 1 < buf.length) {
            const h265Forbidden = (b0 & 0x80) !== 0;
            const h265Type = (b0 >> 1) & 0x3f;
            if (!h265Forbidden && h265Type >= 0 && h265Type <= 63) {
                h265Ok++;
                if (h265Type === 32) h265Vps++;
                if (h265Type === 33) h265Sps++;
                if (h265Type === 34) h265Pps++;
            }
        }
    }

    const h264Score = h264Ok / sampleN;
    const h265Score = h265Ok / sampleN;
    const looksH264 = h264Score >= 0.7 && (h264Sps + h264Pps) >= 1;
    const looksH265 = h265Score >= 0.7 && (h265Vps + h265Sps + h265Pps) >= 1;

    return looksH264 || looksH265;
}

function isCarvedArtifactUsable(kind, carvedBuf) {
    if (!carvedBuf || carvedBuf.length < 1024) return false;
    if (kind === "jpg") return isProbablyValidJpeg(carvedBuf);
    if (kind === "png") return isProbablyValidPng(carvedBuf);
    if (kind === "annexb") return isProbablyValidAnnexB(carvedBuf);
    // For other kinds (ftyp/moov/mdat/lz4f), accept based on size for now.
    return carvedBuf.length >= 4096;
}

function isMeaningfulInflate(outBuf, { acceptLen = false } = {}) {
    if (!outBuf) return { ok: false, reason: "empty" };
    const sig = detectMediaSignature(outBuf);
    if (sig.kind) {
        const carved = carveBySignature(outBuf, sig);
        if (carved && isCarvedArtifactUsable(sig.kind, carved)) return { ok: true, reason: `sig:${sig.kind}@${sig.at}` };
    }
    // Heuristic: if no signature, require some minimum size.
    if (acceptLen && outBuf.length >= 4096) return { ok: true, reason: `len:${outBuf.length}` };
    return { ok: false, reason: `too_small:${outBuf.length}` };
}

function findDictFile(dictDir, dictId) {
    const hex = dictId.toString(16).padStart(8, "0");
    const entries = fs.readdirSync(dictDir, { withFileTypes: true });
    const hit = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .find((n) => n.toLowerCase().startsWith(`dictid-${hex}.`) && n.toLowerCase().endsWith(".bin"));
    if (!hit) return null;
    return path.join(dictDir, hit);
}

function listDictBinFiles(dictDir) {
    try {
        const entries = fs.readdirSync(dictDir, { withFileTypes: true });
        return entries
            .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".bin"))
            .map((e) => path.join(dictDir, e.name));
    } catch {
        return [];
    }
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0) usage();

    let globFiles = [];
    let nonce = "";
    let outPrefix = "";
    let skip = 0;
    let headerLen = 32;
    let encryptLen = 1024;
    let chunkSize = 1024;
    let mode = "aes-128-ctr";
    let modes = null;
    let strategy = "perChunkFirstN";
    // For perBlockReset, the scanner uses block=encryptLen.
    // Here default 0 means "use encryptLen".
    let block = 0;
    let keySpec = "hkdf(sessionKey_salt_header0_info_header1)";
    let ivSpec = "md5(header0_header1)";
    let auto = false;
    let maxParamCombos = 0;
    let dictId = null;
    let dictDir = "pcap/reports/apk/dicts";
    let dictSweep = false;
    let dictSweepAlways = false;
    let forceZlibAt = null;
    let maxZlibHits = 32;
    let attemptsMax = 20000;
    let zlibMaxOutput = 64 * 1024 * 1024;
    let doInflate = true;
    let inflateAcceptLen = false;

    /** @type {number[]|null} */
    let encryptLens = null;
    /** @type {number[]|null} */
    let chunkSizes = null;
    /** @type {string[]|null} */
    let strategies = null;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--glob") {
            // NOTE: shell should expand globs; we accept a single string too.
            const g = String(argv[++i] ?? "");
            if (!g) throw new Error("Missing --glob value");
            globFiles.push(g);
        } else if (a === "--nonce") nonce = String(argv[++i] ?? "");
        else if (a === "--out") outPrefix = String(argv[++i] ?? "");
        else if (a === "--skip") skip = Number(argv[++i] ?? "0") || 0;
        else if (a === "--header-len") headerLen = Number(argv[++i] ?? "0") || headerLen;
        else if (a === "--encrypt-len") encryptLen = Number(argv[++i] ?? "0") || encryptLen;
        else if (a === "--encrypt-lens") {
            encryptLens = String(argv[++i] ?? "")
                .split(",")
                .map((x) => Number.parseInt(x.trim(), 10))
                .filter((n) => Number.isFinite(n) && n > 0);
        }
        else if (a === "--chunk-size") chunkSize = Number(argv[++i] ?? "0") || chunkSize;
        else if (a === "--chunk-sizes") {
            chunkSizes = String(argv[++i] ?? "")
                .split(",")
                .map((x) => Number.parseInt(x.trim(), 10))
                .filter((n) => Number.isFinite(n) && n > 0);
        }
        else if (a === "--mode") mode = String(argv[++i] ?? mode);
        else if (a === "--modes") {
            modes = String(argv[++i] ?? "")
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean);
        }
        else if (a === "--strategy") strategy = String(argv[++i] ?? strategy);
        else if (a === "--strategies") {
            strategies = String(argv[++i] ?? "")
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean);
        }
        else if (a === "--block") block = Number(argv[++i] ?? "0") || 0;
        else if (a === "--key") keySpec = String(argv[++i] ?? keySpec);
        else if (a === "--iv") ivSpec = String(argv[++i] ?? ivSpec);
        else if (a === "--auto") auto = true;
        else if (a === "--max-param-combos") maxParamCombos = Number(argv[++i] ?? "0") || 0;
        else if (a === "--dictid") dictId = parseHex32(argv[++i]);
        else if (a === "--dict-dir") dictDir = String(argv[++i] ?? dictDir);
        else if (a === "--dict-sweep") dictSweep = true;
        else if (a === "--dict-sweep-always") dictSweepAlways = true;
        else if (a === "--zlib-at") forceZlibAt = Number(argv[++i] ?? "0");
        else if (a === "--max-zlib-hits") maxZlibHits = Number(argv[++i] ?? "0") || maxZlibHits;
        else if (a === "--zlib-max-output") zlibMaxOutput = Number(argv[++i] ?? "0") || zlibMaxOutput;
        else if (a === "--no-inflate") doInflate = false;
        else if (a === "--inflate-accept-len") inflateAcceptLen = true;
        else if (a === "--attempts-max") attemptsMax = Number(argv[++i] ?? "0") || attemptsMax;
        else if (a.startsWith("-")) usage();
        else globFiles.push(a);
    }

    if (!nonce) throw new Error("Missing --nonce");
    if (!outPrefix) throw new Error("Missing --out");
    if (globFiles.length === 0) throw new Error("Missing --glob / input files");

    const password = readEnvPassword();
    if (!password) throw new Error("Missing password env (BAICHUAN_PASSWORD/TCP_PASSWORD/NVR_PASSWORD)");

    // Expand globs if the shell didn't.
    const inputFiles = [];
    for (const item of globFiles) {
        if (item.includes("*") || item.includes("?") || item.includes("[") || item.includes("]")) {
            // Not expanded; bail with a helpful message.
            throw new Error(`Glob not expanded by shell: ${item} (quote removal?)`);
        }
        inputFiles.push(item);
    }

    // IMPORTANT: shell glob expansion is lexicographic, so i10 comes before i2.
    // For Baichuan chunk streams, that corrupts concatenation. Sort numerically by `.i<N>.`.
    const extractChunkIndex = (p) => {
        const m = /\bi(\d+)\b/.exec(path.basename(p));
        return m ? Number.parseInt(m[1], 10) : Number.NaN;
    };
    inputFiles.sort((a, b) => {
        const ia = extractChunkIndex(a);
        const ib = extractChunkIndex(b);
        const aOk = Number.isFinite(ia);
        const bOk = Number.isFinite(ib);
        if (aOk && bOk && ia !== ib) return ia - ib;
        if (aOk && !bOk) return -1;
        if (!aOk && bOk) return 1;
        return a.localeCompare(b);
    });

    const sessionKey = deriveAesKey(nonce, password);
    const sessionKeyMd5Bytes = md5_16(Buffer.from(`${nonce}-${password}`, "utf8"));
    const sessionKeyMd5BytesNoDash = md5_16(Buffer.from(`${nonce}${password}`, "utf8"));

    const inputs = [];
    const perFile = [];

    for (const file of inputFiles) {
        const raw = fs.readFileSync(file);
        const buf = skip > 0 ? raw.subarray(Math.min(skip, raw.length)) : raw;
        if (buf.length < headerLen + 1) continue;

        const header = buf.subarray(0, headerLen);
        const ct = buf.subarray(headerLen);
        const h0 = header.subarray(0, 16);
        const h1 = header.subarray(16, 32);

        inputs.push({ header, ct, h0, h1 });

        perFile.push({ file, rawLen: raw.length, usedLen: buf.length, headerHex: header.subarray(0, 32).toString("hex") });
    }

    const tryEncryptLens = encryptLens && encryptLens.length ? encryptLens : [encryptLen];
    const tryChunkSizes = chunkSizes && chunkSizes.length ? chunkSizes : [chunkSize];
    const tryStrategies = strategies && strategies.length ? strategies : [strategy];
    const tryModes = modes && modes.length ? modes : [mode];

    fs.mkdirSync(path.dirname(outPrefix), { recursive: true });

    /** @type {any[]} */
    const attempts = [];
    let best = null;

    function buildKeyIvs() {
        // Build keys/ivs similarly to scan-wrapper-decode (but not exhaustive).
        // Use per-input header0/header1 at evaluation time.
        const keys = [
            ["sessionKey", (_h0, _h1) => sessionKey],
            ["md5(sessionKey)", (_h0, _h1) => md5_16(sessionKey)],
            ["md5bytes(nonce-password)", (_h0, _h1) => sessionKeyMd5Bytes],
            ["md5bytes(nonce+password)", (_h0, _h1) => sessionKeyMd5BytesNoDash],
            ["md5(header0)", (_h0, _h1) => md5_16(_h0)],
            ["md5(header1)", (_h0, _h1) => md5_16(_h1)],
            ["md5(header0+header1)", (_h0, _h1) => md5_16(Buffer.concat([_h0, _h1]))],
            ["md5(header1+header0)", (_h0, _h1) => md5_16(Buffer.concat([_h1, _h0]))],
            ["sha256(header0+header1)", (_h0, _h1) => sha256_16(Buffer.concat([_h0, _h1]))],
            ["sha256(header1+header0)", (_h0, _h1) => sha256_16(Buffer.concat([_h1, _h0]))],
            ["md5(sessionKey+header0)", (_h0, _h1) => md5_16(Buffer.concat([sessionKey, _h0]))],
            ["md5(sessionKey+header1)", (_h0, _h1) => md5_16(Buffer.concat([sessionKey, _h1]))],
            ["md5(header0+sessionKey)", (_h0, _h1) => md5_16(Buffer.concat([_h0, sessionKey]))],
            ["md5(header1+sessionKey)", (_h0, _h1) => md5_16(Buffer.concat([_h1, sessionKey]))],
            ["md5bytes(nonce-password)+header0", (_h0, _h1) => md5_16(Buffer.concat([sessionKeyMd5Bytes, _h0]))],
            ["md5bytes(nonce-password)+header1", (_h0, _h1) => md5_16(Buffer.concat([sessionKeyMd5Bytes, _h1]))],
            ["xor(sessionKey,header0)", (_h0, _h1) => xor16(sessionKey, _h0)],
            ["xor(sessionKey,header1)", (_h0, _h1) => xor16(sessionKey, _h1)],
            ["hkdf(sessionKey,salt=header0)", (_h0, _h1) => hkdfSha256_16(sessionKey, _h0, Buffer.alloc(0))],
            ["hkdf(sessionKey,salt=header1)", (_h0, _h1) => hkdfSha256_16(sessionKey, _h1, Buffer.alloc(0))],
            ["hkdf(sessionKey,salt=header0,info=header1)", (_h0, _h1) => hkdfSha256_16(sessionKey, _h0, _h1)],
            ["hkdf(sessionKey,salt=header1,info=header0)", (_h0, _h1) => hkdfSha256_16(sessionKey, _h1, _h0)],
            ["hkdf(md5bytes(nonce-password),salt=header0,info=header1)", (_h0, _h1) => hkdfSha256_16(sessionKeyMd5Bytes, _h0, _h1)],
            ["hkdf(md5bytes(nonce-password),salt=header1,info=header0)", (_h0, _h1) => hkdfSha256_16(sessionKeyMd5Bytes, _h1, _h0)],
        ];

        const ivs = [
            ["fixedIv", (_h0, _h1) => Buffer.alloc(16, 0)],
            ["bcIv", (_h0, _h1) => BC_AES_IV],
            ["sessionKey", (_h0, _h1) => sessionKey],
            ["header0", (_h0, _h1) => _h0],
            ["header1", (_h0, _h1) => _h1],
            ["xor(sessionKey,header0)", (_h0, _h1) => xor16(sessionKey, _h0)],
            ["xor(sessionKey,header1)", (_h0, _h1) => xor16(sessionKey, _h1)],
            ["md5(header0)", (_h0, _h1) => md5_16(_h0)],
            ["md5(header1)", (_h0, _h1) => md5_16(_h1)],
            ["xor(header0,header1)", (_h0, _h1) => xor16(_h0, _h1)],
            ["md5(header0+header1)", (_h0, _h1) => md5_16(Buffer.concat([_h0, _h1]))],
            ["md5(header1+header0)", (_h0, _h1) => md5_16(Buffer.concat([_h1, _h0]))],
            ["md5(sessionKey)", (_h0, _h1) => md5_16(sessionKey)],
            ["md5(sessionKey+header0)", (_h0, _h1) => md5_16(Buffer.concat([sessionKey, _h0]))],
            ["md5(sessionKey+header1)", (_h0, _h1) => md5_16(Buffer.concat([sessionKey, _h1]))],
            ["md5(header0+sessionKey)", (_h0, _h1) => md5_16(Buffer.concat([_h0, sessionKey]))],
            ["md5(header1+sessionKey)", (_h0, _h1) => md5_16(Buffer.concat([_h1, sessionKey]))],
        ];

        return { keys, ivs };
    }

    const autoSets = auto ? buildKeyIvs() : null;
    const chosenKeys = auto ? autoSets.keys.map(([n, f]) => ({ name: n, fn: f })) : [{ name: keySpec, fn: null }];
    const chosenIvs = auto ? autoSets.ivs.map(([n, f]) => ({ name: n, fn: f })) : [{ name: ivSpec, fn: null }];

    let paramComboCount = 0;

    for (const curMode of tryModes) {
        for (const keyEntry of chosenKeys) {
            for (const ivEntry of chosenIvs) {
                paramComboCount++;
                if (maxParamCombos > 0 && paramComboCount > maxParamCombos) break;

                for (const curStrategy of tryStrategies) {
                    for (const curEncryptLen of tryEncryptLens) {
                        const relevantChunkSizes = curStrategy.startsWith("perChunk") ? tryChunkSizes : [chunkSize];
                        for (const curChunkSize of relevantChunkSizes) {
                            const isConcatStrategy = curStrategy.startsWith("concat");
                            let concatLen = 0;
                            if (isConcatStrategy) {
                                let totalCtLen = 0;
                                for (const it of inputs) totalCtLen += it.ct.length;
                                concatLen = estimatePlainLen({
                                    mode: curMode,
                                    strategy: curStrategy,
                                    ctLen: totalCtLen,
                                    encryptLen: curEncryptLen,
                                    chunkSize: curChunkSize,
                                    block,
                                });
                            } else {
                                for (const it of inputs) {
                                    concatLen += estimatePlainLen({
                                        mode: curMode,
                                        strategy: curStrategy,
                                        ctLen: it.ct.length,
                                        encryptLen: curEncryptLen,
                                        chunkSize: curChunkSize,
                                        block,
                                    });
                                }
                            }

                            let concat = Buffer.allocUnsafe(concatLen);
                            let writeOff = 0;

                            const computeKey = (h0, h1) => {
                                if (auto) return keyEntry.fn(h0, h1);
                                switch (keySpec) {
                                    case "sessionKey":
                                        return sessionKey;
                                    case "xor(sessionKey_header0)":
                                        return xor16(sessionKey, h0);
                                    case "xor(sessionKey_header1)":
                                        return xor16(sessionKey, h1);
                                    case "hkdf(sessionKey_salt_header0_info_header1)":
                                        return hkdfSha256_16(sessionKey, h0, h1);
                                    case "md5(header0)":
                                        return md5_16(h0);
                                    case "md5(header1)":
                                        return md5_16(h1);
                                    case "md5(header0_header1)":
                                        return md5_16(Buffer.concat([h0, h1]));
                                    case "md5(header1_header0)":
                                        return md5_16(Buffer.concat([h1, h0]));
                                    case "sha256(header0_header1)":
                                        return sha256_16(Buffer.concat([h0, h1]));
                                    case "sha256(header1_header0)":
                                        return sha256_16(Buffer.concat([h1, h0]));
                                    case "md5(header0_sessionKey)":
                                        return md5_16(Buffer.concat([h0, sessionKey]));
                                    case "md5(header1_sessionKey)":
                                        return md5_16(Buffer.concat([h1, sessionKey]));
                                    case "md5(sessionKey_header0)":
                                        return md5_16(Buffer.concat([sessionKey, h0]));
                                    case "md5(sessionKey_header1)":
                                        return md5_16(Buffer.concat([sessionKey, h1]));
                                    default:
                                        throw new Error(`Unsupported --key: ${keySpec}`);
                                }
                            };

                            const computeIv = (h0, h1) => {
                                if (auto) return ivEntry.fn(h0, h1);
                                switch (ivSpec) {
                                    case "fixedIv":
                                        return Buffer.alloc(16, 0);
                                    case "bcIv":
                                        return BC_AES_IV;
                                    case "sessionKey":
                                        return sessionKey;
                                    case "header0":
                                        return h0;
                                    case "header1":
                                        return h1;
                                    case "xor(header0_header1)":
                                        return xor16(h0, h1);
                                    case "md5(header0_header1)":
                                        return md5_16(Buffer.concat([h0, h1]));
                                    case "md5(header1_header0)":
                                        return md5_16(Buffer.concat([h1, h0]));
                                    case "md5(header0)":
                                        return md5_16(h0);
                                    case "md5(header1)":
                                        return md5_16(h1);
                                    case "md5(sessionKey)":
                                        return md5_16(sessionKey);
                                    case "md5(sessionKey_header0)":
                                        return md5_16(Buffer.concat([sessionKey, h0]));
                                    case "md5(sessionKey_header1)":
                                        return md5_16(Buffer.concat([sessionKey, h1]));
                                    case "md5(header0_sessionKey)":
                                        return md5_16(Buffer.concat([h0, sessionKey]));
                                    case "md5(header1_sessionKey)":
                                        return md5_16(Buffer.concat([h1, sessionKey]));
                                    default:
                                        throw new Error(`Unsupported --iv: ${ivSpec}`);
                                }
                            };

                            if (isConcatStrategy) {
                                const first = inputs[0];
                                const key = computeKey(first.h0, first.h1);
                                const iv = computeIv(first.h0, first.h1);
                                const ctAll = concatAllCiphertexts(inputs);
                                const pt = (() => {
                                    switch (curStrategy) {
                                        case "concatFirstN":
                                            return decryptFirstN({ mode: curMode, key, iv, ct: ctAll, n: curEncryptLen });
                                        case "concatAll":
                                            return decryptAll({ mode: curMode, key, iv, ct: ctAll });
                                        case "concatDropIvFirstN":
                                            return decryptDropIvFirstN({ mode: curMode, key, ct: ctAll, n: curEncryptLen });
                                        case "concatDropIvAll":
                                            return decryptDropIvAll({ mode: curMode, key, ct: ctAll });
                                        default:
                                            throw new Error(`Unsupported --strategy: ${curStrategy}`);
                                    }
                                })();
                                pt.copy(concat, 0);
                                writeOff = pt.length;
                            } else {
                                for (const it of inputs) {
                                    const { ct, h0, h1 } = it;
                                    const key = computeKey(h0, h1);
                                    const iv = computeIv(h0, h1);

                                    const pt = (() => {
                                        switch (curStrategy) {
                                            case "firstN":
                                                return decryptFirstN({ mode: curMode, key, iv, ct, n: curEncryptLen });
                                            case "all":
                                                return decryptAll({ mode: curMode, key, iv, ct });
                                            case "perBlockReset":
                                                return decryptPerBlockReset({ mode: curMode, key, iv, ct, block: block > 0 ? block : curEncryptLen });
                                            case "dropIvFirstN":
                                                return decryptDropIvFirstN({ mode: curMode, key, ct, n: curEncryptLen });
                                            case "dropIvAll":
                                                return decryptDropIvAll({ mode: curMode, key, ct });
                                            case "perChunkFirstN":
                                                return decryptPerChunkFirstN({ mode: curMode, key, iv, ct, chunkSize: curChunkSize, encryptLen: curEncryptLen });
                                            case "perChunkAll":
                                                return decryptPerChunkAll({ mode: curMode, key, iv, ct, chunkSize: curChunkSize });
                                            case "perChunkDropIvFirstN":
                                                return decryptPerChunkDropIvFirstN({ mode: curMode, key, ct, chunkSize: curChunkSize, encryptLen: curEncryptLen });
                                            case "perChunkDropIvAll":
                                                return decryptPerChunkDropIvAll({ mode: curMode, key, ct, chunkSize: curChunkSize });
                                            default:
                                                throw new Error(`Unsupported --strategy: ${curStrategy}`);
                                        }
                                    })();

                                    pt.copy(concat, writeOff);
                                    writeOff += pt.length;
                                }
                            }

                            if (writeOff !== concat.length) {
                                // If our estimator was off (CBC trimming edge cases), adjust safely.
                                concat = concat.subarray(0, writeOff);
                            }
                            const singleAttempt =
                                !auto &&
                                (!modes || modes.length <= 1) &&
                                (!strategies || strategies.length <= 1) &&
                                (!encryptLens || encryptLens.length <= 1) &&
                                (!chunkSizes || chunkSizes.length <= 1);
                            if (singleAttempt) {
                                fs.writeFileSync(`${outPrefix}.concat.pt.bin`, concat);
                            }
                            const ptSig = detectMediaSignature(concat);
                            const z = forceZlibAt != null ? { at: forceZlibAt, dictId: dictId } : findFirstZlib(concat);
                            const zlibCandidates = forceZlibAt != null ? (z ? [z] : []) : findZlibHeaders(concat, { maxHits: maxZlibHits });

                            const attempt = {
                                mode: curMode,
                                key: auto ? keyEntry.name : keySpec,
                                iv: auto ? ivEntry.name : ivSpec,
                                strategy: curStrategy,
                                encryptLen: curEncryptLen,
                                chunkSize: curChunkSize,
                                concatLen: concat.length,
                                ptSig,
                                zlibFirst: z,
                                inflate: { ok: false, outPath: null, attempts: [] },
                            };

                            // If plaintext contains a recognizable signature, only accept it if we can carve a complete artifact.
                            if (ptSig && ptSig.kind) {
                                const carved = carveBySignature(concat, ptSig);
                                if (carved && isCarvedArtifactUsable(ptSig.kind, carved)) {
                                    const outPath = `${outPrefix}.ptSig.${ptSig.kind}.at${ptSig.at}.bin`;
                                    fs.writeFileSync(outPath, concat);
                                    const carvedPath = `${outPrefix}.ptSig.${ptSig.kind}.at${ptSig.at}.carved${extensionForSigKind(ptSig.kind)}`;
                                    fs.writeFileSync(carvedPath, carved);

                                    best = {
                                        ...attempt,
                                        nonce,
                                        skip,
                                        headerLen,
                                        block,
                                        dictDir,
                                        maxZlibHits,
                                        inputs: perFile,
                                        ptOutPath: outPath,
                                        ptCarvedPath: carvedPath,
                                        ptCarvedLen: carved.length,
                                    };
                                    // Also save a stable alias.
                                    fs.writeFileSync(`${outPrefix}.best.concat.pt.bin`, concat);
                                    if (attempts.length < attemptsMax) attempts.push(attempt);
                                    break;
                                }
                            }

                            if (!doInflate || !z) {
                                if (attempts.length < attemptsMax) attempts.push(attempt);
                                continue;
                            }

                            // Inflate attempts for this decrypted concat.
                            let inflatedOutPath = null;
                            let inflatedCarvedPath = null;
                            let inflatedCarvedKind = null;
                            let inflatedCarvedAt = null;
                            let inflatedCarvedLen = null;
                            const inflateAttempts = [];

                            const allDictBins = (dictSweep || dictSweepAlways) ? listDictBinFiles(dictDir) : [];
                            for (const cand of zlibCandidates) {
                                const start = concat.subarray(cand.at);
                                let ok = false;
                                let err = null;
                                let usedDictFile = null;
                                let kind = null;
                                try {
                                    const baseOpts = { maxOutputLength: zlibMaxOutput };
                                    const needDictId = dictId ?? cand.dictId;

                                    /** @type {Array<string|null>} */
                                    const dictFilesToTry = [];
                                    if (needDictId != null) {
                                        const hit = findDictFile(dictDir, needDictId);
                                        if (hit) dictFilesToTry.push(hit);
                                        else if (dictSweep) dictFilesToTry.push(...allDictBins);
                                    } else if (dictSweepAlways) {
                                        dictFilesToTry.push(...allDictBins);
                                    }

                                    const tryInflateWithOpts = (opts) => {
                                        try {
                                            const inflated = zlib.inflateSync(start, opts);
                                            const m = isMeaningfulInflate(inflated, { acceptLen: inflateAcceptLen });
                                            if (!m.ok) throw new Error(`inflate_not_meaningful:${m.reason}`);
                                            return { ok: true, inflated, kind: `zlib:${m.reason}`, zlibErr: null };
                                        } catch (e1) {
                                            const msg1 = String(e1?.message ?? e1);
                                            const rawStart = start.subarray(2);
                                            const inflated = zlib.inflateRawSync(rawStart, opts);
                                            const m = isMeaningfulInflate(inflated, { acceptLen: inflateAcceptLen });
                                            if (!m.ok) throw new Error(`inflateRaw_not_meaningful:${m.reason} (zlibErr=${msg1})`);
                                            return { ok: true, inflated, kind: `raw:${m.reason}`, zlibErr: msg1 };
                                        }
                                    };

                                    /** @type {Array<{ dictFile: string|null, opts: any }>} */
                                    const optionAttempts = [];

                                    // Try without dict if no dict is required OR if user asked to sweep always.
                                    if (needDictId == null || dictSweepAlways) {
                                        optionAttempts.push({ dictFile: null, opts: baseOpts });
                                    }

                                    // Try targeted dict (or sweep dicts) when a dict is required.
                                    if (needDictId != null) {
                                        for (const dictFile of dictFilesToTry) {
                                            if (!dictFile) continue;
                                            const dict = fs.readFileSync(dictFile);
                                            optionAttempts.push({ dictFile, opts: { ...baseOpts, dictionary: dict } });
                                        }
                                    } else if (dictSweepAlways) {
                                        // Even if no dict is required, allow trying all dicts as a fallback.
                                        for (const dictFile of dictFilesToTry) {
                                            if (!dictFile) continue;
                                            const dict = fs.readFileSync(dictFile);
                                            optionAttempts.push({ dictFile, opts: { ...baseOpts, dictionary: dict } });
                                        }
                                    }

                                    let lastErr = null;
                                    for (const opt of optionAttempts) {
                                        try {
                                            const r = tryInflateWithOpts(opt.opts);
                                            inflatedOutPath = `${outPrefix}.inflate.${r.kind.startsWith("raw") ? "raw" : "zlib"}.at${cand.at}.bin`;
                                            fs.writeFileSync(inflatedOutPath, r.inflated);
                                            ok = true;
                                            kind = r.kind;
                                            err = r.zlibErr;
                                            usedDictFile = opt.dictFile;
                                            break;
                                        } catch (eOpt) {
                                            lastErr = eOpt;
                                        }
                                    }

                                    if (!ok && lastErr) throw lastErr;

                                    if (ok && inflatedOutPath) {
                                        const inflated = fs.readFileSync(inflatedOutPath);
                                        const sig = detectMediaSignature(inflated);
                                        if (sig.kind) {
                                            const carved = carveBySignature(inflated, sig);
                                            if (carved && isCarvedArtifactUsable(sig.kind, carved)) {
                                                inflatedCarvedKind = sig.kind;
                                                inflatedCarvedAt = sig.at;
                                                inflatedCarvedLen = carved.length;
                                                inflatedCarvedPath = `${outPrefix}.inflate.carved.${sig.kind}.at${sig.at}${extensionForSigKind(sig.kind)}`;
                                                fs.writeFileSync(inflatedCarvedPath, carved);
                                            }
                                        }
                                    }
                                } catch (e) {
                                    err = String(e?.message ?? e);
                                }

                                inflateAttempts.push({ at: cand.at, dictId: cand.dictId, ok, kind, error: err, dictFile: usedDictFile });
                                if (ok) break;
                            }

                            attempt.inflate = {
                                ok: !!inflatedOutPath,
                                outPath: inflatedOutPath,
                                carvedPath: inflatedCarvedPath,
                                carvedKind: inflatedCarvedKind,
                                carvedAt: inflatedCarvedAt,
                                carvedLen: inflatedCarvedLen,
                                attempts: inflateAttempts,
                            };
                            if (attempts.length < attemptsMax) attempts.push(attempt);

                            const inflateAcceptable = attempt.inflate.ok && (inflateAcceptLen || !!attempt.inflate.carvedPath);
                            if (inflateAcceptable) {
                                best = { ...attempt, nonce, skip, headerLen, block, dictDir, maxZlibHits, inputs: perFile };
                                // Save the decrypted concat for the successful attempt.
                                fs.writeFileSync(`${outPrefix}.best.concat.pt.bin`, concat);
                                break;
                            }
                        }
                        if (best) break;
                    }
                    if (best) break;
                }
                if (best) break;
            }
            if (maxParamCombos > 0 && paramComboCount > maxParamCombos) break;
            if (best) break;
        }
        if (best) break;
    }

    const report = {
        inputs: perFile,
        outPrefix,
        nonce,
        skip,
        headerLen,
        block,
        mode,
        keySpec,
        ivSpec,
        auto,
        modes: tryModes,
        maxParamCombos,
        dictDir,
        dictSweep,
        dictSweepAlways,
        maxZlibHits,
        inflateAcceptLen,
        attemptsMax,
        matrix: {
            strategies: tryStrategies,
            encryptLens: tryEncryptLens,
            chunkSizes: tryChunkSizes,
        },
        best,
        attempts,
    };

    fs.writeFileSync(`${outPrefix}.report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: !!best, report: `${outPrefix}.report.json` }, null, 2));
}

main();
