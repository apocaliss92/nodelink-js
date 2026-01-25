#!/usr/bin/env node
/**
 * Capture Raw Video Data from Reolink Devices
 *
 * This script captures video access units from live and playback streams
 * and saves them as JSON fixtures for offline testing.
 *
 * Usage:
 *   REOLINK_USER=admin REOLINK_PASSWORD=xxx node test/capture-raw-data.mjs
 *
 * Environment variables:
 *   REOLINK_HOST_TCP     - IP of TrackMix PoE (H.264)
 *   REOLINK_HOST_TCP265  - IP of E1 Outdoor PoE (H.265)
 *   REOLINK_HOST_NVR     - IP of NVR RLN8-410
 *   REOLINK_USER         - Username (default: admin)
 *   REOLINK_PASSWORD     - Password
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dynamically import the library
const { BaichuanClient } = await import("../dist/index.js");

const FIXTURES_DIR = path.join(__dirname, "fixtures", "raw");

// Device configurations
const DEVICES = {
    tcp: {
        host: process.env.REOLINK_HOST_TCP || "192.168.50.226",
        name: "TrackMix PoE",
        channels: [0],
    },
    tcp265: {
        host: process.env.REOLINK_HOST_TCP265 || "192.168.1.170",
        name: "E1 Outdoor PoE",
        channels: [0],
    },
    nvr: {
        host: process.env.REOLINK_HOST_NVR || "192.168.1.161",
        name: "NVR RLN8-410",
        channels: [0, 1, 2],
    },
};

const USERNAME = process.env.REOLINK_USER || "admin";
const PASSWORD = process.env.REOLINK_PASSWORD;

const LIVE_FRAMES = 150;
const PLAYBACK_FRAMES = 150;
const PLAYBACK_DURATION_SEC = 10;

async function captureStream(client, channel, streamType, maxFrames) {
    const frames = [];
    let encryption = null;
    let firstTimestamp = null;
    let lastTimestamp = 0;
    let keyframeCount = 0;
    let videoType = null;

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            resolve({ frames, encryption, keyframeCount, videoType, lastTimestamp, firstTimestamp });
        }, 30000);

        const handleFrame = (data) => {
            if (frames.length >= maxFrames) {
                clearTimeout(timeout);
                resolve({ frames, encryption, keyframeCount, videoType, lastTimestamp, firstTimestamp });
                return;
            }

            const timestamp = data.timestamp || Date.now();
            if (firstTimestamp === null) firstTimestamp = timestamp;
            lastTimestamp = timestamp;

            // Detect video type from NAL units
            if (!videoType && data.data && data.data.length > 4) {
                const startCode = data.data[0] === 0 && data.data[1] === 0;
                if (startCode) {
                    let nalOffset = data.data[2] === 0 && data.data[3] === 1 ? 4 : 3;
                    if (nalOffset === 3 && data.data[2] !== 1) nalOffset = 4;
                    if (nalOffset < data.data.length) {
                        const nalByte = data.data[nalOffset];
                        // H.264: type is in bits 0-4, H.265: type is in bits 1-6
                        const h264Type = nalByte & 0x1f;
                        const h265Type = (nalByte >> 1) & 0x3f;
                        // VPS (32), SPS (33), PPS (34) are H.265 specific
                        if (h265Type >= 32 && h265Type <= 34) {
                            videoType = "H265";
                        } else if (h264Type === 7 || h264Type === 8) {
                            videoType = "H264";
                        }
                    }
                }
            }

            const isKeyframe = data.isKeyframe || false;
            if (isKeyframe) keyframeCount++;

            frames.push({
                timestamp: timestamp - firstTimestamp,
                size: data.data.length,
                isKeyframe,
                data: data.data.toString("base64"),
            });
        };

        client.on("videoAccessUnit", handleFrame);
        client.once("error", (err) => {
            clearTimeout(timeout);
            client.off("videoAccessUnit", handleFrame);
            reject(err);
        });
    });
}

async function captureDevice(deviceId, config) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`Capturing: ${config.name} (${config.host})`);
    console.log("═".repeat(60));

    const deviceDir = path.join(FIXTURES_DIR, deviceId);
    fs.mkdirSync(deviceDir, { recursive: true });

    const client = new BaichuanClient({
        host: config.host,
        username: USERNAME,
        password: PASSWORD,
    });

    try {
        console.log("Connecting...");
        await client.connect();

        // Save device info
        const deviceInfo = {
            capturedAt: new Date().toISOString(),
            host: config.host,
            deviceInfo: client.deviceInfo || {},
            channels: config.channels,
        };
        fs.writeFileSync(
            path.join(deviceDir, "device.json"),
            JSON.stringify(deviceInfo, null, 2)
        );
        console.log("Device info saved");

        for (const channel of config.channels) {
            console.log(`\nChannel ${channel}:`);

            // Capture live stream
            console.log(`  Live: Capturing ${LIVE_FRAMES} frames...`);
            try {
                await client.startLiveStream(channel, "main");
                const liveData = await captureStream(client, channel, "live", LIVE_FRAMES);
                await client.stopLiveStream();

                const liveFixture = {
                    metadata: {
                        type: "live",
                        channel,
                        frameCount: liveData.frames.length,
                        keyframes: liveData.keyframeCount,
                        videoType: liveData.videoType || "unknown",
                        durationMs: liveData.lastTimestamp - (liveData.firstTimestamp || 0),
                    },
                    encryption: {
                        kind: client.encryptionKind || "unknown",
                    },
                    frames: liveData.frames,
                };

                fs.writeFileSync(
                    path.join(deviceDir, `ch${channel}_live.json`),
                    JSON.stringify(liveFixture, null, 2)
                );
                console.log(`  Live: Saved ${liveData.frames.length} frames (${liveData.keyframeCount} KF)`);
            } catch (err) {
                console.log(`  Live: Error - ${err.message}`);
            }

            // Capture playback stream
            console.log(`  Playback: Capturing ${PLAYBACK_FRAMES} frames...`);
            try {
                // Find a recent recording
                const endTime = new Date();
                const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000); // Last 24 hours

                const recordings = await client.searchRecordings(channel, startTime, endTime);
                if (recordings && recordings.length > 0) {
                    const recording = recordings[recordings.length - 1]; // Most recent
                    const playbackStart = new Date(recording.start);
                    const playbackEnd = new Date(playbackStart.getTime() + PLAYBACK_DURATION_SEC * 1000);

                    await client.startPlayback(channel, playbackStart, playbackEnd);
                    const playbackData = await captureStream(client, channel, "playback", PLAYBACK_FRAMES);
                    await client.stopPlayback();

                    const playbackFixture = {
                        metadata: {
                            type: "playback",
                            channel,
                            frameCount: playbackData.frames.length,
                            keyframes: playbackData.keyframeCount,
                            videoType: playbackData.videoType || "unknown",
                            durationMs: playbackData.lastTimestamp - (playbackData.firstTimestamp || 0),
                        },
                        encryption: {
                            kind: client.encryptionKind || "unknown",
                        },
                        frames: playbackData.frames,
                    };

                    fs.writeFileSync(
                        path.join(deviceDir, `ch${channel}_playback.json`),
                        JSON.stringify(playbackFixture, null, 2)
                    );
                    console.log(`  Playback: Saved ${playbackData.frames.length} frames (${playbackData.keyframeCount} KF)`);
                } else {
                    console.log("  Playback: No recordings found");
                }
            } catch (err) {
                console.log(`  Playback: Error - ${err.message}`);
            }
        }
    } catch (err) {
        console.log(`Error: ${err.message}`);
    } finally {
        await client.disconnect();
    }
}

async function main() {
    if (!PASSWORD) {
        console.error("Error: REOLINK_PASSWORD environment variable required");
        process.exit(1);
    }

    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║           RAW VIDEO DATA CAPTURE                           ║");
    console.log("╚════════════════════════════════════════════════════════════╝");

    fs.mkdirSync(FIXTURES_DIR, { recursive: true });

    const summary = {
        capturedAt: new Date().toISOString(),
        devices: {},
    };

    for (const [deviceId, config] of Object.entries(DEVICES)) {
        try {
            await captureDevice(deviceId, config);
            summary.devices[deviceId] = { status: "ok", host: config.host };
        } catch (err) {
            summary.devices[deviceId] = { status: "error", error: err.message };
        }
    }

    fs.writeFileSync(
        path.join(FIXTURES_DIR, "capture-summary.json"),
        JSON.stringify(summary, null, 2)
    );

    console.log("\n" + "═".repeat(60));
    console.log("Capture complete!");
    console.log("═".repeat(60));
}

main().catch(console.error);
