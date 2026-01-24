#!/usr/bin/env node
/**
 * Try to decrypt a Baichuan message body under hypotheses for encType=0x12 ("full_aes").
 *
 * Usage:
 *   node tools/pcap/try-full-aes-decrypt-xml.mjs --nonce <nonce> --password <pw> --in <file>
 */

import fs from "node:fs";
import crypto from "node:crypto";
import "dotenv/config";

function parseArgs(argv) {
    const args = [...argv];
    const out = {
        nonce: "",
        password: "",
        inPath: "",
    };

    while (args.length) {
        const a = args.shift();
        if (!a) break;
        if (a === "--nonce") out.nonce = String(args.shift() ?? "");
        else if (a === "--password") out.password = String(args.shift() ?? "");
        else if (a === "--in") out.inPath = String(args.shift() ?? "");
    }

    if (!out.nonce) throw new Error("Missing --nonce");
    if (!out.password) {
        out.password =
            process.env.BAICHUAN_PASSWORD ??
            process.env.TCP_PASSWORD ??
            process.env.NVR_PASSWORD ??
            "";
    }
    if (!out.password) throw new Error("Missing --password (and no password in env)");
    if (!out.inPath) throw new Error("Missing --in");

    return out;
}

function md5HexUpper(input) {
    return crypto.createHash("md5").update(input, "utf8").digest("hex").toUpperCase();
}

function md5StrModern(input) {
    return md5HexUpper(input).slice(0, 31);
}

function deriveAesKey(nonce, password) {
    const keyStr = md5StrModern(`${nonce}-${password}`).slice(0, 16);
    return Buffer.from(keyStr, "utf8");
}

function tryDecrypt({ mode, key, iv, data }) {
    const decipher = crypto.createDecipheriv(mode, key, iv);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(data), decipher.final()]);
}

function looksLikeXml(buf) {
    const s = buf.toString("utf8");
    return s.startsWith("<?xml") || s.startsWith("<");
}

function main() {
    const { nonce, password, inPath } = parseArgs(process.argv.slice(2));
    const body = fs.readFileSync(inPath);
    const key = deriveAesKey(nonce, password);

    const fixedIv = Buffer.from("0123456789abcdef", "utf8");
    const ivFromPrefix = body.length >= 16 ? body.subarray(0, 16) : null;
    const payloadAfterPrefix = body.length >= 16 ? body.subarray(16) : body;

    const trials = [];

    // Legacy "aes" behavior.
    trials.push({
        name: "aes-128-cfb fixedIV (whole)",
        mode: "aes-128-cfb",
        iv: fixedIv,
        data: body,
    });

    // Hypothesis: full_aes prepends 16-byte IV (skip it from plaintext).
    if (ivFromPrefix) {
        trials.push({
            name: "aes-128-cfb iv=prefix, decrypt after16",
            mode: "aes-128-cfb",
            iv: ivFromPrefix,
            data: payloadAfterPrefix,
        });
        trials.push({
            name: "aes-128-ctr iv=prefix, decrypt after16",
            mode: "aes-128-ctr",
            iv: ivFromPrefix,
            data: payloadAfterPrefix,
        });
        trials.push({
            name: "aes-128-cfb iv=prefix, decrypt whole (including prefix)",
            mode: "aes-128-cfb",
            iv: ivFromPrefix,
            data: body,
        });
    }

    const results = [];
    for (const t of trials) {
        let dec;
        try {
            dec = tryDecrypt({ mode: t.mode, key, iv: t.iv, data: t.data });
        } catch (e) {
            results.push({ name: t.name, ok: false, error: String(e?.message ?? e) });
            continue;
        }

        const ok = looksLikeXml(dec);
        const preview = dec.subarray(0, 80).toString("utf8").replace(/\s+/g, " ");
        results.push({ name: t.name, ok, preview });

        if (ok) {
            process.stdout.write(dec.toString("utf8"));
            return;
        }
    }

    console.log(JSON.stringify({ inPath, size: body.length, results }, null, 2));
}

main();
