#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";

import "dotenv/config";
import { deriveAesKey } from "../../dist/index.cjs";

function readEnvPassword() {
    return (
        process.env.BAICHUAN_PASSWORD ??
        process.env.TCP_PASSWORD ??
        process.env.NVR_PASSWORD ??
        ""
    ).trim();
}

function detect(pt) {
    const jpgAt = pt.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    const pngAt = pt.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const ftypAt = pt.indexOf(Buffer.from("ftyp", "ascii"));
    const annexBAt = pt.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
    return { jpgAt, pngAt, ftypAt, annexBAt };
}

function score(pt) {
    const { jpgAt, pngAt, ftypAt, annexBAt } = detect(pt);
    let s = 0;
    if (jpgAt >= 0 && jpgAt < 4096) s += 500;
    if (pngAt >= 0 && pngAt < 4096) s += 500;
    if (ftypAt >= 0 && ftypAt < 4096) s += 300;
    if (annexBAt >= 0 && annexBAt < 4096) s += 150;

    // Some weak ASCII bonus
    const n = Math.min(pt.length, 4096);
    let ascii = 0;
    for (let i = 0; i < n; i++) {
        const c = pt[i];
        if (c >= 0x20 && c <= 0x7e) ascii++;
    }
    s += ascii / 200;
    return s;
}

function aesDec(mode, key, iv, buf) {
    const len = mode.endsWith("cbc") ? buf.length - (buf.length % 16) : buf.length;
    const d = crypto.createDecipheriv(mode, key, mode.endsWith("ecb") ? null : iv);
    d.setAutoPadding(false);
    const pt = Buffer.concat([d.update(buf.subarray(0, len)), d.final()]);
    // append any remaining tail for CBC (kept encrypted, but shouldn't matter for detection)
    return mode.endsWith("cbc") && len < buf.length ? Buffer.concat([pt, buf.subarray(len)]) : pt;
}

function md5_16(buf) {
    return crypto.createHash("md5").update(buf).digest().subarray(0, 16);
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

function main() {
    const innerFile = process.argv[2];
    if (!innerFile) {
        console.error(
            "Usage: node tools/pcap/try-encryptlen-decode.mjs <inner.bin> --nonce <nonce> [--outer <outerBinOnly.bin>] [--encrypt-len 528] [--inner-header-len 16] [--write-best 5]",
        );
        process.exit(2);
    }

    let outerFile = null;
    let nonce = null;
    let encryptLen = 528;
    let innerHeaderLen = 16;
    let writeBest = 0;

    for (let i = 3; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === "--outer") outerFile = String(process.argv[++i] ?? "");
        else if (a === "--nonce") nonce = String(process.argv[++i] ?? "");
        else if (a === "--encrypt-len") encryptLen = Number(process.argv[++i] ?? "0") || encryptLen;
        else if (a === "--inner-header-len") innerHeaderLen = Number(process.argv[++i] ?? "0") || 0;
        else if (a === "--write-best") writeBest = Number(process.argv[++i] ?? "0") || 0;
    }

    const password = readEnvPassword();
    if (!password) {
        console.error("Missing password in env (BAICHUAN_PASSWORD/TCP_PASSWORD/NVR_PASSWORD)");
        process.exit(2);
    }

    const ctFull = fs.readFileSync(innerFile);
    const innerHeader = innerHeaderLen > 0 ? ctFull.subarray(0, Math.min(innerHeaderLen, ctFull.length)) : Buffer.alloc(0);
    const ct = ctFull.subarray(Math.min(innerHeaderLen, ctFull.length));

    let prefix32 = null;
    if (outerFile) {
        const ob = fs.readFileSync(outerFile);
        prefix32 = ob.subarray(0, 32);
    }

    const fixedIv = Buffer.from("0123456789abcdef", "utf8");
    const p0 = prefix32 ? prefix32.subarray(0, 16) : null;
    const p1 = prefix32 ? prefix32.subarray(16, 32) : null;

    const i0 = ctFull.length >= 16 ? ctFull.subarray(0, 16) : null;
    const i1 = ctFull.length >= 32 ? ctFull.subarray(16, 32) : null;

    const keys = [];
    const sessionKey = nonce ? deriveAesKey(nonce, password) : null;
    if (sessionKey) keys.push(["sessionKey", sessionKey]);
    if (p0) keys.push(["prefix0", p0]);
    if (p1) keys.push(["prefix1", p1]);
    if (i0) keys.push(["innerPrefix0", i0]);
    if (i1) keys.push(["innerPrefix1", i1]);

    // Extra hypotheses seen in other Reolink flows: derived keys from seeds.
    if (sessionKey && p0) keys.push(["md5(sessionKey+prefix0)", md5_16(Buffer.concat([sessionKey, p0]))]);
    if (sessionKey && p1) keys.push(["md5(sessionKey+prefix1)", md5_16(Buffer.concat([sessionKey, p1]))]);
    if (p0 && p1) keys.push(["md5(prefix0+prefix1)", md5_16(Buffer.concat([p0, p1]))]);
    if (sessionKey && p0) keys.push(["xor(sessionKey,prefix0)", xor16(sessionKey, p0)]);
    if (sessionKey && p1) keys.push(["xor(sessionKey,prefix1)", xor16(sessionKey, p1)]);

    if (sessionKey && i0) keys.push(["md5(sessionKey+innerPrefix0)", md5_16(Buffer.concat([sessionKey, i0]))]);
    if (sessionKey && i1) keys.push(["md5(sessionKey+innerPrefix1)", md5_16(Buffer.concat([sessionKey, i1]))]);
    if (i0 && i1) keys.push(["md5(innerPrefix0+innerPrefix1)", md5_16(Buffer.concat([i0, i1]))]);
    if (sessionKey && i0) keys.push(["xor(sessionKey,innerPrefix0)", xor16(sessionKey, i0)]);
    if (sessionKey && i1) keys.push(["xor(sessionKey,innerPrefix1)", xor16(sessionKey, i1)]);

    const ivs = [["fixedIv", fixedIv]];
    if (p0) ivs.push(["prefix0", p0]);
    if (p1) ivs.push(["prefix1", p1]);
    if (i0) ivs.push(["innerPrefix0", i0]);
    if (i1) ivs.push(["innerPrefix1", i1]);

    const modes = ["aes-128-cfb", "aes-128-ctr", "aes-128-cbc", "aes-128-ecb"];
    const chunkSizes = [encryptLen, 2048, 4096, 8192];

    const strategies = [
        ["firstN", (p) => decryptFirstN({ ...p, n: encryptLen })],
        ["perBlockReset", (p) => decryptPerBlockReset({ ...p, block: encryptLen })],
        ...chunkSizes.map((cs) => [
            `perChunkFirstN(chunk=${cs})`,
            (p) => decryptPerChunkFirstN({ ...p, chunkSize: cs, encryptLen }),
        ]),
    ];

    const results = [];
    for (const [kName, key] of keys) {
        for (const [ivName, iv] of ivs) {
            for (const mode of modes) {
                for (const [sName, fn] of strategies) {
                    try {
                        const ptBody = fn({ mode, key, iv, ct });
                        const pt = innerHeader.length ? Buffer.concat([innerHeader, ptBody]) : ptBody;
                        const det = detect(pt);
                        results.push({
                            strategy: sName,
                            mode,
                            key: kName,
                            iv: ivName,
                            score: score(pt),
                            headHex: pt.subarray(0, 16).toString("hex"),
                            ...det,
                        });
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, 20);
    console.log(JSON.stringify({ innerFile, len: ctFull.length, outerFile, encryptLen, innerHeaderLen, top }, null, 2));

    if (writeBest > 0 && top.length) {
        fs.mkdirSync("pcap/reports/dec", { recursive: true });
        for (let i = 0; i < Math.min(writeBest, results.length); i++) {
            const r = results[i];
            const key = keys.find((x) => x[0] === r.key)?.[1];
            const iv = ivs.find((x) => x[0] === r.iv)?.[1];
            if (!key || !iv) continue;
            let pt;
            try {
                const header = innerHeader.length ? innerHeader : null;
                if (r.strategy === "firstN") {
                    const body = decryptFirstN({ mode: r.mode, key, iv, ct, n: encryptLen });
                    pt = header ? Buffer.concat([header, body]) : body;
                } else if (r.strategy === "perBlockReset") {
                    const body = decryptPerBlockReset({ mode: r.mode, key, iv, ct, block: encryptLen });
                    pt = header ? Buffer.concat([header, body]) : body;
                } else {
                    const m = /^perChunkFirstN\(chunk=(\d+)\)$/.exec(r.strategy);
                    const chunkSize = m ? Number(m[1]) : encryptLen;
                    const body = decryptPerChunkFirstN({ mode: r.mode, key, iv, ct, chunkSize, encryptLen });
                    pt = header ? Buffer.concat([header, body]) : body;
                }
            } catch {
                continue;
            }
            const out = `pcap/reports/dec/${innerFile.split("/").pop()}.${r.strategy}.${r.mode}.${r.key}.${r.iv}.score${Math.round(r.score)}.bin`;
            fs.writeFileSync(out, pt);
        }
    }
}

main();
