#!/usr/bin/env node
/**
 * Stream a recording replay (cmdId=5) over Baichuan TCP and save a playable MP4.
 *
 * Notes:
 * - The replay stream provides raw Annex-B access units (H264 or H265) without container timestamps.
 * - We mux to MP4 via ffmpeg by assuming an input framerate (default: 25). Adjust --fps if needed.
 *
 * Requires:
 * - npm run build (this script imports ./dist)
 * - ffmpeg + ffprobe in PATH
 *
 * Env:
 *   Prefer NVR_*; fallback TCP_*.
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
Replay a past clip over Baichuan TCP (cmdId=5) and save MP4.

Requires:
  - npm run build (this script imports ./dist)
  - ffmpeg + ffprobe in PATH

Env (prefer NVR_*, fallback TCP_*):
  NVR_HOST, NVR_USERNAME, NVR_PASSWORD
  TCP_HOST, TCP_USERNAME, TCP_PASSWORD
  Optional (helps mapping event ids -> /mnt paths): TCP_UID or NVR_UID

Examples:
  npm run util:replay:mp4 -- --file "/mnt/sda/Mp4Record/.../Rec....mp4" --seconds 30 --out ./.tmp/replay.mp4
  npm run util:replay:mp4 -- --channel 0 --minutes 180 --event-index 0 --seconds 20 --out ./.tmp/replay.mp4

Options:
  --channel <n>         Channel (default 0)
  --stream <main|sub>   Stream type (default main)
  --minutes <n>         Lookback window for event auto-pick (default 60)
  --event-index <n>     Index in sorted events (0 = newest)
  --file <path|id>      Recording identifier/path (best: /mnt/...mp4). If omitted, auto-picks newest event.
  --seconds <n>         Capture duration before stopping replay (default 20)
  --fps <n>             Assumed input FPS for muxing (default 25)
  --out <path>          Output MP4 path
  --help                Show this help
`);
}

function mustNum(v, name) {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) throw new Error(`Invalid ${name}: ${v}`);
    return n;
}

function clampLookbackMinutes(rawMinutes) {
    const n = Number(rawMinutes);
    if (!Number.isFinite(n) || n <= 0) return 60;
    // Many devices reject multi-day windows for Baichuan event/recording listings.
    // Keep the query at <= 1 day for reliability.
    return Math.min(n, 24 * 60);
}

async function ffprobeJson(filePath) {
    return new Promise((resolveP, rejectP) => {
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
                    resolveP(JSON.parse(stdout));
                } catch (e) {
                    rejectP(
                        new Error(
                            `ffprobe JSON parse failed: ${e instanceof Error ? e.message : String(e)}\nraw=${stdout.slice(0, 5000)}`,
                        ),
                    );
                }
                return;
            }
            rejectP(new Error(`ffprobe exited with code ${code}: ${stderr}`));
        });

        p.on("error", rejectP);
    });
}

async function pickFileNameFromEvents({ api, channel, streamType, minutes, eventIndex }) {
    const end = new Date();
    const start = new Date(end.getTime() - clampLookbackMinutes(minutes) * 60 * 1000);

    console.log(`[replay] Listing events: ch=${channel} start=${start.toISOString()} end=${end.toISOString()}...`);
    const events = await api.listNvrAlarmEventsEnrichedViaBaichuan({
        start,
        end,
        channels: [channel],
        streamType,
        maxIterations: 50,
    });

    if (!events.length) throw new Error("No events found in the requested window.");

    const sorted = events
        .slice()
        .sort((a, b) => (b.startTimeMs ?? 0) - (a.startTimeMs ?? 0));

    const ev = sorted[eventIndex];
    if (!ev) throw new Error(`event-index out of range. Have ${sorted.length} events.`);

    console.log(`[replay] Picked event #${eventIndex}/${sorted.length - 1}:`);
    console.log(
        JSON.stringify(
            {
                channel: ev.channel,
                fileName: ev.fileName,
                startTimeMs: ev.startTimeMs,
                endTimeMs: ev.endTimeMs,
                recordType: ev.recordType,
                detectionClasses: ev.detectionClasses,
                durationMs: ev.durationMs,
            },
            null,
            2,
        ),
    );

    return String(ev.fileName || "").trim();
}

async function pickFileNameFromNvrRecordings({ api, channel, streamType }) {
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

    console.log("[replay] Trying NVR recordings list (1 day window, may fall back to CGI)...");

    const recs = await api.listNvrRecordings({
        channel,
        start,
        end,
        streamType: streamType === "subStream" ? "sub" : "main",
        source: "baichuan",
        // keep it snappy; this path may hit CGI too
        timeoutMs: 15000,
    });

    if (!recs?.length) throw new Error("No NVR recordings found in 1 day window.");
    const last = recs.at(-1);

    const fileName = String(last?.id || last?.fileName || "").trim();
    if (!fileName) throw new Error("NVR recordings list returned an empty identifier.");

    console.log("[replay] Picked latest NVR recording:");
    console.log(
        JSON.stringify(
            {
                fileName,
                startTimeMs: last?.startTimeMs,
                endTimeMs: last?.endTimeMs,
                recordType: last?.recordType,
                detectionClasses: last?.detectionClasses,
                durationMs: last?.durationMs,
            },
            null,
            2,
        ),
    );

    return fileName;
}

async function pickFileNameFromRecordings({ api, channel, streamType }) {
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

    console.log("[replay] Falling back to device recordings list (1 day window)...");

    const recs = await api.listDeviceRecordings({
        channel,
        start,
        end,
        streamType,
        count: 200,
        timeoutMs: 15000,
    });

    if (!recs?.length) throw new Error("No recordings found in fallback window.");
    const last = recs.at(-1);
    const fileName = String(last?.fileName ?? "").trim();
    if (!fileName) throw new Error("Fallback recordings list returned an empty fileName.");

    console.log("[replay] Picked latest recording:");
    console.log(
        JSON.stringify(
            {
                fileName,
                startTimeMs: last?.startTimeMs,
                endTimeMs: last?.endTimeMs,
                recordType: last?.recordType,
                detectionClasses: last?.detectionClasses,
                durationMs: last?.durationMs,
            },
            null,
            2,
        ),
    );

    return fileName;
}

async function resolveReplayFileToMntPath({ api, channel, streamType, fileName }) {
    if (!fileName) return "";
    const raw = String(fileName).trim();
    if (!raw) return "";
    if (raw.startsWith("/")) return raw;

    // cmdId=5 replay often expects a VOD identifier like /mnt/...mp4.
    // When we only have an event-like id (e.g. 01YYYYMMDDHHMMSS...), try to map it.
    const uid = (process.env.NVR_UID ?? process.env.TCP_UID ?? "").trim() || undefined;

    try {
        console.log(`[replay] Non-/mnt identifier detected (${raw}); attempting to map via FileInfoList...`);
        const lookbackDaysRaw = Number.parseInt((process.env.REPLAY_LOOKBACK_DAYS ?? "7").trim(), 10);
        const lookbackDays = Number.isFinite(lookbackDaysRaw) && lookbackDaysRaw > 0 ? lookbackDaysRaw : 7;
        const end = new Date();
        const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

        const vod = await api.listRecordings({
            channel,
            ...(uid ? { uid } : {}),
            start,
            end,
            streamType,
        });

        const candidates = (vod ?? [])
            .map((r) => String(r?.id || r?.fileName || "").trim())
            .filter((s) => s);

        const mapped = candidates.find((s) => s.includes(raw) && s.startsWith("/")) ?? candidates.find((s) => s.startsWith("/"));

        if (mapped) {
            console.log(`[replay] Mapped to: ${mapped}`);
            return mapped;
        }
    } catch (e) {
        console.warn(`[replay] FileInfoList mapping failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Weak fallback; some devices store recordings under /mnt/sda/...
    const guess = `/mnt/sda/${raw.replace(/^\/+/, "")}`;
    console.warn(`[replay] Could not map via FileInfoList; trying guess: ${guess}`);
    return guess;
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
    const seconds = args.seconds != null ? mustNum(args.seconds, "seconds") : 20;
    const fps = args.fps != null ? mustNum(args.fps, "fps") : 25;

    const outPath = resolve(String(args.out ?? `./.tmp/replay_${Date.now()}.mp4`));
    await mkdir(dirname(outPath), { recursive: true });

    const api = new ReolinkBaichuanApi({
        host,
        username,
        password,
        transport: "tcp",
        debug: true,
    });

    let fileName = args.file ? String(args.file) : "";

    try {
        await api.login();

        if (!fileName) {
            const minutes = args.minutes != null ? mustNum(args.minutes, "minutes") : 60;
            const eventIndex = args["event-index"] != null ? mustNum(args["event-index"], "event-index") : 0;
            try {
                fileName = await pickFileNameFromEvents({ api, channel, streamType, minutes, eventIndex });
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.includes("No events found")) {
                    try {
                        fileName = await pickFileNameFromNvrRecordings({ api, channel, streamType });
                    } catch {
                        fileName = await pickFileNameFromRecordings({ api, channel, streamType });
                    }
                } else {
                    throw e;
                }
            }
        }

        const replayFile = await resolveReplayFileToMntPath({ api, channel, streamType, fileName });
        if (!replayFile) throw new Error("Could not resolve replay file identifier.");

        console.log("\n=== REPLAY -> MP4 (cmdId=5) ===");
        console.log("host:", host);
        console.log("file:", replayFile);
        console.log("stream:", streamType);
        console.log("seconds:", seconds);
        console.log("fps:", fps);
        console.log("out:", outPath);

        const { stream, stop, msgNum } = await api.startRecordingReplayStream({
            channel,
            fileName: replayFile,
            streamType,
        });

        console.log("msgNum:", msgNum);

        let videoAUs = 0;
        let keyframes = 0;
        let totalBytes = 0;

        /** @type {{ data: Buffer, isKeyframe: boolean, videoType: 'H264'|'H265', microseconds?: number } | null} */
        let firstAu = null;

        const firstAuPromise = new Promise((resolveP, rejectP) => {
            const t = setTimeout(() => rejectP(new Error("Timeout waiting for first videoAccessUnit")), 15000);
            stream.once("videoAccessUnit", (au) => {
                clearTimeout(t);
                firstAu = au;
                resolveP(au);
            });
            stream.once("error", (e) => {
                clearTimeout(t);
                rejectP(e);
            });
        });

        // Accumulate until ffmpeg is ready (backpressure-safe once piping starts).
        const pending = [];
        let ffmpeg = null;
        let draining = false;

        const flushPending = async () => {
            if (!ffmpeg) return;
            if (draining) return;
            while (pending.length) {
                const buf = pending[0];
                const ok = ffmpeg.stdin.write(buf);
                pending.shift();
                if (!ok) {
                    draining = true;
                    await new Promise((resolveP) => ffmpeg.stdin.once("drain", resolveP));
                    draining = false;
                }
            }
        };

        stream.on("videoAccessUnit", (au) => {
            videoAUs++;
            totalBytes += au.data.length;
            if (au.isKeyframe) keyframes++;

            if (videoAUs <= 3 || videoAUs % 60 === 0) {
                console.log(`videoAccessUnit #${videoAUs} keyframes=${keyframes} type=${au.videoType} len=${au.data.length}`);
            }

            if (!ffmpeg) {
                pending.push(au.data);
                return;
            }

            const ok = ffmpeg.stdin.write(au.data);
            if (!ok && !draining) {
                draining = true;
                ffmpeg.stdin.once("drain", () => {
                    draining = false;
                });
            }
        });

        stream.on("error", (e) => {
            console.error("stream error:", e);
        });

        const au0 = await firstAuPromise;
        const inputFormat = au0.videoType === "H265" ? "hevc" : "h264";

        console.log(`[replay] Starting ffmpeg mux (input=${inputFormat}, fps=${fps})...`);

        ffmpeg = spawn("ffmpeg", [
            "-hide_banner",
            "-loglevel",
            "error",
            "-fflags",
            "+genpts",
            "-f",
            inputFormat,
            "-framerate",
            String(fps),
            "-i",
            "pipe:0",
            "-an",
            "-c:v",
            "copy",
            "-movflags",
            "+faststart",
            outPath,
        ]);

        ffmpeg.on("error", (e) => {
            console.error("ffmpeg spawn error:", e);
        });

        let ffmpegStderr = "";
        ffmpeg.stderr.on("data", (d) => {
            const s = String(d);
            ffmpegStderr += s;
            if (ffmpegStderr.length > 8000) ffmpegStderr = ffmpegStderr.slice(-8000);
        });

        // Write whatever arrived before ffmpeg spawn.
        await flushPending();

        const stopTimer = setTimeout(() => {
            console.log("\nStopping replay...");
            stop().catch((e) => console.error("stop() failed:", e));
        }, seconds * 1000);

        // Wait for stop to complete by watching stream close-ish via a guard timer.
        await new Promise((resolveP) => setTimeout(resolveP, seconds * 1000 + 1500));
        clearTimeout(stopTimer);

        // End muxer input and wait for ffmpeg to finish.
        if (ffmpeg && !ffmpeg.killed) {
            ffmpeg.stdin.end();
            const code = await new Promise((resolveP) => ffmpeg.once("close", resolveP));
            if (code !== 0) {
                throw new Error(`ffmpeg exited with code ${code}: ${ffmpegStderr}`);
            }
        }

        await api.close();

        console.log(`[replay] Done. videoAUs=${videoAUs} keyframes=${keyframes} bytes=${totalBytes}`);
        console.log(`[replay] Probing MP4 with ffprobe...`);

        const info = await ffprobeJson(outPath);
        const videoStream = (info.streams ?? []).find((s) => s.codec_type === "video");

        console.log(
            JSON.stringify(
                {
                    outPath,
                    format: info.format?.format_name,
                    duration: info.format?.duration,
                    size: info.format?.size,
                    video: videoStream
                        ? {
                            codec: videoStream.codec_name,
                            width: videoStream.width,
                            height: videoStream.height,
                            avg_frame_rate: videoStream.avg_frame_rate,
                        }
                        : null,
                },
                null,
                2,
            ),
        );
    } finally {
        try {
            await api.close();
        } catch {
            // ignore
        }
    }
}

main().catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
});
