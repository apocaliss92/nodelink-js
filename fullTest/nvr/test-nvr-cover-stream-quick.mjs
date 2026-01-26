#!/usr/bin/env node
/**
 * Quick test for CoverPreview and Replay Stream on NVR
 * Tests the UID fix for cmdId=298 and cmdId=5
 */
import "dotenv/config";
import * as fs from "node:fs/promises";
import { ReolinkBaichuanApi, createLogger } from "../../dist/index.js";

const NVR_HOST = process.env.NVR_HOST || "192.168.1.161";
const NVR_PASSWORD = process.env.NVR_PASSWORD || "Ruocco123";
const CHANNEL = parseInt(process.env.CHANNEL || "0", 10);
const DEBUG = process.env.DEBUG === "1";

const logger = createLogger({
    level: DEBUG ? "debug" : "info",
    prefix: "[NVR-Test]",
});

async function main() {
    console.log("=".repeat(60));
    console.log("NVR CoverPreview + Stream Test");
    console.log("=".repeat(60));
    console.log(`Host: ${NVR_HOST}`);
    console.log(`Channel: ${CHANNEL}`);
    console.log("");

    const api = new ReolinkBaichuanApi({
        host: NVR_HOST,
        username: "admin",
        password: NVR_PASSWORD,
        logger,
        debugConfig: {
            recordings: DEBUG,
        },
    });

    try {
        // Login
        console.log("🔐 Login...");
        await api.login();
        console.log("✅ Login OK\n");

        // Wait for push cache to populate
        console.log("⏳ Waiting for push cache (2s)...");
        await new Promise(r => setTimeout(r, 2000));

        // Get channel info from push cache
        const pushInfo = api.getChannelInfoFromPushCache();
        console.log(`\n📋 Push cache: ${pushInfo.size} channels`);
        for (const [ch, info] of pushInfo) {
            console.log(`   Channel ${ch}: uid=${info.uid || "N/A"} name="${info.name || ""}"`);
        }

        const chInfo = pushInfo.get(CHANNEL);

        // Known UIDs from PCAP analysis for this Home Hub
        const KNOWN_UIDS = {
            0: "9527000HXOHJ142G",  // Videocamera lavanderia
            1: "952700093ABW14UB",
            2: "9527000HZ56U1ORU",  // Baby monitor
        };

        const uid = chInfo?.uid || KNOWN_UIDS[CHANNEL];
        if (!uid) {
            console.log(`\n⚠️  No UID available for channel ${CHANNEL}`);
        } else {
            console.log(`\n📷 Using UID: ${uid} for channel ${CHANNEL}`);
        }

        // Get recordings list
        console.log(`\n🔍 Getting recordings for channel ${CHANNEL}...`);
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

        let recordings = [];
        try {
            recordings = await api.getVideoclips({
                channel: CHANNEL,
                uid,  // Pass UID explicitly
                start: startOfDay,
                end: endOfDay,
                streamType: "subStream",
                recordType: "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package",
                timeoutMs: 15000,
            });
            console.log(`✅ Found ${recordings.length} recordings today`);
        } catch (e) {
            console.log(`⚠️  getVideoclips failed: ${e.message}`);
            // Try alarm video
            try {
                const alarmResult = await api.findAlarmVideo({
                    channel: CHANNEL,
                    uid,  // Pass UID explicitly
                    start: startOfDay,
                    end: endOfDay,
                    streamType: "subStream",
                    timeoutMs: 15000,
                });
                recordings = alarmResult.files || [];
                console.log(`✅ Found ${recordings.length} alarm recordings today`);
            } catch (e2) {
                console.log(`⚠️  findAlarmVideo also failed: ${e2.message}`);
            }
        }

        if (recordings.length === 0) {
            console.log("\n❌ No recordings found to test with");
            await api.close();
            return;
        }

        const recording = recordings[0];
        console.log(`\n📹 Using recording: ${recording.fileName}`);
        console.log(`   Start: ${recording.startTime?.toISOString()}`);
        console.log(`   End: ${recording.endTime?.toISOString()}`);

        // ========================================================================
        // TEST 1: CoverPreview (cmdId=298)
        // ========================================================================
        console.log("\n" + "=".repeat(60));
        console.log("TEST 1: CoverPreview (cmdId=298)");
        console.log("=".repeat(60));

        try {
            const coverStart = Date.now();
            const thumbnail = await api.getVideoclipThumbnail({
                channel: CHANNEL,
                uid,  // Pass UID explicitly
                time: recording.startTime,
                endTime: recording.endTime || new Date(recording.startTime.getTime() + 60000),
                snapType: "sub",
                timeoutMs: 30000,
                isNvr: true,
            });
            const coverMs = Date.now() - coverStart;

            console.log(`✅ CoverPreview SUCCESS in ${coverMs}ms`);
            console.log(`   Frame size: ${thumbnail.frame.length} bytes`);
            console.log(`   Encoding: ${thumbnail.encoding}`);
            console.log(`   Width: ${thumbnail.width}, Height: ${thumbnail.height}`);

            // Save frame
            const outPath = `fullTest/nvr/downloads/cover_ch${CHANNEL}_test.${thumbnail.encoding === "h265" ? "h265" : "h264"}`;
            await fs.mkdir("fullTest/nvr/downloads", { recursive: true });
            await fs.writeFile(outPath, thumbnail.frame);
            console.log(`   Saved to: ${outPath}`);
        } catch (e) {
            console.log(`❌ CoverPreview FAILED: ${e.message}`);
        }

        // ========================================================================
        // TEST 2: Replay Stream (cmdId=5)
        // ========================================================================
        console.log("\n" + "=".repeat(60));
        console.log("TEST 2: Replay Stream (cmdId=5)");
        console.log("=".repeat(60));

        try {
            const streamStart = Date.now();
            let totalBytes = 0;
            let frameCount = 0;
            let videoCodec = "unknown";

            const { stream, stop } = await api.startRecordingReplayStream({
                channel: CHANNEL,
                fileName: recording.fileName,
                streamType: "subStream",
                timeoutMs: 30000,
                isNvr: true,  // Force NVR mode - Home Hub doesn't report channelNum correctly
            });

            console.log("✅ Stream started, collecting frames for 5s...");

            // Set timeout to stop after 5 seconds
            const stopTimeout = setTimeout(async () => {
                console.log("\n⏱️  Stopping stream after 5s...");
                await stop();
            }, 5000);

            stream.on("videoAccessUnit", (au) => {
                totalBytes += au.data.length;
                frameCount++;
                if (au.videoType) videoCodec = au.videoType;
            });

            stream.on("audioAccessUnit", (au) => {
                totalBytes += au.data.length;
            });

            await new Promise((resolve) => {
                const safetyTimeout = setTimeout(() => {
                    console.log("   (safety timeout reached)");
                    resolve();
                }, 7000); // 7s safety timeout (5s collect + 2s buffer)

                stream.on("end", () => {
                    clearTimeout(safetyTimeout);
                    resolve();
                });
                stream.on("error", (err) => {
                    clearTimeout(safetyTimeout);
                    console.log(`⚠️  Stream error: ${err.message}`);
                    resolve();
                });
                stream.on("close", () => {
                    clearTimeout(safetyTimeout);
                    resolve();
                });
            });

            clearTimeout(stopTimeout);
            const streamMs = Date.now() - streamStart;

            console.log(`\n✅ Replay Stream COMPLETED in ${streamMs}ms`);
            console.log(`   Total bytes: ${totalBytes}`);
            console.log(`   Frame count: ${frameCount}`);
            console.log(`   Video codec: ${videoCodec}`);
        } catch (e) {
            console.log(`❌ Replay Stream FAILED: ${e.message}`);
            if (DEBUG) console.error(e);
        }

        // ========================================================================
        // TEST 3: MP4 Replay Stream
        // ========================================================================
        console.log("\n" + "=".repeat(60));
        console.log("TEST 3: MP4 Replay Stream");
        console.log("=".repeat(60));

        try {
            const mp4Start = Date.now();
            let mp4Bytes = 0;

            const { mp4: mp4Stream, stop: stopMp4 } = await api.createRecordingReplayMp4Stream({
                channel: CHANNEL,
                fileName: recording.fileName,
                isNvr: true,  // Force NVR mode
            });

            console.log("✅ MP4 Stream started, collecting for 5s...");

            const chunks = [];
            const stopMp4Timeout = setTimeout(async () => {
                console.log("\n⏱️  Stopping MP4 stream after 5s...");
                await stopMp4();
            }, 5000);

            mp4Stream.on("data", (chunk) => {
                mp4Bytes += chunk.length;
                if (chunks.length < 100) chunks.push(chunk); // Keep first 100 chunks
            });

            await new Promise((resolve) => {
                const safetyTimeout = setTimeout(() => {
                    console.log("   (MP4 safety timeout)");
                    resolve();
                }, 7000);

                mp4Stream.on("end", () => {
                    clearTimeout(safetyTimeout);
                    resolve();
                });
                mp4Stream.on("close", () => {
                    clearTimeout(safetyTimeout);
                    resolve();
                });
                mp4Stream.on("error", (err) => {
                    clearTimeout(safetyTimeout);
                    console.log(`⚠️  MP4 Stream error: ${err.message}`);
                    resolve();
                });
            });

            clearTimeout(stopMp4Timeout);
            const mp4Ms = Date.now() - mp4Start;

            console.log(`\n✅ MP4 Replay Stream COMPLETED in ${mp4Ms}ms`);
            console.log(`   Total bytes: ${mp4Bytes}`);

            if (mp4Bytes > 0) {
                const mp4Path = `fullTest/nvr/downloads/replay_ch${CHANNEL}_test.mp4`;
                const mp4Buffer = Buffer.concat(chunks);
                await fs.writeFile(mp4Path, mp4Buffer);
                console.log(`   Saved partial MP4 to: ${mp4Path} (${mp4Buffer.length} bytes)`);
            }
        } catch (e) {
            console.log(`❌ MP4 Replay Stream FAILED: ${e.message}`);
            if (DEBUG) console.error(e);
        }

        console.log("\n" + "=".repeat(60));
        console.log("TEST COMPLETE");
        console.log("=".repeat(60));

        await api.close();
    } catch (e) {
        console.error("Fatal error:", e);
        await api.close().catch(() => { });
        process.exit(1);
    }
}

main().catch(console.error);
