#!/usr/bin/env node
/**
 * test-nvr-download-pcap-style.mjs
 *
 * Download clip e cover usando i parametri ESATTI dal PCAP:
 * - Replay (cmdId=5): headerChannelId=137, xmlChannelId=0, streamType=subStream
 * - CoverPreview (cmdId=298): headerChannelId=181, xmlChannelId=0, streamType=subStream
 */

import "dotenv/config";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ReolinkBaichuanApi, createLogger } from "../../dist/index.js";

// ============================================================================
// Configurazione
// ============================================================================

const NVR_HOST = process.env.NVR_HOST || "192.168.1.161";
const NVR_USERNAME = process.env.NVR_USERNAME || "admin";
const NVR_PASSWORD = process.env.NVR_PASSWORD || "";
const CHANNEL = parseInt(process.env.CHANNEL || "0", 10);
const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
const OUT_DIR = process.env.OUT_DIR || "./downloads/nvr-pcap-style";

// UIDs camera noti dal PCAP
const KNOWN_CAMERA_UIDS = {
    0: "9527000HXOHJ142G",  // Videocamera lavanderia
    1: "952700093ABW14UB",
    2: "9527000HZ56U1ORU",
};

// Parametri ESATTI dal PCAP
const PCAP_PARAMS = {
    replay: {
        // Dal PCAP: [66] Replay channelId=82, [77] Replay channelId=137
        // Provo entrambi
        headerChannelIds: [82, 137, 134],
        xmlChannelId: 0,
        streamType: "subStream",
        supportSub: 1,
        playSpeed: 1,
    },
    coverPreview: {
        // Dal PCAP: [52] CoverPreview channelId=59, [82] channelId=181
        headerChannelIds: [59, 181, 54],
        xmlChannelId: 0,
        streamType: "subStream",
    },
};

// ============================================================================
// Utilità
// ============================================================================

function getStartOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function sanitizeFileName(name) {
    return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║  NVR Download PCAP-Style (Parametri Esatti)                  ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log();

    if (!NVR_PASSWORD) {
        console.error("❌ Manca NVR_PASSWORD!");
        process.exitCode = 1;
        return;
    }

    await fs.mkdir(OUT_DIR, { recursive: true });

    const cameraUid = KNOWN_CAMERA_UIDS[CHANNEL];
    console.log(`📡 Host: ${NVR_HOST}`);
    console.log(`📺 Channel: ${CHANNEL}`);
    console.log(`📷 Camera UID: ${cameraUid}`);
    console.log(`📁 Output: ${OUT_DIR}`);
    console.log();

    const logger = createLogger({
        name: "nvr-pcap-style",
        level: DEBUG ? "debug" : "info",
    });

    const api = new ReolinkBaichuanApi({
        host: NVR_HOST,
        username: NVR_USERNAME,
        password: NVR_PASSWORD,
        channel: CHANNEL,
        logger,
    });

    try {
        // 1. Login
        console.log("🔐 Login...");
        await api.login();
        await new Promise(r => setTimeout(r, 1000));

        // 2. Lista eventi di oggi (solo i primi 3)
        console.log("\n🔍 Lista eventi oggi...");
        const now = new Date();
        const todayStart = getStartOfDay(now);

        const events = await api.listRecordings({
            channel: CHANNEL,
            uid: cameraUid,
            start: todayStart,
            end: now,
            streamType: "subStream",
            recordType: "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package",
            timeoutMs: 30_000,
        });

        console.log(`   ✅ Trovati ${events.length} eventi`);

        if (events.length === 0) {
            console.log("   ⚠️  Nessun evento trovato!");
            return;
        }

        // Prendi solo i primi 2 eventi
        const testEvents = events.slice(0, 2);
        console.log(`   📋 Testerò ${testEvents.length} eventi:`);
        for (const e of testEvents) {
            console.log(`      - ${path.basename(e.fileName)}`);
        }

        // 3. Download clip usando parametri PCAP - prova tutti i channelId
        for (let i = 0; i < testEvents.length; i++) {
            const event = testEvents[i];
            console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`📥 Download clip ${i + 1}/${testEvents.length}`);
            console.log(`   File: ${event.fileName}`);

            const outPath = path.join(OUT_DIR, `clip_${i}_${sanitizeFileName(path.basename(event.fileName))}`);
            let success = false;

            for (const headerChId of PCAP_PARAMS.replay.headerChannelIds) {
                if (success) break;
                console.log(`   → Provo headerChannelId=${headerChId}...`);

                try {
                    const startTime = Date.now();

                    const clipBuffer = await api.client.sendBinary({
                        cmdId: 5, // Replay
                        channelIdOverride: headerChId,
                        msgNumOverride: 0,
                        messageClass: 0x6414, // BC_CLASS_MODERN_24
                        // PCAP: Replay requests have NO Extension XML (bodyLen=410 is just payload)
                        // extensionXml: undefined,
                        payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<channelId>${PCAP_PARAMS.replay.xmlChannelId}</channelId>
<Id>${event.fileName}</Id>
<uid>${cameraUid}</uid>
<supportSub>${PCAP_PARAMS.replay.supportSub}</supportSub>
<playSpeed>${PCAP_PARAMS.replay.playSpeed}</playSpeed>
<streamType>${PCAP_PARAMS.replay.streamType}</streamType>
</FileInfo>
</FileInfoList>
</body>`,
                        streamType: 2, // subStream
                        timeoutMs: 5_000,
                    });

                    const elapsed = Date.now() - startTime;
                    await fs.writeFile(outPath, clipBuffer);
                    console.log(`   ✅ Salvato: ${clipBuffer.length} bytes in ${elapsed}ms (headerChId=${headerChId})`);
                    success = true;
                } catch (e) {
                    console.log(`   ❌ headerChId=${headerChId}: ${e.message.split('\n')[0]}`);
                }
            }
            if (!success) console.log(`   ⚠️  Tutti i tentativi falliti`);
        }

        // 4. Download cover usando parametri PCAP - prova tutti i channelId
        for (let i = 0; i < Math.min(testEvents.length, 1); i++) {
            const event = testEvents[i];
            if (!event.startTime) continue;

            console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`🖼️  Download cover ${i + 1}`);
            console.log(`   Time: ${event.startTime.toISOString()}`);

            const outPath = path.join(OUT_DIR, `cover_${i}_${sanitizeFileName(path.basename(event.fileName))}.h264`);
            const endTime = new Date(event.startTime.getTime() + 10_000);
            let success = false;

            for (const headerChId of PCAP_PARAMS.coverPreview.headerChannelIds) {
                if (success) break;
                console.log(`   → Provo headerChannelId=${headerChId}...`);

                try {
                    const startTimer = Date.now();

                    const coverBuffer = await api.client.sendBinaryCoverPreview({
                        cmdId: 298,
                        channelIdOverride: headerChId,
                        msgNumOverride: 0,
                        messageClass: 0x6414,
                        // PCAP: CoverPreview requests also have NO Extension
                        // extensionXml: undefined,
                        streamType: 0,
                        payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<CoverPreview version="1.1">
<channelId>${PCAP_PARAMS.coverPreview.xmlChannelId}</channelId>
<uid>${cameraUid}</uid>
<streamType>${PCAP_PARAMS.coverPreview.streamType}</streamType>
<startTime>
<year>${event.startTime.getUTCFullYear()}</year>
<month>${event.startTime.getUTCMonth() + 1}</month>
<day>${event.startTime.getUTCDate()}</day>
<hour>${event.startTime.getUTCHours()}</hour>
<minute>${event.startTime.getUTCMinutes()}</minute>
<second>${event.startTime.getUTCSeconds()}</second>
</startTime>
<endTime>
<year>${endTime.getUTCFullYear()}</year>
<month>${endTime.getUTCMonth() + 1}</month>
<day>${endTime.getUTCDate()}</day>
<hour>${endTime.getUTCHours()}</hour>
<minute>${endTime.getUTCMinutes()}</minute>
<second>${endTime.getUTCSeconds()}</second>
</endTime>
<frameList>
<frameNo>1</frameNo>
</frameList>
</CoverPreview>
</body>`,
                        timeoutMs: 5_000,
                    });

                    const elapsed = Date.now() - startTimer;
                    await fs.writeFile(outPath, coverBuffer);
                    console.log(`   ✅ Salvato: ${coverBuffer.length} bytes in ${elapsed}ms (headerChId=${headerChId})`);
                    success = true;
                } catch (e) {
                    console.log(`   ❌ headerChId=${headerChId}: ${e.message.split('\n')[0]}`);
                }
            }
            if (!success) console.log(`   ⚠️  Tutti i tentativi falliti`);
        }

        console.log("\n✨ Completato!");
    } finally {
        try {
            await api.client.close();
        } catch {
            // ignore
        }
    }
}

main().catch((e) => {
    console.error("💥 Errore fatale:", e);
    process.exitCode = 1;
});
