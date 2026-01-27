#!/usr/bin/env node
/**
 * Test all VOD URL types for TCP265 camera
 * - Download (cmd=Download with token)
 * - FLV (streaming with username/password)
 * - Playback (cmd=Playback with token)
 * - RTMP (rtmp streaming with username/password)
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { ReolinkCgiApi } from "./dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "output", "tcp265-test");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

const host = process.env.TCP265_HOST;
const username = process.env.TCP265_USERNAME || "admin";
const password = process.env.TCP265_PASSWORD;

if (!host || !password) {
    console.error("TCP265_HOST and TCP265_PASSWORD required in .env");
    process.exit(1);
}

console.log(`\n=== TCP265 VOD URL Test ===`);
console.log(`Host: ${host}`);
console.log(`Output: ${OUTPUT_DIR}\n`);

const api = new ReolinkCgiApi({
    host,
    username,
    password,
    logger: {
        debug: () => { },
        info: (msg) => console.log(`[INFO] ${msg}`),
        warn: (msg) => console.warn(`[WARN] ${msg}`),
        error: (msg) => console.error(`[ERROR] ${msg}`),
    },
});

/**
 * Download via HTTP with timeout
 */
function downloadHttp(url, outputPath, maxBytes = 5 * 1024 * 1024, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(outputPath);
        let bytesReceived = 0;
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            writeStream.destroy();
            reject(new Error(`Timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const req = http.get(url, (res) => {
            console.log(`    HTTP ${res.statusCode} ${res.statusMessage}`);
            console.log(`    Content-Type: ${res.headers["content-type"]}`);
            console.log(`    Content-Length: ${res.headers["content-length"] || "unknown"}`);

            if (res.statusCode !== 200) {
                clearTimeout(timer);
                let body = "";
                res.on("data", (d) => (body += d.toString()));
                res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)));
                return;
            }

            res.on("data", (chunk) => {
                bytesReceived += chunk.length;
                writeStream.write(chunk);
                if (bytesReceived >= maxBytes) {
                    res.destroy();
                    writeStream.end();
                }
            });

            res.on("end", () => {
                clearTimeout(timer);
                writeStream.end();
                resolve(bytesReceived);
            });

            res.on("error", (err) => {
                clearTimeout(timer);
                writeStream.destroy();
                reject(err);
            });
        });

        req.on("error", (err) => {
            clearTimeout(timer);
            writeStream.destroy();
            reject(err);
        });

        writeStream.on("finish", () => {
            if (!timedOut) resolve(bytesReceived);
        });
    });
}

/**
 * Capture stream via ffmpeg
 */
function captureWithFfmpeg(url, outputPath, durationSec = 5, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const args = [
            "-y",
            "-rw_timeout", "5000000",
            "-i", url,
            "-t", String(durationSec),
            "-c", "copy",
            "-movflags", "+faststart",
            outputPath,
        ];

        console.log(`    ffmpeg -i "${url.substring(0, 80)}..." -t ${durationSec}`);

        const proc = spawn(FFMPEG_PATH, args);
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill("SIGKILL");
            reject(new Error(`Timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        proc.stderr.on("data", (d) => (stderr += d.toString()));

        proc.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut) return;
            if (code === 0) {
                resolve(fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0);
            } else {
                reject(new Error(`ffmpeg code ${code}: ${stderr.slice(-300)}`));
            }
        });

        proc.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

async function main() {
    try {
        // Login
        console.log("Logging in...");
        await api.login();
        console.log("Login successful\n");

        // Search recordings - try last 7 days
        let clips = [];
        let searchDate = null;

        for (let daysAgo = 0; daysAgo <= 7; daysAgo++) {
            const day = new Date();
            day.setDate(day.getDate() - daysAgo);
            day.setHours(0, 0, 0, 0);
            const endOfDay = new Date(day);
            endOfDay.setHours(23, 59, 59, 999);

            console.log(`Searching recordings for ${day.toLocaleDateString()}...`);
            clips = await api.getVideoclips({
                channel: 0,
                start: day,
                end: endOfDay,
                streamType: "main",
                autoSearchByDay: true,
            });

            console.log(`  Found ${clips.length} recordings`);

            if (clips.length > 0) {
                searchDate = day;
                break;
            }
        }

        console.log("");

        if (clips.length === 0) {
            console.log("No recordings found in last 7 days.");
            return;
        }

        const firstClip = clips[0];
        // Use the last (most recent) clip instead of first - old ones may be overwritten
        const lastClip = clips[clips.length - 1];

        console.log(`First clip: ${firstClip.fileName}`);
        console.log(`  Start: ${firstClip.startTime?.toISOString()}`);
        console.log(`Last clip: ${lastClip.fileName}`);
        console.log(`  Start: ${lastClip.startTime?.toISOString()}`);
        console.log(`  Size: ${((lastClip.sizeBytes || 0) / 1024 / 1024).toFixed(2)} MB`);
        console.log(`\nUsing LAST clip (most recent, less likely to be overwritten)\n`);

        const clip = lastClip;

        // Test all URL types
        const urlTypes = ["Download", "Playback", "FLV", "RTMP"];

        for (const requestType of urlTypes) {
            console.log(`\n--- Testing ${requestType} URL ---`);
            try {
                const vodUrl = await api.getVodUrl(clip.fileName, 0, {
                    requestType,
                    streamType: "main",
                    prepare: true,
                });
                console.log(`  URL: ${vodUrl.substring(0, 120)}...`);

                const outputFile = path.join(OUTPUT_DIR, `tcp265_${requestType.toLowerCase()}_${Date.now()}.mp4`);

                if (requestType === "Download" || requestType === "Playback") {
                    // HTTP download
                    console.log(`  Downloading via HTTP...`);
                    const bytes = await downloadHttp(vodUrl, outputFile, 5 * 1024 * 1024, 30000);
                    console.log(`  ✓ Downloaded ${(bytes / 1024 / 1024).toFixed(2)} MB to ${path.basename(outputFile)}`);
                } else if (requestType === "FLV") {
                    // FLV streaming via ffmpeg (real-time)
                    console.log(`  Capturing via ffmpeg (5s)...`);
                    const bytes = await captureWithFfmpeg(vodUrl, outputFile, 5, 30000);
                    console.log(`  ✓ Captured ${(bytes / 1024 / 1024).toFixed(2)} MB to ${path.basename(outputFile)}`);
                } else if (requestType === "RTMP") {
                    // RTMP streaming via ffmpeg
                    console.log(`  Capturing via ffmpeg (5s)...`);
                    const bytes = await captureWithFfmpeg(vodUrl, outputFile, 5, 30000);
                    console.log(`  ✓ Captured ${(bytes / 1024 / 1024).toFixed(2)} MB to ${path.basename(outputFile)}`);
                }
            } catch (err) {
                console.log(`  ✗ Error: ${err.message}`);
            }
        }

        console.log("\n=== Test Complete ===\n");
    } catch (err) {
        console.error("Fatal error:", err.message);
        process.exit(1);
    }
}

main();
