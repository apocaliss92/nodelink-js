#!/usr/bin/env node
/**
 * Debug script per FileInfoList - invia richiesta manuale per analizzare
 */

import "dotenv/config";
import { ReolinkBaichuanApi, createLogger } from "../../dist/index.js";

const NVR_HOST = process.env.NVR_HOST || "192.168.1.161";
const NVR_USERNAME = process.env.NVR_USERNAME || "admin";
const NVR_PASSWORD = process.env.NVR_PASSWORD || "";
const NVR_UID = process.env.NVR_UID || "9527000HY0GDYRIW";

const logger = createLogger({
    name: "fileinflist-debug",
    level: "debug",
});

// Build the FileInfoList XML manually come nel PCAP
function buildFileInfoListOpenXml(params) {
    const pad = (n) => String(n).padStart(2, "0");
    const start = params.start;
    const end = params.end;

    return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<uid>${params.uid}</uid>
<searchAITrack>1</searchAITrack>
<channelId>${params.channel}</channelId>
<logicChnBitmap>255</logicChnBitmap>
<streamType>${params.streamType}</streamType>
<recordType>${params.recordType}</recordType>
<startTime>
<year>${start.getFullYear()}</year>
<month>${start.getMonth() + 1}</month>
<day>${start.getDate()}</day>
<hour>${start.getHours()}</hour>
<minute>${start.getMinutes()}</minute>
<second>${start.getSeconds()}</second>
</startTime>
<endTime>
<year>${end.getFullYear()}</year>
<month>${end.getMonth() + 1}</month>
<day>${end.getDate()}</day>
<hour>${end.getHours()}</hour>
<minute>${end.getMinutes()}</minute>
<second>${end.getSeconds()}</second>
</endTime>
</FileInfo>
</FileInfoList>
</body>`;
}

async function main() {
    console.log("=== FileInfoList Debug ===\n");

    const api = new ReolinkBaichuanApi({
        host: NVR_HOST,
        username: NVR_USERNAME,
        password: NVR_PASSWORD,
        uid: NVR_UID,
        channel: 0,
        logger,
    });

    try {
        // Login
        await api.login();
        console.log("✅ Login OK\n");

        // Prova diversi scenari
        const now = new Date();
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);

        const channel = 0;
        const uid = NVR_UID;

        console.log(`📅 Range: ${start.toISOString()} - ${now.toISOString()}`);
        console.log(`📺 Channel: ${channel}`);
        console.log(`🔑 UID: ${uid}`);
        console.log();

        // Build XML
        const openXml = buildFileInfoListOpenXml({
            uid,
            channel,
            streamType: "mainStream",
            recordType: "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package",
            start,
            end: now,
        });

        console.log("📤 Request XML:");
        console.log(openXml);
        console.log();

        // Test 1: Invio con channel nel header = 0
        console.log("=== Test 1: channel=0 header ===");
        try {
            const resp1 = await api.sendXml({
                cmdId: 14,
                channel: 0,
                payloadXml: openXml,
                timeoutMs: 15000,
            });
            console.log("✅ Risposta:", resp1.substring(0, 500));
        } catch (e) {
            console.log("❌ Errore:", e.message);
        }

        // Test 2: Invio senza channel (usa default)
        console.log("\n=== Test 2: no channel header ===");
        try {
            const resp2 = await api.sendXml({
                cmdId: 14,
                payloadXml: openXml,
                timeoutMs: 15000,
            });
            console.log("✅ Risposta:", resp2.substring(0, 500));
        } catch (e) {
            console.log("❌ Errore:", e.message);
        }

        // Test 3: Provo senza searchAITrack
        console.log("\n=== Test 3: senza searchAITrack ===");
        const openXml3 = openXml.replace("<searchAITrack>1</searchAITrack>\n", "");
        try {
            const resp3 = await api.sendXml({
                cmdId: 14,
                channel: 0,
                payloadXml: openXml3,
                timeoutMs: 15000,
            });
            console.log("✅ Risposta:", resp3.substring(0, 500));
        } catch (e) {
            console.log("❌ Errore:", e.message);
        }

        // Test 4: Provo con logicChnBitmap diverso
        console.log("\n=== Test 4: logicChnBitmap=1 ===");
        const openXml4 = openXml.replace("<logicChnBitmap>255</logicChnBitmap>", "<logicChnBitmap>1</logicChnBitmap>");
        try {
            const resp4 = await api.sendXml({
                cmdId: 14,
                channel: 0,
                payloadXml: openXml4,
                timeoutMs: 15000,
            });
            console.log("✅ Risposta:", resp4.substring(0, 500));
        } catch (e) {
            console.log("❌ Errore:", e.message);
        }

        // Test 5: Provo recordType più semplice (solo md)
        console.log("\n=== Test 5: recordType=md only ===");
        const openXml5 = buildFileInfoListOpenXml({
            uid,
            channel,
            streamType: "mainStream",
            recordType: "md",
            start,
            end: now,
        });
        try {
            const resp5 = await api.sendXml({
                cmdId: 14,
                channel: 0,
                payloadXml: openXml5,
                timeoutMs: 15000,
            });
            console.log("✅ Risposta:", resp5.substring(0, 500));
        } catch (e) {
            console.log("❌ Errore:", e.message);
        }

        // Test 6: Provo con all recordType
        console.log("\n=== Test 6: recordType=all ===");
        const openXml6 = buildFileInfoListOpenXml({
            uid,
            channel,
            streamType: "mainStream",
            recordType: "all",
            start,
            end: now,
        });
        try {
            const resp6 = await api.sendXml({
                cmdId: 14,
                channel: 0,
                payloadXml: openXml6,
                timeoutMs: 15000,
            });
            console.log("✅ Risposta:", resp6.substring(0, 500));
        } catch (e) {
            console.log("❌ Errore:", e.message);
        }

    } finally {
        await api.close().catch(() => { });
    }
}

main().catch(console.error);
