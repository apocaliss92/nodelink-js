#!/usr/bin/env node
/**
 * Replays cmdId=3 frames dumped by fullTest/pcap/test-pcap-baichuan-analyze.ts
 * through the runtime BaichuanVideoStream pipeline, producing Annex-B and MP4.
 *
 * Usage:
 *   # 1) Produce dumps (example)
 *   PCAP_DUMP_CMDIDS=3 PCAP_DUMP_CMD_LIMIT=5000 PCAP_DUMP_WRITE_FILES=1 \
 *     PCAP_DUMP_WRITE_DIR=pcap/reports/dump_cmd3_zoomed \
 *     node dist/fullTest/pcap/test-pcap-baichuan-analyze.js 'pcap/hub pc zoomed in main.pcapng'
 *
 *   # 2) Replay dumps to MP4
 *   node tools/pcap/replay-dump-cmd3-to-mp4.mjs \
 *     --dump-dir pcap/reports/dump_cmd3_zoomed \
 *     --nonce '69627476-G9PUMx1vtzcnXdWzNudI' \
 *     --out-base pcap/reports/zoomed_cmd3
 */

import "dotenv/config";

import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
    BaichuanVideoStream,
    BC_MAGIC,
    aesDecrypt,
    bcDecrypt,
    deriveAesKey,
} from "../../dist/index.js";

function nowStamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArgs(argv) {
    const args = [...argv];
    const out = {
        dumpDir: "",
        nonce: "",
        outBase: `pcap/reports/cmd3_${nowStamp()}`,
        password: "",
        jpegPath: null,
    };

    while (args.length) {
        const a = args.shift();
        if (!a) break;
        if (a === "--dump-dir") out.dumpDir = String(args.shift() ?? "");
        else if (a === "--nonce") out.nonce = String(args.shift() ?? "");
        else if (a === "--out-base") out.outBase = String(args.shift() ?? out.outBase);
        else if (a === "--password") out.password = String(args.shift() ?? "");
        else if (a === "--jpeg") {
            const peek = args[0];
            if (peek && !String(peek).startsWith("--")) out.jpegPath = String(args.shift());
            else out.jpegPath = true;
        }
    }

    if (!out.dumpDir) throw new Error("Missing --dump-dir");
    if (!out.nonce) throw new Error("Missing --nonce");
    if (!out.password) {
        out.password =
            (process.env.BAICHUAN_PASSWORD ?? "").trim() ||
            (process.env.TCP_PASSWORD ?? "").trim() ||
            (process.env.NVR_PASSWORD ?? "").trim();
    }
    if (!out.password) throw new Error("Missing --password (and no password in env)");

    if (out.jpegPath === true) {
        out.jpegPath = `${out.outBase}.preview-I.jpg`;
    }

    return out;
}

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}

function extractIndexFromFilename(file) {
    const m = /\.i(\d+)\.meta\.json$/.exec(file);
    return m ? Number(m[1]) : Number.NaN;
}

function deriveFpsFromUs(aus) {
    let minUs = null;
    let maxUs = null;
    for (const a of aus) {
        const us = a.microseconds;
        if (typeof us !== "number") continue;
        if (minUs == null || us < minUs) minUs = us;
        if (maxUs == null || us > maxUs) maxUs = us;
    }
    if (minUs == null || maxUs == null || maxUs <= minUs || aus.length <= 1) return null;
    const spanSec = (maxUs - minUs) / 1_000_000;
    if (spanSec <= 0) return null;
    return (aus.length - 1) / spanSec;
}

class FakeClient extends EventEmitter {
    constructor(enc) {
        super();
        this.enc = enc;
    }

    getDebugConfig() {
        return {
            general: false,
            debugRtsp: false,
            traceNativeStream: false,
            dumpEnabled: false,
            dumpDir: "",
            dumpBcMedia: false,
            dumpNals: false,
        };
    }

    getTransport() {
        return "tcp";
    }

    tryDecryptBinary(buf, channelId, enc) {
        if (!enc || enc.kind === "none") return buf;
        if (enc.kind === "bc") return bcDecrypt(buf, channelId);
        // aes/full_aes
        return aesDecrypt(buf, enc.key);
    }
}

async function main() {
    const { dumpDir, nonce, outBase, password, jpegPath } = parseArgs(process.argv.slice(2));

    const absDumpDir = path.isAbsolute(dumpDir) ? dumpDir : path.resolve(process.cwd(), dumpDir);
    if (!fs.existsSync(absDumpDir)) throw new Error(`Dump dir not found: ${absDumpDir}`);

    const metaFiles = fs.readdirSync(absDumpDir).filter((f) => f.endsWith(".meta.json"));
    if (metaFiles.length === 0) throw new Error(`No .meta.json found in ${absDumpDir}`);

    // Group frames by meta.label, then pick the largest group.
    const byLabel = new Map();
    for (const f of metaFiles) {
        const metaPath = path.join(absDumpDir, f);
        const meta = readJson(metaPath);
        if ((meta?.header?.cmdId ?? 0) !== 3) continue;
        // For native stream, we want the server->client responses.
        if ((meta?.header?.responseCode ?? 0) !== 200) continue;

        const label = String(meta?.label ?? "");
        if (!label) continue;
        const idx = extractIndexFromFilename(f);
        if (!Number.isFinite(idx)) continue;

        const list = byLabel.get(label) ?? [];
        list.push({ idx, base: metaPath.replace(/\.meta\.json$/, ""), meta });
        byLabel.set(label, list);
    }

    if (byLabel.size === 0) {
        throw new Error(`No cmdId=3 rc=200 frames found in ${absDumpDir}`);
    }

    const best = [...byLabel.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const [label, frames] = best;
    frames.sort((a, b) => a.idx - b.idx);

    const key = deriveAesKey(nonce, password);
    const client = new FakeClient({ kind: "full_aes", key });
    const stream = new BaichuanVideoStream({
        client,
        api: undefined,
        channel: 0,
        profile: "main",
        variant: "default",
        cmdId: 3,
        acceptAnyStreamType: true,
    });

    const aus = [];
    let firstVideoType = null;
    let keyframes = 0;

    stream.on("videoAccessUnit", ({ data, isKeyframe, videoType, microseconds }) => {
        if (!firstVideoType) firstVideoType = videoType;
        aus.push({ data, microseconds: microseconds ?? null });
        if (isKeyframe) keyframes++;
    });

    await stream.start();

    for (const item of frames) {
        const body = fs.readFileSync(`${item.base}.body.bin`);
        const extension = fs.readFileSync(`${item.base}.extension.bin`);
        const payload = fs.readFileSync(`${item.base}.payload.bin`);

        const channelId = item.meta.header.channelId;
        const streamType = item.meta.header.streamType;
        const msgNum = item.meta.header.msgNum;
        const messageKey =
            (channelId & 0xff) | ((streamType & 0xff) << 8) | ((msgNum & 0xffff) << 16);

        const mc = item.meta.header.messageClass;
        const messageClass =
            typeof mc === "number"
                ? mc
                : Number.parseInt(String(mc ?? "0"), 16) || 0;

        client.emit("push", {
            header: {
                magic: BC_MAGIC,
                cmdId: item.meta.header.cmdId,
                bodyLen: item.meta.header.bodyLen,
                channelId,
                streamType,
                msgNum,
                responseCode: item.meta.header.responseCode,
                messageClass,
                payloadOffset: item.meta.header.payloadOffset ?? 0,
            },
            body,
            extension,
            payload,
            messageKey,
            raw: body,
        });
    }

    await stream.stop();

    if (aus.length === 0) {
        throw new Error(`No videoAccessUnit emitted (label=${label}, frames=${frames.length})`);
    }

    ensureDir(path.dirname(outBase));

    const vt = String(firstVideoType || "H264").toUpperCase();
    const demux = vt.includes("265") ? "hevc" : "h264";
    const ext = demux === "hevc" ? ".h265" : ".h264";
    const outAnnex = `${outBase}${ext}`;

    // Help ffmpeg with AU boundaries for H.264 by inserting AUD.
    const H264_AUD = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0xf0]);
    const wantAud = demux === "h264";
    const allData = Buffer.concat(
        aus.flatMap((c) => {
            if (!c?.data) return [];
            return wantAud ? [H264_AUD, c.data] : [c.data];
        }),
    );

    fs.writeFileSync(outAnnex, allData);

    const derivedFps = deriveFpsFromUs(aus);
    const inputFps = derivedFps && Number.isFinite(derivedFps) && derivedFps > 0 ? derivedFps : 25;
    const inputFpsStr = Number.isFinite(inputFps) ? inputFps.toFixed(3) : "25";

    const mp4Path = `${outBase}.mp4`;
    execSync(
        `ffmpeg -y -loglevel warning -fflags +genpts -r ${inputFpsStr} -f ${demux} -i "${outAnnex}" -c copy "${mp4Path}" 2>&1`,
        { stdio: "inherit" },
    );

    let jpegOut = null;
    if (jpegPath) {
        jpegOut = path.isAbsolute(jpegPath)
            ? jpegPath
            : path.resolve(process.cwd(), jpegPath);
        ensureDir(path.dirname(jpegOut));
        // Extract first I-frame (fallback: first frame if no I-frames found)
        try {
            execSync(
                `ffmpeg -y -loglevel warning -i "${mp4Path}" -vf "select=eq(pict_type\\,I)" -frames:v 1 -update 1 "${jpegOut}" 2>&1`,
                { stdio: "inherit" },
            );
        } catch {
            execSync(
                `ffmpeg -y -loglevel warning -i "${mp4Path}" -frames:v 1 -update 1 "${jpegOut}" 2>&1`,
                { stdio: "inherit" },
            );
        }
    }

    console.log(
        JSON.stringify(
            {
                label,
                frames: frames.length,
                accessUnits: aus.length,
                keyframes,
                videoType: vt,
                outAnnex,
                mp4Path,
                fps: inputFps,
                jpegPath: jpegOut,
            },
            null,
            2,
        ),
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
