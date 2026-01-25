#!/usr/bin/env node
/**
 * Test con parametri corretti dal PCAP:
 * - UID della camera (non NVR)
 * - subStream
 * - data 2026
 */

import "dotenv/config";
import { ReolinkBaichuanApi, createLogger } from "../../dist/index.js";

const NVR_HOST = process.env.NVR_HOST || "192.168.1.161";
const NVR_USERNAME = process.env.NVR_USERNAME || "admin";
const NVR_PASSWORD = process.env.NVR_PASSWORD || "";

// UIDs delle camere connesse all'NVR (da cmd 145 push)
const CAMERA_UIDS = {
    0: "9527000HXOHJ142G",  // Channel 0
    1: "952700093ABW14UB",  // Channel 1  
    2: "9527000HZ56U1ORU",  // Channel 2
};

const CHANNEL = parseInt(process.env.CHANNEL || "0", 10);
const STREAM_TYPE = process.env.STREAM_TYPE || "subStream";  // PCAP usa subStream!

const logger = createLogger({
    name: "nvr-test-correct",
    level: "debug",
});

async function main() {
    console.log("=== Test con parametri corretti dal PCAP ===\n");
    console.log(`Host: ${NVR_HOST}`);
    console.log(`Channel: ${CHANNEL}`);
    console.log(`Camera UID: ${CAMERA_UIDS[CHANNEL]}`);
    console.log(`Stream Type: ${STREAM_TYPE}`);

    const api = new ReolinkBaichuanApi({
        host: NVR_HOST,
        username: NVR_USERNAME,
        password: NVR_PASSWORD,
        uid: CAMERA_UIDS[CHANNEL],  // UID della camera, non dell'NVR!
        channel: CHANNEL,
        logger,
    });

    try {
        await api.login();
        console.log("✅ Login OK\n");

        // Usa la data corrente del sistema (2026)
        const now = new Date();
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        const end = new Date(now);

        console.log(`🔍 Cercando registrazioni:`);
        console.log(`   Da: ${start.toISOString()}`);
        console.log(`   A:  ${end.toISOString()}`);
        console.log(`   Stream: ${STREAM_TYPE}\n`);

        const files = await api.listRecordings({
            start,
            end,
            streamType: STREAM_TYPE,
            recordType: "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package"
        });

        console.log(`✅ Trovate ${files.length} registrazioni\n`);

        if (files.length > 0) {
            console.log("📋 Prime 5 registrazioni:");
            for (const f of files.slice(0, 5)) {
                console.log(`   - ${f.fileName}`);
                console.log(`     ${f.startTime?.toISOString()} - ${f.endTime?.toISOString()}`);
            }
        }

    } catch (err) {
        console.error("❌ Errore:", err.message);
        if (process.env.DEBUG) console.error(err.stack);
    } finally {
        await api.close();
    }
}

main().catch(console.error);
