#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import { createDecipheriv } from "node:crypto";
import "dotenv/config";

// CJS exports from dist for convenience.
const require = createRequire(import.meta.url);
const { aesDecrypt, bcDecrypt, deriveAesKey } = require("../../dist/index.cjs");

function die(msg) {
    process.stderr.write(msg + "\n");
    process.exit(1);
}

function startCodeHits(buf) {
    let c = 0;
    for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] !== 0x00 || buf[i + 1] !== 0x00) continue;
        if (buf[i + 2] === 0x01) c++;
        else if (buf[i + 2] === 0x00 && buf[i + 3] === 0x01) c++;
    }
    return c;
}

function magicFirstOffsets(buf) {
    const strings = [
        "1001",
        "1002",
        "cd00",
        "cd01",
        "cd02",
        "cd03",
        "cd04",
        "cd05",
        "cd06",
        "cd07",
        "cd08",
        "cd09",
        "cd10",
        "cd11",
        "cd12",
        "cd13",
        "cd14",
        "cd15",
        "cd16",
        "cd17",
        "cd18",
        "cd19",
        "bw50",
        "bw10",
    ];
    const out = {};
    for (const s of strings) out[s] = buf.indexOf(Buffer.from(s, "ascii"));
    return out;
}

function passwordFromEnv() {
    return (
        process.env.BAICHUAN_PASSWORD ??
        process.env.TCP_PASSWORD ??
        process.env.NVR_PASSWORD ??
        ""
    ).trim();
}

function main() {
    const file = process.argv[2];
    const channelId = Number.parseInt(process.argv[3] ?? "20", 10);
    const nonce = (process.argv[4] ?? process.env.BAICHUAN_NONCE ?? "").trim();
    const extFile = process.argv[5];

    if (!file) die("Usage: node tools/pcap/inspect-chunk-decrypt.mjs <chunk.bin> [channelId] [nonce]");
    if (!Number.isFinite(channelId) || channelId < 0 || channelId > 255) die("Invalid channelId");
    if (!nonce) die("Missing nonce (arg or BAICHUAN_NONCE env)");

    const pass = passwordFromEnv();
    if (!pass) die("Missing password env (BAICHUAN_PASSWORD/TCP_PASSWORD/NVR_PASSWORD)");

    const key = deriveAesKey(nonce, pass);
    const raw = fs.readFileSync(file);

    const aes = aesDecrypt(raw, key);
    const bc = bcDecrypt(raw, channelId);

    let ivFromExt = null;
    let aesCfbExtIv = null;
    let aesCtrExtIv = null;
    let aesCbcExtIv = null;

    if (extFile) {
        const ext = fs.readFileSync(extFile);
        if (ext.length >= 16) {
            ivFromExt = ext.subarray(0, 16);

            const decCfb = createDecipheriv("aes-128-cfb", key, ivFromExt);
            decCfb.setAutoPadding(false);
            aesCfbExtIv = Buffer.concat([decCfb.update(raw), decCfb.final()]);

            const decCtr = createDecipheriv("aes-128-ctr", key, ivFromExt);
            decCtr.setAutoPadding(false);
            aesCtrExtIv = Buffer.concat([decCtr.update(raw), decCtr.final()]);

            // CBC requires block alignment; our chunks often are aligned (e.g. 1024).
            if (raw.length % 16 === 0) {
                const decCbc = createDecipheriv("aes-128-cbc", key, ivFromExt);
                decCbc.setAutoPadding(false);
                aesCbcExtIv = Buffer.concat([decCbc.update(raw), decCbc.final()]);
            }
        }
    }

    const report = {
        input: { file, bytes: raw.length, channelId, nonce },
        raw: {
            headHex: raw.subarray(0, Math.min(32, raw.length)).toString("hex"),
            startCodeHits: startCodeHits(raw),
            magicFirstOffsets: magicFirstOffsets(raw),
        },
        aes: {
            headHex: aes.subarray(0, Math.min(32, aes.length)).toString("hex"),
            startCodeHits: startCodeHits(aes),
            magicFirstOffsets: magicFirstOffsets(aes),
        },
        bc: {
            headHex: bc.subarray(0, Math.min(32, bc.length)).toString("hex"),
            startCodeHits: startCodeHits(bc),
            magicFirstOffsets: magicFirstOffsets(bc),
        },
        ...(ivFromExt
            ? {
                ivFromExtHex: Buffer.from(ivFromExt).toString("hex"),
                aesCfbExtIv: {
                    headHex: aesCfbExtIv
                        .subarray(0, Math.min(32, aesCfbExtIv.length))
                        .toString("hex"),
                    startCodeHits: startCodeHits(aesCfbExtIv),
                    magicFirstOffsets: magicFirstOffsets(aesCfbExtIv),
                },
                aesCtrExtIv: {
                    headHex: aesCtrExtIv
                        .subarray(0, Math.min(32, aesCtrExtIv.length))
                        .toString("hex"),
                    startCodeHits: startCodeHits(aesCtrExtIv),
                    magicFirstOffsets: magicFirstOffsets(aesCtrExtIv),
                },
                ...(aesCbcExtIv
                    ? {
                        aesCbcExtIv: {
                            headHex: aesCbcExtIv
                                .subarray(0, Math.min(32, aesCbcExtIv.length))
                                .toString("hex"),
                            startCodeHits: startCodeHits(aesCbcExtIv),
                            magicFirstOffsets: magicFirstOffsets(aesCbcExtIv),
                        },
                    }
                    : {}),
            }
            : {}),
    };

    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main();
