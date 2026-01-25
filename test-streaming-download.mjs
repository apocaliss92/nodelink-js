#!/usr/bin/env node
/**
 * Test download via streaming replay (BaichuanVideoStream).
 * Uses startRecordingReplayStream which pushes frames via cmdId=5.
 */

import "dotenv/config";
import { ReolinkBaichuanApi, createLogger } from "./dist/index.js";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const logger = createLogger({ name: "streaming-test", level: "debug" });

const E1_OUTDOOR = {
    host: process.env.E1_HOST || "192.168.1.170",
    username: process.env.TCP_USERNAME || "admin",
    password: process.env.TCP_PASSWORD || "",
    name: "E1 Outdoor PoE"
};

const TRACKMIX = {
    host: process.env.TRACKMIX_HOST || "192.168.50.226",
    username: process.env.TCP_USERNAME || "admin",
    password: process.env.TCP_PASSWORD || "",
    name: "TrackMix PoE"
};

const NVR = {
    host: process.env.NVR_HOST || "192.168.1.161",
    username: process.env.TCP_USERNAME || "admin",
    password: process.env.TCP_PASSWORD || "",
    name: "NVR"
};

const OUT_DIR = "./test/artifacts";

async function runFfmpeg(inputPath, outputPath, inputType = "h264", fps = 25) {
    return new Promise((resolve, reject) => {
        const args = [
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-fflags", "+genpts",
            "-r", String(fps),
            "-f", inputType,
            "-i", inputPath,
            "-c", "copy",
            "-movflags", "+faststart",
            "-f", "mp4",
            outputPath
        ];

        if (inputType === "hevc") {
            args.splice(args.indexOf("-f", args.indexOf("-i")), 0, "-tag:v", "hvc1");
        }

        const p = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
        const t = setTimeout(() => p.kill("SIGKILL"), 60000);
        p.on("error", reject);
        p.on("close", (code) => {
            clearTimeout(t);
            code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`));
        });
    });
}

async function extractFirstFrame(mp4Path, jpegPath) {
    return new Promise((resolve, reject) => {
        const args = [
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-i", mp4Path,
            "-vframes", "1",
            "-f", "image2",
            jpegPath
        ];

        const p = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
        const t = setTimeout(() => p.kill("SIGKILL"), 30000);
        p.on("error", reject);
        p.on("close", (code) => {
            clearTimeout(t);
            code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`));
        });
    });
}

async function testStreamingDownload(device, channel, fileName, outputPrefix) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Testing STREAMING download: ${device.name} ch${channel}`);
    console.log(`File: ${fileName}`);
    console.log(`${"=".repeat(60)}`);

    const api = new ReolinkBaichuanApi({
        host: device.host,
        username: device.username,
        password: device.password,
        logger
    });

    await mkdir(OUT_DIR, { recursive: true });

    try {
        console.log("Starting replay stream...");

        const { stream, stop } = await api.startRecordingReplayStream({
            channel,
            fileName,
            streamType: "mainStream",
            timeoutMs: 30_000
        });

        const frames = [];
        let videoType = "H264";
        let frameCount = 0;
        let iframeCount = 0;
        const startTime = Date.now();
        const maxDurationMs = 60_000; // Max 60 seconds

        return new Promise(async (resolve, reject) => {
            const timeout = setTimeout(async () => {
                console.log("Timeout reached, stopping stream...");
                try { await stop(); } catch { }
                finalize();
            }, maxDurationMs);

            let lastFrameTime = Date.now();
            const idleCheck = setInterval(() => {
                if (Date.now() - lastFrameTime > 10_000) {
                    console.log("Idle timeout (10s no frames), stopping...");
                    clearInterval(idleCheck);
                    try { stop().catch(() => { }); } catch { }
                }
            }, 1000);

            stream.on("videoAccessUnit", ({ data, isKeyframe, videoType: vt }) => {
                lastFrameTime = Date.now();
                frames.push(data);
                frameCount++;
                if (isKeyframe) {
                    iframeCount++;
                    videoType = vt;
                }
                if (frameCount % 50 === 0) {
                    const elapsed = (Date.now() - startTime) / 1000;
                    console.log(`Received ${frameCount} frames (${iframeCount} I-frames), ${elapsed.toFixed(1)}s elapsed, ${(Buffer.concat(frames).length / 1024 / 1024).toFixed(2)} MB`);
                }
            });

            stream.on("close", () => {
                console.log("Stream closed");
                clearTimeout(timeout);
                clearInterval(idleCheck);
                finalize();
            });

            stream.on("error", (err) => {
                console.error("Stream error:", err.message);
                clearTimeout(timeout);
                clearInterval(idleCheck);
                finalize();
            });

            async function finalize() {
                const elapsed = (Date.now() - startTime) / 1000;
                console.log(`\nStream ended after ${elapsed.toFixed(1)}s`);
                console.log(`Total frames: ${frameCount} (${iframeCount} I-frames)`);

                if (frames.length === 0) {
                    console.error("❌ No frames received!");
                    try { await api.close(); } catch { }
                    reject(new Error("No frames received"));
                    return;
                }

                const annexB = Buffer.concat(frames);
                console.log(`Total video data: ${(annexB.length / 1024 / 1024).toFixed(2)} MB`);

                // Save raw h264/hevc
                const rawExt = videoType === "H265" ? "hevc" : "h264";
                const rawPath = `${OUT_DIR}/${outputPrefix}.${rawExt}`;
                await writeFile(rawPath, annexB);
                console.log(`Saved raw video: ${rawPath}`);

                // Convert to MP4
                const mp4Path = `${OUT_DIR}/${outputPrefix}.mp4`;
                try {
                    await runFfmpeg(rawPath, mp4Path, videoType === "H265" ? "hevc" : "h264");
                    console.log(`✅ Created MP4: ${mp4Path}`);

                    // Extract JPEG
                    const jpegPath = `${OUT_DIR}/${outputPrefix}.jpg`;
                    await extractFirstFrame(mp4Path, jpegPath);
                    console.log(`✅ Created JPEG: ${jpegPath}`);
                } catch (err) {
                    console.error("❌ ffmpeg failed:", err.message);
                }

                try { await api.close(); } catch { }
                resolve({ frameCount, iframeCount, bytes: annexB.length, elapsed });
            }
        });

    } catch (err) {
        console.error(`❌ Error: ${err.message}`);
        try { await api.close(); } catch { }
        throw err;
    }
}

async function findRecording(api, channel, targetDate) {
    // targetDate format: "YYYY-MM-DD"
    const [year, month, day] = targetDate.split("-").map(Number);

    console.log(`Searching recordings for ${targetDate} ch${channel}...`);

    try {
        const recordings = await api.getVideoclips({
            channel,
            start: new Date(year, month - 1, day, 0, 0, 0),
            end: new Date(year, month - 1, day, 23, 59, 59),
            streamType: "mainStream"
        });

        if (recordings.length === 0) {
            console.log("No recordings found");
            return null;
        }

        console.log(`Found ${recordings.length} recordings`);
        // Return first one with fileName
        const rec = recordings.find(r => r.fileName || r.name || r.id);
        if (rec) {
            console.log(`Using: ${rec.fileName || rec.name || rec.id}`);
        }
        return rec;
    } catch (err) {
        console.error(`Failed to get recordings: ${err.message}`);
        return null;
    }
}

async function main() {
    console.log("=".repeat(60));
    console.log("STREAMING DOWNLOAD TEST");
    console.log("Using startRecordingReplayStream (BaichuanVideoStream)");
    console.log("=".repeat(60));

    const results = [];

    // Test E1 Outdoor - 22 gennaio
    try {
        const api = new ReolinkBaichuanApi({
            host: E1_OUTDOOR.host,
            username: E1_OUTDOOR.username,
            password: E1_OUTDOOR.password,
            logger
        });

        const rec = await findRecording(api, 0, "2026-01-22");
        await api.close();

        if (rec) {
            const result = await testStreamingDownload(
                E1_OUTDOOR, 0, rec.fileName,
                "streaming_e1outdoor_ch0"
            );
            results.push({ device: E1_OUTDOOR.name, channel: 0, ...result, status: "OK" });
        } else {
            results.push({ device: E1_OUTDOOR.name, channel: 0, status: "NO_RECORDINGS" });
        }
    } catch (err) {
        results.push({ device: E1_OUTDOOR.name, channel: 0, status: "ERROR", error: err.message });
    }

    // Test TrackMix
    try {
        const api = new ReolinkBaichuanApi({
            host: TRACKMIX.host,
            username: TRACKMIX.username,
            password: TRACKMIX.password,
            logger
        });

        const rec = await findRecording(api, 0, "2026-01-22");
        await api.close();

        if (rec) {
            const result = await testStreamingDownload(
                TRACKMIX, 0, rec.fileName,
                "streaming_trackmix_ch0"
            );
            results.push({ device: TRACKMIX.name, channel: 0, ...result, status: "OK" });
        } else {
            results.push({ device: TRACKMIX.name, channel: 0, status: "NO_RECORDINGS" });
        }
    } catch (err) {
        results.push({ device: TRACKMIX.name, channel: 0, status: "ERROR", error: err.message });
    }

    // Test NVR channel 2 - 16 gennaio
    try {
        const api = new ReolinkBaichuanApi({
            host: NVR.host,
            username: NVR.username,
            password: NVR.password,
            logger
        });

        const rec = await findRecording(api, 2, "2026-01-16");
        await api.close();

        if (rec) {
            const result = await testStreamingDownload(
                NVR, 2, rec.fileName,
                "streaming_nvr_ch2"
            );
            results.push({ device: NVR.name, channel: 2, ...result, status: "OK" });
        } else {
            results.push({ device: NVR.name, channel: 2, status: "NO_RECORDINGS" });
        }
    } catch (err) {
        results.push({ device: NVR.name, channel: 2, status: "ERROR", error: err.message });
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("RESULTS SUMMARY");
    console.log("=".repeat(60));
    for (const r of results) {
        const status = r.status === "OK" ? "✅" : "❌";
        const info = r.status === "OK"
            ? `${r.frameCount} frames, ${r.iframeCount} I-frames, ${(r.bytes / 1024 / 1024).toFixed(2)} MB, ${r.elapsed?.toFixed(1)}s`
            : r.error || r.status;
        console.log(`${status} ${r.device} ch${r.channel}: ${info}`);
    }
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
