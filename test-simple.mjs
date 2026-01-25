#!/usr/bin/env node
/**
 * Test SEMPLICE per verificare cosa funziona.
 */

import "dotenv/config";
import { ReolinkBaichuanApi, createLogger } from "./dist/index.js";
import { writeFileSync, mkdirSync } from "node:fs";

const logger = createLogger({ name: "simple-test", level: "debug" });

const HOST = "192.168.1.170";
const USER = process.env.TCP_USERNAME || "admin";
const PASS = process.env.TCP_PASSWORD || "Ruocco123";

async function main() {
    console.log("=== TEST SEMPLICE ===");
    console.log(`Host: ${HOST}, User: ${USER}`);

    const api = new ReolinkBaichuanApi({
        host: HOST,
        username: USER,
        password: PASS,
        logger
    });

    try {
        // Step 1: Login
        console.log("\n1. Login...");
        await api.client.login();
        console.log("✓ Login OK");

        // Step 2: Get device info
        console.log("\n2. Device Info...");
        const info = await api.getInfo();
        console.log(`✓ Device: ${info.devName || info.name}, Model: ${info.model}, FW: ${info.firmwareVersion}`);

        // Step 3: Get recordings for today
        console.log("\n3. Get recordings (22 gennaio)...");
        const recordings = await api.getVideoclips({
            channel: 0,
            start: new Date(2026, 0, 22, 0, 0, 0),
            end: new Date(2026, 0, 22, 23, 59, 59),
            streamType: "mainStream"
        });
        console.log(`✓ Found ${recordings.length} recordings`);

        if (recordings.length === 0) {
            console.log("No recordings found!");
            return;
        }

        // Pick a short recording
        const rec = recordings[0];
        const fileName = rec.fileName || rec.name || rec.id;
        console.log(`\n4. Selected recording: ${fileName}`);

        // Step 4: Try download with downloadRecordingDemuxed (extracts video)
        console.log("\n5. Attempting downloadRecordingDemuxed...");

        mkdirSync("./test/artifacts", { recursive: true });

        try {
            const { annexB, videoType } = await api.downloadRecordingDemuxed({
                channel: 0,
                fileName: fileName,
                timeoutMs: 120_000
            });

            console.log(`✓ Downloaded ${annexB.length} bytes, type: ${videoType}`);

            const ext = videoType === "H265" ? "hevc" : "h264";
            const rawPath = `./test/artifacts/simple_test.${ext}`;
            writeFileSync(rawPath, annexB);
            console.log(`✓ Saved raw video to ${rawPath}`);

            // Now convert to MP4 with ffmpeg
            console.log("\n6. Converting to MP4...");
            const { spawn } = await import("node:child_process");

            const mp4Path = "./test/artifacts/simple_test_final.mp4";
            await new Promise((resolve, reject) => {
                const args = [
                    "-hide_banner", "-loglevel", "error", "-y",
                    "-fflags", "+genpts",
                    "-r", "25",
                    "-f", videoType === "H265" ? "hevc" : "h264",
                    "-i", rawPath,
                    "-c", "copy",
                    "-movflags", "+faststart",
                    ...(videoType === "H265" ? ["-tag:v", "hvc1"] : []),
                    "-f", "mp4",
                    mp4Path
                ];
                const p = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
                p.on("error", reject);
                p.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
            });

            console.log(`✓ Created MP4: ${mp4Path}`);

            // Extract thumbnail
            const jpgPath = "./test/artifacts/simple_test_final.jpg";
            await new Promise((resolve, reject) => {
                const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", mp4Path, "-vframes", "1", "-f", "image2", jpgPath];
                const p = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
                p.on("error", reject);
                p.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
            });
            console.log(`✓ Created JPEG: ${jpgPath}`);

        } catch (dlErr) {
            console.error(`✗ downloadRecordingDemuxed failed: ${dlErr.message}`);
            console.error(dlErr.stack);
        }

    } catch (err) {
        console.error(`\n✗ Error: ${err.message}`);
        console.error(err.stack);
    } finally {
        try { await api.close(); } catch { }
        console.log("\nDone.");
    }
}

main();
