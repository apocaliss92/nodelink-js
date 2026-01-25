#!/usr/bin/env node
/**
 * Test thumbnail extraction from a recording file
 * 
 * Usage: REOLINK_PASSWORD=xxx node fullTest/test-thumbnail.mjs
 */

import { ReolinkBaichuanApi } from "../dist/index.js";
import * as fs from "fs";

const HOST = process.env.REOLINK_HOST || "192.168.50.226";
const USERNAME = process.env.REOLINK_USER || "admin";
const PASSWORD = process.env.REOLINK_PASSWORD;
const CHANNEL = parseInt(process.env.REOLINK_CHANNEL || "0", 10);
const FILE_NAME = process.env.REOLINK_FILE || null;

if (!PASSWORD) {
    console.error("Error: REOLINK_PASSWORD required");
    process.exit(1);
}

async function main() {
    const api = new ReolinkBaichuanApi({
        host: HOST,
        username: USERNAME,
        password: PASSWORD,
        logger: {
            debug: (...args) => console.log("[DEBUG]", ...args),
            info: (...args) => console.log("[INFO]", ...args),
            warn: (...args) => console.log("[WARN]", ...args),
            error: (...args) => console.log("[ERROR]", ...args),
        },
    });

    try {
        console.log(`\nConnecting to ${HOST}...`);

        // Get device info first
        const info = await api.getInfo();
        console.log(`Device: ${info.devName || "Camera"}`);

        let fileName;

        if (FILE_NAME) {
            // Use provided file name
            fileName = FILE_NAME;
            console.log(`\nUsing provided file: ${fileName}`);
        } else {
            // Search for recordings
            console.log("\nSearching for recordings...");
            const endTime = new Date();
            const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000);

            const recordings = await api.getVideoclips({
                channel: CHANNEL,
                start: startTime,
                end: endTime,
                streamType: "mainStream",
            });
            console.log(`Found ${recordings?.length || 0} recordings`);

            if (!recordings || recordings.length === 0) {
                console.log("No recordings found");
                return;
            }

            // Get the most recent recording
            const recording = recordings[recordings.length - 1];
            fileName = recording.fileName;
            console.log(`\nUsing recording: ${fileName}`);
            console.log(`  Start: ${recording.startTime}`);
            console.log(`  End: ${recording.endTime}`);
        }

        console.log("\nExtracting thumbnail...");
        const startMs = Date.now();

        const jpegBuffer = await api.getRecordingThumbnail({
            channel: CHANNEL,
            fileName: fileName,
        });

        const durationMs = Date.now() - startMs;
        console.log(`\nThumbnail extracted in ${durationMs}ms`);
        console.log(`  Size: ${jpegBuffer.length} bytes`);

        // Save the thumbnail
        const outPath = `/tmp/thumbnail_test_${Date.now()}.jpg`;
        fs.writeFileSync(outPath, jpegBuffer);
        console.log(`  Saved to: ${outPath}`);

        // Verify it's a valid JPEG
        if (jpegBuffer[0] === 0xff && jpegBuffer[1] === 0xd8) {
            console.log("  Valid JPEG header: YES");
        } else {
            console.log("  Valid JPEG header: NO - first bytes:", jpegBuffer.subarray(0, 10).toString("hex"));
        }

        // Check dimensions using ffprobe if available
        try {
            const { execSync } = await import("child_process");
            const info = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 ${outPath}`, { encoding: "utf-8" });
            console.log(`  Dimensions: ${info.trim()}`);
        } catch {
            console.log("  Dimensions: (ffprobe not available)");
        }

    } catch (e) {
        console.error("Error:", e.message);
        console.error(e.stack);
    } finally {
        await api.close();
    }
}

main();
