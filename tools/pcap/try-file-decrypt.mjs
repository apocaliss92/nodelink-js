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

function score(pt) {
    const sigs = [
        { name: "jpeg", buf: Buffer.from([0xff, 0xd8, 0xff]) },
        { name: "png", buf: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
        { name: "mp4_ftyp", buf: Buffer.from("ftyp", "ascii") },
        { name: "mp4_moov", buf: Buffer.from("moov", "ascii") },
        { name: "mp4_moof", buf: Buffer.from("moof", "ascii") },
        { name: "mp4_mdat", buf: Buffer.from("mdat", "ascii") },
        { name: "annexb", buf: Buffer.from([0x00, 0x00, 0x00, 0x01]) },
        { name: "lz4frame", buf: Buffer.from([0x04, 0x22, 0x4d, 0x18]) },
        // common zlib headers (CMF/FLG combos)
        { name: "zlib_789c", buf: Buffer.from([0x78, 0x9c]) },
        { name: "zlib_78da", buf: Buffer.from([0x78, 0xda]) },
    ];

    let s = 0;
    for (const sig of sigs) {
        const i = pt.indexOf(sig.buf);
        if (i >= 0 && i < 4096) {
            // Stronger weights for file-type magics.
            if (sig.name === "jpeg" || sig.name === "png") s += 200;
            else if (sig.name.startsWith("mp4_")) s += 120;
            else if (sig.name === "annexb") s += 80;
            else if (sig.name === "lz4frame" || sig.name.startsWith("zlib_")) s += 60;
            else s += 30;
        }
    }

    // Weak heuristic: some plaintext formats contain a bit of ASCII (XML/paths/atoms)
    let ascii = 0;
    const n = Math.min(4096, pt.length);
    for (let i = 0; i < n; i++) {
        const c = pt[i];
        if (c >= 0x20 && c <= 0x7e) ascii++;
    }
    s += ascii / 120;

    return s;
}

function decryptSlice({ mode, key, iv, buf }) {
    const len = mode.endsWith("cbc") ? buf.length - (buf.length % 16) : buf.length;
    const slice = buf.subarray(0, Math.min(len, 256 * 1024));
    const d = crypto.createDecipheriv(mode, key, iv);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(slice), d.final()]);
}

function parseArgs(argv) {
    const out = {
        file: argv[2] ?? null,
        nonce: null,
        skips: [],
        layouts: [],
        writeBest: 0,
        outDir: "pcap/reports/dec",
    };

    for (let i = 3; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--nonce") out.nonce = String(argv[++i] ?? "");
        else if (a === "--skip") out.skips.push(Number(argv[++i] ?? "0") || 0);
        else if (a === "--layout") out.layouts.push(String(argv[++i] ?? "").trim());
        else if (a === "--write-best") out.writeBest = Number(argv[++i] ?? "0") || 0;
        else if (a === "--out-dir") out.outDir = String(argv[++i] ?? out.outDir);
    }

    return out;
}

function ensureDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch {
        // ignore
    }
}

function detectType(pt) {
    if (pt.length >= 3 && pt[0] === 0xff && pt[1] === 0xd8 && pt[2] === 0xff) return "jpg";
    if (
        pt.length >= 8 &&
        pt[0] === 0x89 &&
        pt[1] === 0x50 &&
        pt[2] === 0x4e &&
        pt[3] === 0x47 &&
        pt[4] === 0x0d &&
        pt[5] === 0x0a &&
        pt[6] === 0x1a &&
        pt[7] === 0x0a
    )
        return "png";
    // MP4: ftyp at offset 4 is common (size u32 then 'ftyp')
    if (pt.length >= 12 && pt.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
    // AnnexB-ish: start code very early
    if (pt.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01])) >= 0 && pt.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01])) < 32) return "bin";
    return "bin";
}

function main() {
    const args = parseArgs(process.argv);
    const file = args.file;
    if (!file) {
        console.error(
            "Usage: node tools/pcap/try-file-decrypt.mjs <file> [--nonce <nonce>] [--skip <n>]... [--write-best <n>] [--out-dir <dir>]",
        );
        process.exit(2);
    }

    const nonce = args.nonce;

    const password = readEnvPassword();
    if (!password) {
        console.error("Missing password in env (BAICHUAN_PASSWORD/TCP_PASSWORD/NVR_PASSWORD)");
        process.exit(2);
    }

    const buf = fs.readFileSync(file);
    const iv16 = buf.subarray(0, 16);
    const ivFixed = Buffer.from("0123456789abcdef", "utf8");

    // "skip" means where ciphertext starts.
    // Some blobs embed IV inside the ciphertext blob itself (e.g. [iv16][cipher...]
    // or [typeByte][iv16][cipher...]).
    const skips = args.skips.length ? Array.from(new Set(args.skips)) : [0, 16, 17];

    // Layouts define where to read IV from (ivOffset) and where ciphertext starts (cipherOffset).
    // Users can force layouts via --layout, otherwise we try a few common ones.
    const defaultLayouts = [
        { name: "iv@0 cipher@0", ivOffset: 0, cipherOffset: 0 },
        { name: "iv@0 cipher@16", ivOffset: 0, cipherOffset: 16 },
        { name: "iv@1 cipher@17", ivOffset: 1, cipherOffset: 17 },
    ];

    const layouts = (args.layouts.length ? args.layouts : defaultLayouts.map((l) => l.name)).map((name) => {
        const m = /^iv@(\d+)\s+cipher@(\d+)$/.exec(name);
        if (!m) throw new Error(`Invalid --layout ${JSON.stringify(name)} (expected e.g. 'iv@1 cipher@17')`);
        return { name, ivOffset: Number(m[1]), cipherOffset: Number(m[2]) };
    });

    const keys = [];
    if (nonce) keys.push(["sessionKey(nonce+password)", deriveAesKey(nonce, password)]);
    keys.push(["iv16", iv16]);

    const ivsFor = (ivOffset, cipherOffset) => {
        const ivAtIv = buf.subarray(ivOffset, ivOffset + 16);
        const ivAtCipher = buf.subarray(cipherOffset, cipherOffset + 16);
        return [
            ["fixedIv", ivFixed],
            ["iv16(file0)", iv16],
            ivAtIv.length === 16 ? [`iv16@iv${ivOffset}`, ivAtIv] : null,
            ivAtCipher.length === 16 ? [`iv16@cipher${cipherOffset}`, ivAtCipher] : null,
        ].filter(Boolean);
    };

    const modes = ["aes-128-cfb", "aes-128-ctr", "aes-128-cbc"];

    const best = [];
    const runCandidate = ({ layoutName, ivOffset, cipherOffset, extraSkip }) => {
        const skip = cipherOffset + extraSkip;
        if (skip < 0 || skip > buf.length) return;
        const cipher = buf.subarray(skip);
        const ivs = ivsFor(ivOffset, cipherOffset);

        for (const [kname, key] of keys) {
            for (const [ivname, iv] of ivs) {
                for (const mode of modes) {
                    try {
                        const pt = decryptSlice({ mode, key, iv, buf: cipher });
                        best.push({
                            layout: layoutName,
                            ivOffset,
                            cipherOffset,
                            skip,
                            mode,
                            key: kname,
                            iv: ivname,
                            score: score(pt),
                            headHex: pt.subarray(0, 16).toString("hex"),
                            jpgAt: pt.indexOf(Buffer.from([0xff, 0xd8, 0xff])),
                            pngAt: pt.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
                            ftypAt: pt.indexOf(Buffer.from("ftyp", "ascii")),
                            annexBAt: pt.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01])),
                            lz4At: pt.indexOf(Buffer.from([0x04, 0x22, 0x4d, 0x18])),
                            zlibAt: Math.min(
                                ...[
                                    pt.indexOf(Buffer.from([0x78, 0x9c])),
                                    pt.indexOf(Buffer.from([0x78, 0xda])),
                                ].filter((x) => x >= 0),
                            ),
                        });
                    } catch {
                        // ignore
                    }
                }
            }
        }
    };

    for (const l of layouts) {
        // Try layout as-is, plus additional user-provided skip offsets.
        runCandidate({
            layoutName: l.name,
            ivOffset: l.ivOffset,
            cipherOffset: l.cipherOffset,
            extraSkip: 0,
        });
        for (const s of skips) {
            runCandidate({
                layoutName: `${l.name} +skip${s}`,
                ivOffset: l.ivOffset,
                cipherOffset: l.cipherOffset,
                extraSkip: s,
            });
        }
    }

    best.sort((a, b) => b.score - a.score);

    const top = best.slice(0, 12);
    console.log(JSON.stringify({ file, len: buf.length, skips, layouts: layouts.map((l) => l.name), best: top }, null, 2));

    if (args.writeBest > 0) {
        ensureDir(args.outDir);
        for (let i = 0; i < Math.min(args.writeBest, best.length); i++) {
            const c = best[i];
            const cipher = buf.subarray(c.skip);

            const ivAtIv =
                typeof c.ivOffset === "number"
                    ? buf.subarray(c.ivOffset, c.ivOffset + 16)
                    : Buffer.alloc(0);
            const ivAtCipher =
                typeof c.cipherOffset === "number"
                    ? buf.subarray(c.cipherOffset, c.cipherOffset + 16)
                    : Buffer.alloc(0);

            const iv =
                c.iv === "fixedIv"
                    ? ivFixed
                    : c.iv === "iv16(file0)"
                        ? iv16
                        : String(c.iv).startsWith("iv16@iv") && ivAtIv.length === 16
                            ? ivAtIv
                            : String(c.iv).startsWith("iv16@cipher") && ivAtCipher.length === 16
                                ? ivAtCipher
                                : ivFixed;

            const key = c.key.startsWith("sessionKey")
                ? deriveAesKey(nonce ?? "", password)
                : c.key === "iv16"
                    ? iv16
                    : iv16;

            let pt;
            try {
                pt = decryptSlice({ mode: c.mode, key, iv, buf: cipher });
            } catch {
                continue;
            }

            const ext = detectType(pt);
            const safeMode = c.mode.replace(/[^a-z0-9_-]/gi, "_");
            const safeKey = String(c.key).replace(/[^a-z0-9_-]/gi, "_");
            const safeIv = String(c.iv).replace(/[^a-z0-9@_-]/gi, "_");
            const safeLayout = String(c.layout ?? "layout").replace(/[^a-z0-9@ _-]/gi, "_").replace(/\s+/g, "_");
            const outName = `${file.split("/").pop()}.${safeLayout}.skip${c.skip}.${safeMode}.${safeKey}.${safeIv}.score${Math.round(c.score)}.${ext}`;
            const outPath = `${args.outDir}/${outName}`;
            try {
                fs.writeFileSync(outPath, pt);
            } catch {
                // ignore
            }
        }
    }
}

main();
