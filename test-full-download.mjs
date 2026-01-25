#!/usr/bin/env node
/**
 * Full test suite per download recording.
 * - E1 Outdoor PoE (192.168.1.170) - data 22 gennaio
 * - TrackMix PoE (192.168.50.226) - data 22 gennaio
 * - NVR (192.168.1.161) channel 2 - data 16 gennaio
 * 
 * Output: MP4 e JPEG visualizzabili in test/artifacts/
 */

import "dotenv/config";
import { ReolinkBaichuanApi, createLogger } from "./dist/index.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";

const logger = createLogger({ name: "full-test", level: "info" });

const DEVICES = [
    {
        name: "E1_Outdoor_PoE",
        host: process.env.E1_HOST || "192.168.1.170",
        channel: 0,
        date: "2026-01-22"
    },
    {
        name: "TrackMix_PoE",
        host: process.env.TRACKMIX_HOST || "192.168.50.226",
        channel: 0,
        date: "2026-01-22"
    },
    {
        name: "NVR_ch2",
        host: process.env.NVR_HOST || "192.168.1.161",
        channel: 2,
        date: "2026-01-16"
    }
];

const USER = process.env.TCP_USERNAME || "admin";
const PASS = process.env.TCP_PASSWORD || "Ruocco123";
const OUT_DIR = "./test/artifacts";

// Detect video type from NAL header
function detectVideoType(buffer) {
    // Look for start code 00 00 00 01
    for (let i = 0; i < Math.min(buffer.length - 5, 1000); i++) {
        if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 0 && buffer[i + 3] === 1) {
            const nalByte = buffer[i + 4];
            // H.265/HEVC: NAL type is in bits 1-6 of first byte
            // VPS=32, SPS=33, PPS=34, IDR=19/20
            const hevcType = (nalByte >> 1) & 0x3F;
            if (hevcType >= 32 && hevcType <= 34) {
                return "H265";
            }
            // H.264: NAL type is in bits 0-4 of first byte
            const h264Type = nalByte & 0x1F;
            if (h264Type === 7 || h264Type === 8) { // SPS or PPS
                return "H264";
            }
        }
    }
    return "H264"; // default
}

async function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        p.stderr.on("data", d => stderr += d.toString());
        const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("ffmpeg timeout")); }, 120000);
        p.on("error", reject);
        p.on("close", code => {
            clearTimeout(t);
            code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
        });
    });
}

async function testDevice(device) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Testing: ${device.name} (${device.host}) ch${device.channel}`);
    console.log(`Date: ${device.date}`);
    console.log("=".repeat(60));

    const api = new ReolinkBaichuanApi({
        host: device.host,
        username: USER,
        password: PASS,
        logger
    });

    try {
        // Step 1: Get recordings
        const [year, month, day] = device.date.split("-").map(Number);
        console.log(`\n1. Searching recordings for ${device.date}...`);

        const recordings = await api.getVideoclips({
            channel: device.channel,
            start: new Date(year, month - 1, day, 0, 0, 0),
            end: new Date(year, month - 1, day, 23, 59, 59),
            streamType: "mainStream"
        });

        console.log(`   Found ${recordings.length} recordings`);

        if (recordings.length === 0) {
            console.log("   ❌ No recordings found!");
            return { device: device.name, status: "NO_RECORDINGS" };
        }

        // Pick first recording
        const rec = recordings[0];
        const fileName = rec.fileName || rec.name || rec.id;
        console.log(`   Selected: ${fileName}`);

        // Step 2: Download
        console.log(`\n2. Downloading...`);
        const startTime = Date.now();

        const { annexB, videoType: reportedType } = await api.downloadRecordingDemuxed({
            channel: device.channel,
            fileName: fileName,
            timeoutMs: 180_000
        });

        const dlTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`   Downloaded ${(annexB.length / 1024 / 1024).toFixed(2)} MB in ${dlTime}s`);
        console.log(`   Reported type: ${reportedType}`);

        // Step 3: Detect actual video type
        const actualType = detectVideoType(annexB);
        console.log(`   Detected type: ${actualType}`);

        // Step 4: Save raw video
        const ext = actualType === "H265" ? "hevc" : "h264";
        const rawPath = `${OUT_DIR}/${device.name}.${ext}`;
        writeFileSync(rawPath, annexB);
        console.log(`   Saved raw: ${rawPath}`);

        // Step 5: Convert to MP4
        console.log(`\n3. Converting to MP4...`);
        const mp4Path = `${OUT_DIR}/${device.name}.mp4`;

        const ffmpegArgs = [
            "-hide_banner", "-loglevel", "warning", "-y",
            "-fflags", "+genpts",
            "-r", "25",
            "-f", actualType === "H265" ? "hevc" : "h264",
            "-i", rawPath,
            "-c", "copy",
            "-movflags", "+faststart",
            ...(actualType === "H265" ? ["-tag:v", "hvc1"] : []),
            "-f", "mp4",
            mp4Path
        ];

        await runFfmpeg(ffmpegArgs);
        console.log(`   ✓ Created: ${mp4Path}`);

        // Step 6: Extract thumbnail
        console.log(`\n4. Extracting thumbnail...`);
        const jpgPath = `${OUT_DIR}/${device.name}.jpg`;

        await runFfmpeg([
            "-hide_banner", "-loglevel", "error", "-y",
            "-i", mp4Path,
            "-vframes", "1",
            "-f", "image2",
            jpgPath
        ]);
        console.log(`   ✓ Created: ${jpgPath}`);

        // Step 7: Verify
        console.log(`\n5. Verifying...`);
        const { execSync } = await import("node:child_process");
        const probeOut = execSync(`ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${mp4Path}"`, { encoding: "utf8" });
        const duration = parseFloat(probeOut.trim());
        console.log(`   Duration: ${duration.toFixed(1)}s`);

        return {
            device: device.name,
            status: "OK",
            bytes: annexB.length,
            duration,
            videoType: actualType,
            mp4: mp4Path,
            jpg: jpgPath
        };

    } catch (err) {
        console.error(`   ❌ Error: ${err.message}`);
        return { device: device.name, status: "ERROR", error: err.message };
    } finally {
        try { await api.close(); } catch { }
    }
}

async function main() {
    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║           FULL DOWNLOAD TEST SUITE                       ║");
    console.log("║           Baichuan Native Protocol Only                  ║");
    console.log("╚══════════════════════════════════════════════════════════╝");

    mkdirSync(OUT_DIR, { recursive: true });

    const results = [];

    for (const device of DEVICES) {
        const result = await testDevice(device);
        results.push(result);
    }

    // Summary
    console.log("\n" + "═".repeat(60));
    console.log("RESULTS SUMMARY");
    console.log("═".repeat(60));

    let allOk = true;
    for (const r of results) {
        const icon = r.status === "OK" ? "✅" : "❌";
        if (r.status === "OK") {
            console.log(`${icon} ${r.device}: ${(r.bytes / 1024 / 1024).toFixed(2)} MB, ${r.duration.toFixed(1)}s, ${r.videoType}`);
        } else {
            console.log(`${icon} ${r.device}: ${r.status} - ${r.error || ""}`);
            allOk = false;
        }
    }

    console.log("\n" + "═".repeat(60));
    if (allOk) {
        console.log("✅ ALL TESTS PASSED!");
    } else {
        console.log("❌ SOME TESTS FAILED");
    }

    console.log(`\nOutput files in: ${OUT_DIR}`);
}

main().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});
