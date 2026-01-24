#!/usr/bin/env node
/**
 * Stream a clip (past recording) and save a playable MP4.
 *
 * Strategy: use RTMP VOD playback ("streaming" the clip) and remux to MP4 via ffmpeg copy.
 * This is the fastest path to a working MP4 while we continue reverse-engineering
 * socket-only cmdId=5/7 replay.
 *
 * Usage:
 *   npm run build && node tools/stream-clip-to-mp4.mjs --channel 0 --minutes 60 --event-index 0 --out out.mp4
 *   npm run build && node tools/stream-clip-to-mp4.mjs --file "/mnt/sda/Mp4Record/.../Rec....mp4" --channel 0 --out out.mp4
 *
 * Env:
 *   Prefer NVR_*; fallback to TCP_*.
 */
import { ReolinkBaichuanApi } from "../dist/index.js";
import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a) continue;
        if (!a.startsWith("--")) {
            out._.push(a);
            continue;
        }
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next != null && !next.startsWith("--")) {
            out[key] = next;
            i++;
        } else {
            out[key] = true;
        }
    }
    return out;
}

function printHelp() {
    console.log(`\
Stream a past clip and save a playable MP4 (RTMP VOD -> ffmpeg remux).

Requires:
  - npm run build (this script imports ./dist)
  - ffmpeg + ffprobe in PATH

Env (prefer NVR_*, fallback TCP_*):
  NVR_HOST, NVR_USERNAME, NVR_PASSWORD
  TCP_HOST, TCP_USERNAME, TCP_PASSWORD

Examples:
  npm run util:clip:mp4 -- --channel 0 --minutes 180 --event-index 0 --out ./.tmp/clip.mp4
  npm run util:clip:mp4 -- --file "/mnt/sda/Mp4Record/.../Rec....mp4" --channel 0 --out ./.tmp/clip.mp4

Options:
  --channel <n>         Channel (default 0)
  --stream <main|sub>   Stream type (default main)
  --minutes <n>         Lookback window when choosing an event (default 60)
  --event-index <n>     Index in sorted events (0 = newest)
  --file <path>         Recording identifier/path to stream directly
  --out <path>          Output MP4 path
  --ensure-awake        Best-effort wake battery cams before transfer
  --help                Show this help
`);
}

function mustNum(v, name) {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) throw new Error(`Invalid ${name}: ${v}`);
    return n;
}

async function ffprobeJson(filePath) {
    return new Promise((resolve, reject) => {
        const p = spawn("ffprobe", [
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            filePath,
        ]);

        let stdout = "";
        let stderr = "";

        p.stdout.on("data", (d) => (stdout += String(d)));
        p.stderr.on("data", (d) => (stderr += String(d)));

        p.on("close", (code) => {
            if (code === 0) {
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    reject(new Error(`ffprobe JSON parse failed: ${e instanceof Error ? e.message : String(e)}\nraw=${stdout.slice(0, 5000)}`));
                }
                return;
            }
            reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
        });

        p.on("error", reject);
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help || args["h"] || args["--help"]) {
        printHelp();
        return;
    }

    const host = process.env.NVR_HOST ?? process.env.TCP_HOST;
    const username = process.env.NVR_USERNAME ?? process.env.TCP_USERNAME;
    const password = process.env.NVR_PASSWORD ?? process.env.TCP_PASSWORD;

    if (!host || !password) {
        console.error("Missing NVR_HOST/NVR_PASSWORD (or TCP_HOST/TCP_PASSWORD) in .env");
        process.exit(1);
    }

    const channel = args.channel != null ? mustNum(args.channel, "channel") : 0;
    const streamType = args.stream === "sub" ? "subStream" : "mainStream";
    const ensureAwake = !!args["ensure-awake"];

    const outPath = resolve(String(args.out ?? `./.tmp/clip_${Date.now()}.mp4`));
    await mkdir(dirname(outPath), { recursive: true });

    const api = new ReolinkBaichuanApi({
        host,
        username,
        password,
        transport: "tcp",
        debug: true,
    });

    let fileName = args.file ? String(args.file) : undefined;

    if (!fileName) {
        const minutes = args.minutes != null ? mustNum(args.minutes, "minutes") : 60;
        const end = new Date();
        const start = new Date(end.getTime() - minutes * 60 * 1000);

        const eventIndex = args["event-index"] != null ? mustNum(args["event-index"], "event-index") : 0;

        console.log(`[clip] Listing events: ch=${channel} start=${start.toISOString()} end=${end.toISOString()}...`);
        const events = await api.listNvrAlarmEventsEnrichedViaBaichuan({
            start,
            end,
            channels: [channel],
            streamType,
            maxIterations: 50,
        });

        if (!events.length) {
            throw new Error("No events found in the requested window.");
        }

        const sorted = events
            .slice()
            .sort((a, b) => (b.startTimeMs ?? 0) - (a.startTimeMs ?? 0));

        const ev = sorted[eventIndex];
        if (!ev) {
            throw new Error(`event-index out of range. Have ${sorted.length} events.`);
        }

        fileName = ev.fileName;

        console.log(`[clip] Picked event #${eventIndex}/${sorted.length - 1}:`);
        console.log(JSON.stringify({
            channel: ev.channel,
            fileName: ev.fileName,
            startTimeMs: ev.startTimeMs,
            endTimeMs: ev.endTimeMs,
            recordType: ev.recordType,
            detectionClasses: ev.detectionClasses,
            durationMs: ev.durationMs,
        }, null, 2));
    }

    console.log(`[clip] Streaming VOD -> MP4 (ffmpeg copy) ...`);
    console.log(`[clip] fileName=${fileName}`);
    console.log(`[clip] out=${outPath}`);

    await api.predownloadRecordingMp4({
        channel,
        fileName,
        outputPath: outPath,
        streamType,
        ensureAwake,
        overwrite: true,
    });

    console.log(`[clip] Done. Probing MP4 with ffprobe...`);
    const info = await ffprobeJson(outPath);

    const videoStream = (info.streams ?? []).find((s) => s.codec_type === "video");
    const audioStream = (info.streams ?? []).find((s) => s.codec_type === "audio");

    console.log(JSON.stringify({
        outPath,
        format: info.format?.format_name,
        duration: info.format?.duration,
        size: info.format?.size,
        video: videoStream ? {
            codec: videoStream.codec_name,
            width: videoStream.width,
            height: videoStream.height,
            avg_frame_rate: videoStream.avg_frame_rate,
        } : null,
        audio: audioStream ? {
            codec: audioStream.codec_name,
            sample_rate: audioStream.sample_rate,
            channels: audioStream.channels,
        } : null,
    }, null, 2));
}

main().catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
});
