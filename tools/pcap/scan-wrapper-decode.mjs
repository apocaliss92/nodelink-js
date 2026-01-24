#!/usr/bin/env node
/**
 * Scan/decode Baichuan binary wrappers seen in cmd298/cmd143.
 *
 * Observations:
 * - Many blobs start with "\n-" (0x0a 0x2d). We normalize by stripping the leading newline only.
 * - A binary header commonly starts with 0x2d f3 a1 7b c9 2f 11 ... (length ~32 bytes in cmd298).
 * - cmd298 embeds an inner <Extension> XML after the header; it may contain <EncryptLen>1024</EncryptLen>.
 * - cmd143 appears to share the header fingerprint, but usually does NOT include nested XML.
 *
 * This tool tries common partial-encryption semantics:
 * - decrypt first N bytes
 * - decrypt per-block reset
 * - decrypt first N bytes of each chunk
 *
 * It brute-forces {mode,key,iv,strategy} combinations and scores candidates by signature heuristics.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

import "dotenv/config";
import { deriveAesKey } from "../../dist/index.cjs";

function usage() {
    console.error(`Usage:
  node tools/pcap/scan-wrapper-decode.mjs <file> --nonce <nonce> [options]

Options:
  --nonce <nonce>            Nonce from cmdId=1 negotiation
  --encrypt-len <n>          Default EncryptLen when no inner XML exists (default 1024)
  --header-len <n>           Wrapper header length (default 32)
  --strip-newline-dash       If input starts with 0x0a 0x2d, strip the leading 0x0a (default: true)
  --no-strip-newline-dash    Disable normalization
  --chunk-sizes <csv>        e.g. 1024,2048,4096,8192 (default: 1024,2048,4096,8192,16384)
  --modes <csv>              e.g. aes-128-cfb,aes-128-ctr,aes-128-cbc (default: cfb,ctr,cbc)
  --out <prefix>             Output prefix for generated files
  --write-best <n>           Write top N candidates into pcap/reports/dec/
    --top <n>                  Number of top candidates saved into the JSON report (default: 30)
    --dict-dir <dir>           Directory containing zlib preset dictionaries (default: pcap/reports/apk/dicts)

XOR v1 (BaichuanEncryptor version==1):
    --no-xorv1                 Disable XOR v1 candidates
    --xorv1-w3 <csv>            Values to try for the 3rd decrypt param (default: 0,1,2,3,4,5,6,7)
    --xorv1-all                 Try all w3 values 0..255 (can be slow on large blobs)
`);
    process.exit(2);
}

function readEnvPassword() {
    return (
        process.env.BAICHUAN_PASSWORD ??
        // nonce is only required when AES candidates are enabled (i.e. password present);
        // XOR-v1 can be scanned without it.
        process.env.NVR_PASSWORD ??
        ""
    ).trim();
}

function hexHead(buf, n = 64) {
    return buf.subarray(0, Math.min(n, buf.length)).toString("hex");
}

function findCloseExtension(buf, from = 0) {
    const closeTag = Buffer.from("</Extension>", "utf8");
    const closeAt = buf.indexOf(closeTag, from);
    if (closeAt < 0) return null;
    let splitAt = buf.indexOf(0x0a, closeAt + closeTag.length);
    if (splitAt < 0) splitAt = closeAt + closeTag.length;
    else splitAt += 1;
    return { closeAt, splitAt };
}

function trySplitLeadingExtension(buf) {
    // Accept both "<?xml ... <Extension ...>" and "<Extension ...>" at start.
    const startsLikeXml = buf.subarray(0, 5).toString("utf8") === "<?xml";
    const startsLikeExt = buf.subarray(0, 10).toString("utf8").startsWith("<Extension");
    if (!startsLikeXml && !startsLikeExt) return null;

    const split = findCloseExtension(buf, 0);
    if (!split) return null;
    const xml = buf.subarray(0, split.splitAt).toString("utf8");
    const payload = buf.subarray(split.splitAt);
    return { splitAt: split.splitAt, xml, payload };
}

function extractTagText(xml, tag) {
    const re = new RegExp(`<${tag}>([^<]+)</${tag}>`, "i");
    const m = re.exec(xml);
    return m?.[1]?.trim() ?? null;
}

function isRfc1950ZlibHeader(cmf, flg) {
    // RFC1950: CM must be 8 (deflate); (CMF<<8|FLG)%31 == 0
    if ((cmf & 0x0f) !== 8) return false;
    const cmfFlg = ((cmf << 8) | flg) & 0xffff;
    if (cmfFlg % 31 !== 0) return false;
    // CINFO = 0..7 (window <= 32K)
    const cinfo = (cmf >> 4) & 0x0f;
    if (cinfo > 7) return false;
    return true;
}

function detectSignatures(buf) {
    const jpgAt = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    const pngAt = buf.indexOf(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const ftypAt = buf.indexOf(Buffer.from("ftyp", "ascii"));
    const moovAt = buf.indexOf(Buffer.from("moov", "ascii"));
    const moofAt = buf.indexOf(Buffer.from("moof", "ascii"));
    const mdatAt = buf.indexOf(Buffer.from("mdat", "ascii"));
    const annexBAt = buf.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));

    // LZ4 frame magic: 0x184D2204 (little-endian in bytes)
    const lz4fAt = buf.indexOf(Buffer.from([0x04, 0x22, 0x4d, 0x18]));
    // skippable frames: 0x184D2A50..0x184D2A5F (LE bytes 50 2A 4D 18 .. 5F 2A 4D 18)
    let lz4SkippableAt = -1;
    for (let b0 = 0x50; b0 <= 0x5f; b0++) {
        const at = buf.indexOf(Buffer.from([b0, 0x2a, 0x4d, 0x18]));
        if (at >= 0 && (lz4SkippableAt < 0 || at < lz4SkippableAt)) lz4SkippableAt = at;
    }

    // strict RFC1950 zlib header scan (first 256KB)
    const zMax = Math.min(buf.length - 6, 256 * 1024);
    let zlibAt = -1;
    let zlibDictId = null;
    for (let i = 0; i < zMax; i++) {
        const cmf = buf[i];
        const flg = buf[i + 1];
        if (!isRfc1950ZlibHeader(cmf, flg)) continue;

        zlibAt = i;
        const fdict = (flg & 0x20) !== 0;
        if (fdict) {
            zlibDictId = buf.readUInt32BE(i + 2);
        }
        break;
    }

    return {
        jpgAt,
        pngAt,
        ftypAt,
        moovAt,
        moofAt,
        mdatAt,
        annexBAt,
        lz4fAt,
        lz4SkippableAt,
        zlibAt,
        zlibDictId,
    };
}

function scoreCandidate(buf) {
    const sig = detectSignatures(buf);
    let s = 0;

    const bonusNear = (off, weight, max = 4096) => {
        if (off >= 0 && off < max) s += weight;
    };

    bonusNear(sig.jpgAt, 600);
    bonusNear(sig.pngAt, 600);
    bonusNear(sig.ftypAt, 350);
    bonusNear(sig.moovAt, 250);
    bonusNear(sig.moofAt, 150);
    bonusNear(sig.mdatAt, 150);
    bonusNear(sig.annexBAt, 200);
    bonusNear(sig.lz4fAt, 220);
    bonusNear(sig.lz4SkippableAt, 120);
    bonusNear(sig.zlibAt, 120);

    // ASCII density in first 8KB (some formats include atoms/paths/text)
    const n = Math.min(buf.length, 8192);
    let ascii = 0;
    for (let i = 0; i < n; i++) {
        const c = buf[i];
        if (c >= 0x20 && c <= 0x7e) ascii++;
    }
    s += ascii / 160;

    // High-entropy penalty for the first 2KB (still looks encrypted)
    const m = Math.min(buf.length, 2048);
    if (m >= 256) {
        const freq = new Array(256).fill(0);
        for (let i = 0; i < m; i++) freq[buf[i]]++;
        let ent = 0;
        for (let i = 0; i < 256; i++) {
            const p = freq[i] / m;
            if (p > 0) ent -= p * Math.log2(p);
        }
        // entropy close to 8 means random
        if (ent > 7.6) s -= 20;
        else if (ent < 6.5) s += 10;
    }

    return { score: s, sig };
}

function aesDec(mode, key, iv, buf) {
    const isEcb = mode.endsWith("ecb");
    const isCbc = mode.endsWith("cbc");
    const len = isCbc ? buf.length - (buf.length % 16) : buf.length;

    const d = crypto.createDecipheriv(mode, key, isEcb ? null : iv);
    d.setAutoPadding(false);
    const pt = Buffer.concat([d.update(buf.subarray(0, len)), d.final()]);
    return isCbc && len < buf.length ? Buffer.concat([pt, buf.subarray(len)]) : pt;
}

function md5_16(buf) {
    return crypto.createHash("md5").update(buf).digest().subarray(0, 16);
}

function sha256_16(buf) {
    return crypto.createHash("sha256").update(buf).digest().subarray(0, 16);
}

function hkdfSha256_16(ikm, salt, info) {
    // Node 18+ supports hkdfSync.
    return crypto.hkdfSync("sha256", ikm, salt ?? Buffer.alloc(0), info ?? Buffer.alloc(0), 16);
}

function md5_16_str(str) {
    return crypto.createHash("md5").update(str, "utf8").digest().subarray(0, 16);
}

function xor16(a, b) {
    const out = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) out[i] = (a[i] ^ b[i]) & 0xff;
    return out;
}

function decryptFirstN({ mode, key, iv, ct, n }) {
    const head = aesDec(mode, key, iv, ct.subarray(0, Math.min(n, ct.length)));
    return Buffer.concat([head, ct.subarray(Math.min(n, ct.length))]);
}

function decryptPerBlockReset({ mode, key, iv, ct, block }) {
    const out = [];
    for (let off = 0; off < ct.length; off += block) {
        const chunk = ct.subarray(off, Math.min(ct.length, off + block));
        out.push(aesDec(mode, key, iv, chunk));
    }
    return Buffer.concat(out);
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

// BaichuanEncryptor::decrypt v1 (version==1) as observed in libBCSDKWrapper.so
// out[i] = ct[i] ^ w3 ^ key8[(w3 + i) & 7]
const XOR_V1_KEY8 = Buffer.from([0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff]);

function xorV1ApplyInPlace({ buf, w3, baseIndex = 0 }) {
    const t = w3 & 0xff;
    for (let i = 0; i < buf.length; i++) {
        buf[i] = (buf[i] ^ t ^ XOR_V1_KEY8[(t + baseIndex + i) & 7]) & 0xff;
    }
    return buf;
}

function xorV1FirstN({ ct, w3, n }) {
    const out = Buffer.from(ct);
    const len = Math.min(n, out.length);
    xorV1ApplyInPlace({ buf: out.subarray(0, len), w3, baseIndex: 0 });
    return out;
}

function xorV1PerBlockReset({ ct, w3, block }) {
    const out = Buffer.allocUnsafe(ct.length);
    for (let off = 0; off < ct.length; off += block) {
        const chunk = Buffer.from(ct.subarray(off, Math.min(ct.length, off + block)));
        xorV1ApplyInPlace({ buf: chunk, w3, baseIndex: 0 });
        chunk.copy(out, off);
    }
    return out;
}

function xorV1PerBlockBaseOffset({ ct, w3, block }) {
    const out = Buffer.allocUnsafe(ct.length);
    for (let off = 0; off < ct.length; off += block) {
        const chunk = Buffer.from(ct.subarray(off, Math.min(ct.length, off + block)));
        xorV1ApplyInPlace({ buf: chunk, w3, baseIndex: off });
        chunk.copy(out, off);
    }
    return out;
}

function xorV1PerChunkFirstN({ ct, w3, chunkSize, encryptLen }) {
    const out = Buffer.allocUnsafe(ct.length);
    for (let off = 0; off < ct.length; off += chunkSize) {
        const chunk = ct.subarray(off, Math.min(ct.length, off + chunkSize));
        const n = Math.min(encryptLen, chunk.length);
        const head = Buffer.from(chunk.subarray(0, n));
        xorV1ApplyInPlace({ buf: head, w3, baseIndex: 0 });
        head.copy(out, off);
        if (n < chunk.length) chunk.subarray(n).copy(out, off + n);
    }
    return out;
}

function xorV1PerChunkFirstNBaseOffset({ ct, w3, chunkSize, encryptLen }) {
    const out = Buffer.allocUnsafe(ct.length);
    for (let off = 0; off < ct.length; off += chunkSize) {
        const chunk = ct.subarray(off, Math.min(ct.length, off + chunkSize));
        const n = Math.min(encryptLen, chunk.length);
        const head = Buffer.from(chunk.subarray(0, n));
        xorV1ApplyInPlace({ buf: head, w3, baseIndex: off });
        head.copy(out, off);
        if (n < chunk.length) chunk.subarray(n).copy(out, off + n);
    }
    return out;
}

function xorV1All({ ct, w3 }) {
    const out = Buffer.from(ct);
    xorV1ApplyInPlace({ buf: out, w3, baseIndex: 0 });
    return out;
}

// Variant: IV is embedded at the start of the ciphertext (first 16 bytes)
// and is NOT part of the plaintext stream.
function decryptDropIvFirstN({ mode, key, ct, n }) {
    if (ct.length < 16) return ct;
    const iv = ct.subarray(0, 16);
    const enc = ct.subarray(16);
    const head = aesDec(mode, key, iv, enc.subarray(0, Math.min(n, enc.length)));
    return Buffer.concat([head, enc.subarray(Math.min(n, enc.length))]);
}

// Variant: chunked framing where each chunk begins with a 16-byte IV
// and then encrypted bytes follow.
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

function tryInflateAt(buf, off) {
    // backward compat wrapper
    return tryInflateAtWithDict(buf, off, null, null);
}

function findDictFile(dictDir, dictId) {
    if (!dictDir || !dictId) return null;
    const hex = dictId.toString(16).padStart(8, "0");
    try {
        const files = fs.readdirSync(dictDir);
        const pick = files.find((f) => f.startsWith(`dictid-${hex}.`) && f.includes(".win") && f.endsWith(".bin"));
        return pick ? path.join(dictDir, pick) : null;
    } catch {
        return null;
    }
}

function tryInflateAtWithDict(buf, off, dictId, dictDir) {
    const slice = buf.subarray(off);
    if (!dictId) {
        try {
            const out = zlib.inflateSync(slice);
            return { ok: true, out, usedDict: null };
        } catch (e) {
            return {
                ok: false,
                reason: "inflate_failed",
                code: e?.code ?? null,
                message: String(e?.message ?? e ?? ""),
                dictId: null,
            };
        }
    }

    const dictFile = findDictFile(dictDir, dictId);
    if (!dictFile) {
        // still try without dict
        try {
            const out = zlib.inflateSync(slice);
            return { ok: true, out, usedDict: null };
        } catch {
            return { ok: false, reason: "dict_not_found", dictId };
        }
    }

    const dict = fs.readFileSync(dictFile);
    try {
        const out = zlib.inflateSync(slice, { dictionary: dict });
        return { ok: true, out, usedDict: { dictId, dictFile, dictLen: dict.length } };
    } catch (e) {
        return {
            ok: false,
            reason: "inflate_failed",
            code: e?.code ?? null,
            message: String(e?.message ?? e ?? ""),
            dictId,
            dictFile,
            dictLen: dict.length,
        };
    }
}

function parseArgs(argv) {
    const file = argv[2];
    if (!file) usage();

    let nonce = null;
    let encryptLenDefault = 1024;
    let headerLen = 32;
    let stripNewlineDash = true;
    let chunkSizes = [1024, 2048, 4096, 8192, 16384];
    let modes = ["aes-128-cfb", "aes-128-ctr", "aes-128-cbc"];
    let outPrefix = null;
    let writeBest = 0;
    let dictDir = "pcap/reports/apk/dicts";
    let topN = 30;

    let xorV1Enabled = true;
    let xorV1All = false;
    const base = path.basename(file);
    const mCh = /(?:^|[^0-9])ch(\d{1,3})(?:[^0-9]|$)/i.exec(base);
    const chGuess = mCh ? Number.parseInt(mCh[1] ?? "", 10) : NaN;

    let xorV1W3 = [0, 1, 2, 3, 4, 5, 6, 7];
    if (Number.isFinite(chGuess) && chGuess >= 0 && chGuess <= 255) {
        // In many places in the codebase (bcDecrypt/bcEncrypt), the XOR offset is the channelId.
        xorV1W3 = Array.from(new Set([...xorV1W3, chGuess]));
    }

    for (let i = 3; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--nonce") nonce = String(argv[++i] ?? "");
        else if (a === "--encrypt-len") encryptLenDefault = Number(argv[++i] ?? "0") || encryptLenDefault;
        else if (a === "--header-len") {
            const v = Number(argv[++i] ?? "NaN");
            if (Number.isFinite(v) && v >= 0) headerLen = v;
        }
        else if (a === "--strip-newline-dash") stripNewlineDash = true;
        else if (a === "--no-strip-newline-dash") stripNewlineDash = false;
        else if (a === "--chunk-sizes") {
            chunkSizes = String(argv[++i] ?? "")
                .split(",")
                .map((x) => Number.parseInt(x.trim(), 10))
                .filter((n) => Number.isFinite(n) && n > 0);
        } else if (a === "--modes") {
            modes = String(argv[++i] ?? "")
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean);
        } else if (a === "--out") outPrefix = String(argv[++i] ?? "");
        else if (a === "--write-best") writeBest = Number(argv[++i] ?? "0") || 0;
        else if (a === "--dict-dir") dictDir = String(argv[++i] ?? "") || dictDir;
        else if (a === "--top") topN = Number(argv[++i] ?? "0") || topN;
        else if (a === "--no-xorv1") xorV1Enabled = false;
        else if (a === "--xorv1-all") xorV1All = true;
        else if (a === "--xorv1-w3") {
            xorV1W3 = String(argv[++i] ?? "")
                .split(",")
                .map((x) => Number.parseInt(x.trim(), 10))
                .filter((n) => Number.isFinite(n) && n >= 0 && n <= 255);
        }
        else usage();
    }

    // nonce is only required when AES candidates are enabled (i.e. password present);
    // XOR-v1 can be scanned without it.

    return {
        file,
        nonce,
        encryptLenDefault,
        headerLen,
        stripNewlineDash,
        chunkSizes,
        modes,
        outPrefix,
        writeBest,
        dictDir,
        topN,
        xorV1Enabled,
        xorV1All,
        xorV1W3,
    };
}

function main() {
    const args = parseArgs(process.argv);
    const password = readEnvPassword();
    const aesEnabled = !!password;
    if (!aesEnabled) {
        if (!args.xorV1Enabled) {
            console.error("Missing password in env (BAICHUAN_PASSWORD/TCP_PASSWORD/NVR_PASSWORD)");
            process.exit(2);
        }
        console.error(
            "Warning: password not set in env; skipping AES candidates (running XOR v1 only).",
        );
    }

    if (aesEnabled && !args.nonce) {
        console.error("Missing --nonce");
        process.exit(2);
    }

    const raw = fs.readFileSync(args.file);

    // Optional leading outer <Extension> XML (common in cmd298/cmd143 responses).
    // Format: [<Extension ...>...</Extension>\n][binary header + encrypted payload]
    let buf = raw;
    let outerPrefix = Buffer.alloc(0);
    let outerXml = null;
    let outerEncryptLen = null;
    const outer = trySplitLeadingExtension(buf);
    if (outer) {
        outerPrefix = buf.subarray(0, outer.splitAt);
        buf = outer.payload;
        outerXml = outer.xml;
        const encText = extractTagText(outerXml, "EncryptLen");
        const encParsed = encText ? Number.parseInt(encText, 10) : NaN;
        if (Number.isFinite(encParsed) && encParsed > 0) outerEncryptLen = encParsed;
    }

    let normalized = false;
    if (args.stripNewlineDash && buf.length >= 2 && buf[0] === 0x0a && buf[1] === 0x2d) {
        buf = buf.subarray(1);
        normalized = true;
    }

    const headerLen = Math.min(args.headerLen, buf.length);
    const header = buf.subarray(0, headerLen);

    // Optional inner XML after header (cmd298)
    let innerXml = null;
    let innerXmlLen = 0;
    let encryptLen = outerEncryptLen ?? args.encryptLenDefault;
    let ctStart = headerLen;

    const xmlNeedle = Buffer.from("<?xml", "utf8");
    const xmlAt = buf.indexOf(xmlNeedle, headerLen);
    if (xmlAt >= 0 && xmlAt <= headerLen + 256) {
        const rest = buf.subarray(xmlAt);
        const split = findCloseExtension(rest, 0);
        if (split) {
            innerXml = rest.subarray(0, split.splitAt).toString("utf8");
            innerXmlLen = split.splitAt;
            const encText = extractTagText(innerXml, "EncryptLen");
            const encParsed = encText ? Number.parseInt(encText, 10) : NaN;
            if (Number.isFinite(encParsed) && encParsed > 0) encryptLen = encParsed;
            ctStart = xmlAt + split.splitAt;
        }
    }

    const prefix = buf.subarray(0, ctStart);
    const ct = buf.subarray(ctStart);

    const fixedIv = Buffer.from("0123456789abcdef", "utf8");
    const header0 = header.length >= 16 ? header.subarray(0, 16) : null;
    const header1 = header.length >= 32 ? header.subarray(16, 32) : null;

    const keys = [];
    const ivs = [];
    if (aesEnabled) {
        const sessionKey = deriveAesKey(args.nonce, password);
        const sessionKeyMd5Bytes = md5_16_str(`${args.nonce}-${password}`);
        const sessionKeyMd5BytesNoDash = md5_16_str(`${args.nonce}${password}`);

        keys.push(["sessionKey", sessionKey]);
        keys.push(["md5bytes(nonce-password)", sessionKeyMd5Bytes]);
        keys.push(["md5bytes(nonce+password)", sessionKeyMd5BytesNoDash]);
        keys.push(["sha256(nonce-password)", sha256_16(Buffer.from(`${args.nonce}-${password}`, "utf8"))]);
        keys.push(["sha256(nonce+password)", sha256_16(Buffer.from(`${args.nonce}${password}`, "utf8"))]);
        if (header0) keys.push(["header0", header0]);
        if (header1) keys.push(["header1", header1]);
        if (header0) keys.push(["md5(header0)", md5_16(header0)]);
        if (header1) keys.push(["md5(header1)", md5_16(header1)]);
        if (header0) keys.push(["sha256(header0)", sha256_16(header0)]);
        if (header1) keys.push(["sha256(header1)", sha256_16(header1)]);
        if (header0 && header1) keys.push(["xor(header0,header1)", xor16(header0, header1)]);
        if (header0 && header1) keys.push(["md5(header0+header1)", md5_16(Buffer.concat([header0, header1]))]);
        if (header0 && header1) keys.push(["md5(header1+header0)", md5_16(Buffer.concat([header1, header0]))]);
        if (header0 && header1) keys.push(["sha256(header0+header1)", sha256_16(Buffer.concat([header0, header1]))]);
        if (header0 && header1) keys.push(["sha256(header1+header0)", sha256_16(Buffer.concat([header1, header0]))]);
        if (header0) keys.push(["md5(sessionKey+header0)", md5_16(Buffer.concat([sessionKey, header0]))]);
        if (header1) keys.push(["md5(sessionKey+header1)", md5_16(Buffer.concat([sessionKey, header1]))]);
        if (header0) keys.push(["md5(header0+sessionKey)", md5_16(Buffer.concat([header0, sessionKey]))]);
        if (header1) keys.push(["md5(header1+sessionKey)", md5_16(Buffer.concat([header1, sessionKey]))]);
        if (header0) keys.push(["md5bytes(nonce-password)+header0", md5_16(Buffer.concat([sessionKeyMd5Bytes, header0]))]);
        if (header1) keys.push(["md5bytes(nonce-password)+header1", md5_16(Buffer.concat([sessionKeyMd5Bytes, header1]))]);
        if (header0) keys.push(["xor(sessionKey,header0)", xor16(sessionKey, header0)]);
        if (header1) keys.push(["xor(sessionKey,header1)", xor16(sessionKey, header1)]);

        // HKDF-based hypotheses (seen in OpenSSL strings): derive 16 bytes.
        if (header0)
            keys.push(["hkdf(sessionKey,salt=header0)", hkdfSha256_16(sessionKey, header0, Buffer.alloc(0))]);
        if (header1)
            keys.push(["hkdf(sessionKey,salt=header1)", hkdfSha256_16(sessionKey, header1, Buffer.alloc(0))]);
        if (header0 && header1)
            keys.push([
                "hkdf(sessionKey,salt=header0,info=header1)",
                hkdfSha256_16(sessionKey, header0, header1),
            ]);
        if (header0 && header1)
            keys.push([
                "hkdf(md5bytes(nonce-password),salt=header0,info=header1)",
                hkdfSha256_16(sessionKeyMd5Bytes, header0, header1),
            ]);

        ivs.push(["fixedIv", fixedIv]);
        if (header0) ivs.push(["header0", header0]);
        if (header1) ivs.push(["header1", header1]);
        if (header0) ivs.push(["md5(header0)", md5_16(header0)]);
        if (header1) ivs.push(["md5(header1)", md5_16(header1)]);
        if (header0 && header1) ivs.push(["xor(header0,header1)", xor16(header0, header1)]);
        if (header0 && header1) ivs.push(["md5(header0+header1)", md5_16(Buffer.concat([header0, header1]))]);
        if (header0 && header1) ivs.push(["md5(header1+header0)", md5_16(Buffer.concat([header1, header0]))]);
    }

    const strategies = [
        ["firstN", (p) => decryptFirstN({ ...p, n: encryptLen })],
        ["perBlockReset", (p) => decryptPerBlockReset({ ...p, block: encryptLen })],
        ["dropIvFirstN", (p) => decryptDropIvFirstN({ ...p, n: encryptLen })],
        ...args.chunkSizes.map((cs) => [
            `perChunkFirstN(chunk=${cs})`,
            (p) => decryptPerChunkFirstN({ ...p, chunkSize: cs, encryptLen }),
        ]),
        ...args.chunkSizes.map((cs) => [
            `perChunkDropIvFirstN(chunk=${cs})`,
            (p) => decryptPerChunkDropIvFirstN({ ...p, chunkSize: cs, encryptLen }),
        ]),
    ];

    const candidates = [];

    if (aesEnabled) {
        for (const mode of args.modes) {
            for (const [kName, key] of keys) {
                for (const [ivName, iv] of ivs) {
                    for (const [sName, fn] of strategies) {
                        let pt;
                        try {
                            pt = fn({ mode, key, iv, ct });
                        } catch {
                            continue;
                        }

                        const full = outerPrefix.length
                            ? Buffer.concat([outerPrefix, prefix, pt])
                            : Buffer.concat([prefix, pt]);
                        const { score, sig } = scoreCandidate(pt);

                        // Extra: try inflate if zlib header is found early
                        let inflate = null;
                        let scoreAdj = score;
                        if (sig.zlibAt >= 0 && sig.zlibAt < 64 * 1024) {
                            const r = tryInflateAtWithDict(pt, sig.zlibAt, sig.zlibDictId, args.dictDir);
                            if (r && r.ok && r.out && r.out.length) {
                                const s2 = scoreCandidate(r.out);
                                inflate = {
                                    at: sig.zlibAt,
                                    dictId: sig.zlibDictId,
                                    usedDict: r.usedDict,
                                    outLen: r.out.length,
                                    outHeadHex: hexHead(r.out, 32),
                                    score: s2.score,
                                    sig: s2.sig,
                                };
                                // successful inflate is a strong signal
                                scoreAdj += 500;
                            } else if (r && r.ok === false) {
                                inflate = {
                                    at: sig.zlibAt,
                                    dictId: sig.zlibDictId,
                                    error: r.reason,
                                    dictFile: r.dictFile ?? null,
                                };
                                // zlib-header-but-not-inflatable is usually a false positive
                                scoreAdj -= 80;
                            }
                        }

                        candidates.push({
                            mode,
                            key: kName,
                            iv: ivName,
                            strategy: sName,
                            encryptLen,
                            headerLen,
                            ctStart,
                            score,
                            scoreAdj,
                            ptHeadHex: hexHead(pt, 32),
                            sig,
                            inflate,
                            // for optional writes
                            _full: full,
                        });
                    }
                }
            }
        }
    }

    if (args.xorV1Enabled) {
        const w3s = args.xorV1All ? Array.from({ length: 256 }, (_, i) => i) : args.xorV1W3;
        const xorStrategies = [
            ["firstN", (w3) => xorV1FirstN({ ct, w3, n: encryptLen })],
            ["perBlockReset", (w3) => xorV1PerBlockReset({ ct, w3, block: encryptLen })],
            ["perBlockBaseOffset", (w3) => xorV1PerBlockBaseOffset({ ct, w3, block: encryptLen })],
            ["all", (w3) => xorV1All({ ct, w3 })],
            ...args.chunkSizes.map((cs) => [
                `perChunkFirstN(chunk=${cs})`,
                (w3) => xorV1PerChunkFirstN({ ct, w3, chunkSize: cs, encryptLen }),
            ]),
            ...args.chunkSizes.map((cs) => [
                `perChunkFirstNBaseOffset(chunk=${cs})`,
                (w3) => xorV1PerChunkFirstNBaseOffset({ ct, w3, chunkSize: cs, encryptLen }),
            ]),
        ];

        for (const w3 of w3s) {
            for (const [sName, fn] of xorStrategies) {
                let pt;
                try {
                    pt = fn(w3);
                } catch {
                    continue;
                }

                const full = outerPrefix.length
                    ? Buffer.concat([outerPrefix, prefix, pt])
                    : Buffer.concat([prefix, pt]);
                const { score, sig } = scoreCandidate(pt);

                let inflate = null;
                let scoreAdj = score;
                if (sig.zlibAt >= 0 && sig.zlibAt < 64 * 1024) {
                    const r = tryInflateAtWithDict(pt, sig.zlibAt, sig.zlibDictId, args.dictDir);
                    if (r && r.ok && r.out && r.out.length) {
                        const s2 = scoreCandidate(r.out);
                        inflate = {
                            at: sig.zlibAt,
                            dictId: sig.zlibDictId,
                            usedDict: r.usedDict,
                            outLen: r.out.length,
                            outHeadHex: hexHead(r.out, 32),
                            score: s2.score,
                            sig: s2.sig,
                        };
                        scoreAdj += 500;
                    } else if (r && r.ok === false) {
                        inflate = {
                            at: sig.zlibAt,
                            dictId: sig.zlibDictId,
                            error: r.reason,
                            code: r.code ?? null,
                            message: r.message ?? null,
                            dictFile: r.dictFile ?? null,
                        };
                        scoreAdj -= 80;
                    }
                }

                candidates.push({
                    mode: "xor-v1",
                    key: "netXmlEncryptionV1",
                    iv: "-",
                    w3,
                    strategy: sName,
                    encryptLen,
                    headerLen,
                    ctStart,
                    score,
                    scoreAdj,
                    ptHeadHex: hexHead(pt, 32),
                    sig,
                    inflate,
                    _full: full,
                });
            }
        }
    }

    candidates.sort((a, b) => (b.scoreAdj ?? b.score) - (a.scoreAdj ?? a.score));

    const base = args.outPrefix
        ? args.outPrefix
        : path.join(
            "pcap/reports/dec",
            `${path.basename(args.file)}.scan`,
        );

    fs.mkdirSync(path.dirname(base), { recursive: true });

    const report = {
        input: args.file,
        rawLen: raw.length,
        outer: outerXml
            ? {
                xmlLen: outerPrefix.length,
                encryptLen: outerEncryptLen,
                xmlPreview: outerXml.length > 400 ? outerXml.slice(0, 400) + "..." : outerXml,
            }
            : null,
        normalizedNewlineDash: normalized,
        nonce: args.nonce,
        headerLen,
        headerHex: hexHead(header, 64),
        innerXmlFound: !!innerXml,
        innerXmlAt: innerXml ? xmlAt : null,
        innerXmlLen,
        encryptLen,
        ctStart,
        ctLen: ct.length,
        dictDir: args.dictDir,
        xorV1: {
            enabled: args.xorV1Enabled,
            all: args.xorV1All,
            w3: args.xorV1All ? "0..255" : args.xorV1W3,
            key8Hex: XOR_V1_KEY8.toString("hex"),
        },
        top: candidates.slice(0, Math.max(1, Math.min(args.topN, candidates.length))).map((c) => {
            const { _full, ...rest } = c;
            return rest;
        }),
    };

    const reportPath = `${base}.json`;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    if (args.writeBest > 0) {
        fs.mkdirSync("pcap/reports/dec", { recursive: true });
        const n = Math.min(args.writeBest, candidates.length);
        for (let i = 0; i < n; i++) {
            const c = candidates[i];
            const safe = (s) => String(s).replace(/[^a-z0-9@._()-]+/gi, "_");
            const w3Part = c.mode === "xor-v1" && Number.isFinite(c.w3) ? `.w3${c.w3}` : "";
            const outPath = `pcap/reports/dec/${path.basename(args.file)}.${safe(c.strategy)}.${safe(c.mode)}${w3Part}.${safe(c.key)}.${safe(c.iv)}.score${Math.round(c.score)}.bin`;
            fs.writeFileSync(outPath, c._full);
        }
    }

    console.log(JSON.stringify({ ok: true, reportPath }, null, 2));
}

main();
