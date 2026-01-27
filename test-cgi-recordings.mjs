#!/usr/bin/env node
/**
 * Test CGI API for recordings:
 * 1. Search yesterday's recordings via getVideoclips()
 * 2. Download first recording to MP4 and validate with ffprobe
 * 3. Extract thumbnail via getVideoclipThumbnailJpeg()
 *
 * Uses 3 cameras from .env:
 * - TCP_HOST (standalone camera)
 * - TCP265_HOST (standalone H265 camera)
 * - NVR_HOST (NVR channels 0, 1, 2)
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { ReolinkCgiApi } from "./dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "output", "cgi-test");

// Ensure output directory exists
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Get ffmpeg/ffprobe paths
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";

// Test configurations from .env
const CONFIGS = [];

// TCP camera (standard)
if (process.env.TCP_HOST) {
    CONFIGS.push({
        name: "TCP",
        host: process.env.TCP_HOST,
        username: process.env.TCP_USERNAME || "admin",
        password: process.env.TCP_PASSWORD,
        channels: [0],
    });
}

// TCP265 camera (H.265) - use today for more recent recordings
if (process.env.TCP265_HOST) {
    CONFIGS.push({
        name: "TCP265",
        host: process.env.TCP265_HOST,
        username: process.env.TCP265_USERNAME || "admin",
        password: process.env.TCP265_PASSWORD,
        channels: [0],
        customDate: new Date(), // Today
    });
}

// NVR (Home Hub) - channels 0, 1, 2
if (process.env.NVR_HOST) {
    CONFIGS.push({
        name: "NVR",
        host: process.env.NVR_HOST,
        username: process.env.NVR_USERNAME || "admin",
        password: process.env.NVR_PASSWORD,
        channels: [0, 1, 2],
    });
}

if (CONFIGS.length === 0) {
    console.error("No cameras configured in .env");
    process.exit(1);
}

/**
 * Get date range for a specific day (00:00:00 to 23:59:59 local time)
 * @param {Date} [date] - Specific date, or yesterday if not provided
 */
function getDateRange(date) {
    const targetDate = date ? new Date(date) : new Date();
    if (!date) {
        targetDate.setDate(targetDate.getDate() - 1); // yesterday
    }
    targetDate.setHours(0, 0, 0, 0);

    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    return { start: targetDate, end: endOfDay };
}

/**
 * Run ffprobe on a file and return parsed JSON
 */
async function ffprobe(filePath) {
    return new Promise((resolve, reject) => {
        const args = [
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            filePath,
        ];

        const proc = spawn(FFPROBE_PATH, args);
        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));

        proc.on("close", (code) => {
            if (code === 0) {
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    reject(new Error(`ffprobe JSON parse error: ${e.message}`));
                }
            } else {
                reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
            }
        });

        proc.on("error", (err) => reject(err));
    });
}

/**
 * Download a file from URL using HTTP (for Download endpoint)
 */
async function downloadWithHttp(url, outputPath, maxBytes = 5 * 1024 * 1024, timeoutMs = 30000) {
    const http = await import('http');
    const https = await import('https');

    return new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(outputPath);
        let bytesReceived = 0;
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            writeStream.destroy();
            reject(new Error(`HTTP download timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const protocol = url.startsWith('https') ? https : http;

        const req = protocol.get(url, (res) => {
            if (res.statusCode !== 200) {
                clearTimeout(timer);
                reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                return;
            }

            res.on('data', (chunk) => {
                bytesReceived += chunk.length;
                writeStream.write(chunk);

                // Stop after maxBytes
                if (bytesReceived >= maxBytes) {
                    res.destroy();
                    writeStream.end();
                }
            });

            res.on('end', () => {
                clearTimeout(timer);
                writeStream.end();
                resolve(bytesReceived);
            });

            res.on('error', (err) => {
                clearTimeout(timer);
                writeStream.destroy();
                reject(err);
            });
        });

        req.on('error', (err) => {
            clearTimeout(timer);
            writeStream.destroy();
            reject(err);
        });

        writeStream.on('finish', () => {
            if (!timedOut) {
                clearTimeout(timer);
                resolve(bytesReceived);
            }
        });
    });
}

/**
 * Download a file from URL using ffmpeg (remux to mp4)
 * For FLV streaming, this streams in real-time so timeout must be > duration
 */
async function downloadWithFfmpeg(url, outputPath, durationSec = 10, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const args = [
            "-y",
            "-rw_timeout", "5000000", // 5 second network timeout
            "-i", url,
            "-t", String(durationSec), // Capture duration
            "-c", "copy",
            "-movflags", "+faststart",
            outputPath,
        ];

        const proc = spawn(FFMPEG_PATH, args);
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill("SIGKILL");
            reject(new Error(`ffmpeg download timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        proc.stderr.on("data", (d) => (stderr += d.toString()));

        proc.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut) return;

            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
            }
        });

        proc.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Test a single camera/NVR configuration
 */
async function testConfig(config) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Testing: ${config.name} (${config.host})`);
    console.log(`${"=".repeat(60)}`);

    const api = new ReolinkCgiApi({
        host: config.host,
        username: config.username,
        password: config.password,
        logger: {
            debug: () => { },
            info: (msg) => console.log(`  [INFO] ${msg}`),
            warn: (msg) => console.warn(`  [WARN] ${msg}`),
            error: (msg) => console.error(`  [ERROR] ${msg}`),
        },
    });

    const results = {
        name: config.name,
        host: config.host,
        channels: {},
    };

    // Ensure login before operations
    console.log(`  Logging in...`);
    await api.login();
    console.log(`  Login successful`);

    const { start, end } = getDateRange(config.customDate);
    console.log(`  Search range: ${start.toISOString()} - ${end.toISOString()}`);

    for (const channel of config.channels) {
        console.log(`\n  --- Channel ${channel} ---`);
        const channelResult = {
            searchOk: false,
            recordingsFound: 0,
            downloadOk: false,
            ffprobeOk: false,
            thumbnailOk: false,
            errors: [],
        };

        try {
            // 1. Search recordings
            console.log(`  [1/4] Searching recordings...`);
            const clips = await api.getVideoclips({
                channel,
                start,
                end,
                streamType: "main",
                autoSearchByDay: true,
            });

            channelResult.searchOk = true;
            channelResult.recordingsFound = clips.length;
            console.log(`        Found ${clips.length} recordings`);

            if (clips.length === 0) {
                console.log(`        No recordings to test download/thumbnail`);
                results.channels[channel] = channelResult;
                continue;
            }

            // Use first clip for download test
            const firstClip = clips[0];
            console.log(`        First clip: ${firstClip.fileName}`);
            if (firstClip.startTime) {
                console.log(`        Start: ${firstClip.startTime.toISOString()}`);
            }
            if (firstClip.sizeBytes) {
                console.log(`        Size: ${(firstClip.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
            }

            // 2. Get VOD URL and download via HTTP (Download endpoint with token)
            console.log(`  [2/4] Getting VOD URL and downloading...`);
            const vodUrl = await api.getVodUrl(firstClip.fileName, channel, {
                requestType: "Download",
                streamType: "main",
                prepare: true,
            });
            console.log(`        VOD URL: ${vodUrl.substring(0, 100)}...`);

            const outputFile = path.join(
                OUTPUT_DIR,
                `${config.name}_ch${channel}_${Date.now()}.mp4`
            );

            // Download first 5MB via HTTP (fast, direct download)
            console.log(`        Downloading first 5MB via HTTP...`);
            const bytesDownloaded = await downloadWithHttp(vodUrl, outputFile, 5 * 1024 * 1024, 30000);
            console.log(`        Downloaded ${(bytesDownloaded / 1024 / 1024).toFixed(2)} MB`);
            channelResult.downloadOk = bytesDownloaded > 1000;

            if (!channelResult.downloadOk) {
                channelResult.errors.push(`Downloaded only ${bytesDownloaded} bytes - likely auth error`);
                console.log(`        ERROR: File too small, skipping validation`);
                results.channels[channel] = channelResult;
                continue;
            }
            console.log(`        Downloaded to: ${outputFile}`);

            // 3. Validate with ffprobe
            console.log(`  [3/4] Validating with ffprobe...`);
            const probeResult = await ffprobe(outputFile);
            channelResult.ffprobeOk = true;

            const videoStream = probeResult.streams?.find((s) => s.codec_type === "video");
            const audioStream = probeResult.streams?.find((s) => s.codec_type === "audio");

            if (videoStream) {
                console.log(`        Video: ${videoStream.codec_name} ${videoStream.width}x${videoStream.height}`);
                console.log(`        Duration: ${probeResult.format?.duration || "N/A"}s`);
            }
            if (audioStream) {
                console.log(`        Audio: ${audioStream.codec_name} ${audioStream.sample_rate}Hz`);
            }

            // 4. Extract thumbnail from the downloaded file
            console.log(`  [4/4] Extracting thumbnail from downloaded file...`);
            try {
                const thumbPath = path.join(
                    OUTPUT_DIR,
                    `${config.name}_ch${channel}_thumb_${Date.now()}.jpg`
                );

                // Use ffmpeg directly on the local file (more reliable than HTTP URL)
                await new Promise((resolve, reject) => {
                    const ffmpeg = spawn(FFMPEG_PATH, [
                        "-y",
                        "-ss", "1",
                        "-i", outputFile,
                        "-vframes", "1",
                        "-q:v", "2",
                        thumbPath,
                    ]);

                    let stderr = "";
                    ffmpeg.stderr.on("data", (d) => (stderr += d.toString()));

                    ffmpeg.on("close", (code) => {
                        if (code === 0) {
                            resolve();
                        } else {
                            reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`));
                        }
                    });

                    ffmpeg.on("error", (err) => reject(err));
                });

                const thumbStats = fs.statSync(thumbPath);
                channelResult.thumbnailOk = thumbStats.size > 100;
                console.log(`        Thumbnail saved: ${thumbPath} (${thumbStats.size} bytes)`);
            } catch (thumbErr) {
                channelResult.errors.push(`Thumbnail: ${thumbErr.message}`);
                console.log(`        Thumbnail failed: ${thumbErr.message}`);
            }
        } catch (err) {
            channelResult.errors.push(err.message);
            console.error(`        Error: ${err.message}`);
        }

        results.channels[channel] = channelResult;
    }

    // Cleanup
    try {
        await api.client.logout?.();
    } catch { }

    return results;
}

/**
 * Main entry point
 */
async function main() {
    console.log("CGI Recordings Test");
    console.log(`Output directory: ${OUTPUT_DIR}`);
    console.log(`Cameras to test: ${CONFIGS.map((c) => c.name).join(", ")}`);

    const allResults = [];

    for (const config of CONFIGS) {
        try {
            const result = await testConfig(config);
            allResults.push(result);
        } catch (err) {
            console.error(`Fatal error testing ${config.name}: ${err.message}`);
            allResults.push({
                name: config.name,
                host: config.host,
                error: err.message,
            });
        }
    }

    // Summary
    console.log(`\n${"=".repeat(60)}`);
    console.log("SUMMARY");
    console.log(`${"=".repeat(60)}`);

    let totalPassed = 0;
    let totalFailed = 0;

    for (const result of allResults) {
        console.log(`\n${result.name} (${result.host}):`);
        if (result.error) {
            console.log(`  FATAL ERROR: ${result.error}`);
            totalFailed++;
            continue;
        }

        for (const [channel, chResult] of Object.entries(result.channels)) {
            const status = [];
            if (chResult.searchOk) status.push(`Search ✓ (${chResult.recordingsFound})`);
            else status.push("Search ✗");

            if (chResult.recordingsFound > 0) {
                if (chResult.downloadOk) status.push("Download ✓");
                else status.push("Download ✗");

                if (chResult.ffprobeOk) status.push("ffprobe ✓");
                else status.push("ffprobe ✗");

                if (chResult.thumbnailOk) status.push("Thumbnail ✓");
                else status.push("Thumbnail ✗");
            }

            const allOk =
                chResult.searchOk &&
                (chResult.recordingsFound === 0 ||
                    (chResult.downloadOk && chResult.ffprobeOk && chResult.thumbnailOk));

            console.log(`  Channel ${channel}: ${status.join(" | ")} ${allOk ? "✓" : "✗"}`);
            if (chResult.errors.length > 0) {
                for (const err of chResult.errors) {
                    console.log(`    Error: ${err}`);
                }
            }

            if (allOk) totalPassed++;
            else totalFailed++;
        }
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Total: ${totalPassed} passed, ${totalFailed} failed`);
    console.log(`${"=".repeat(60)}`);

    process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error("Unhandled error:", err);
    process.exit(1);
});
