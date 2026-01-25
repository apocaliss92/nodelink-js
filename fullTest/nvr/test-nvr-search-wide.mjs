#!/usr/bin/env node
/**
 * Test ricerca registrazioni con intervallo ampio
 */

import "dotenv/config";
import { ReolinkBaichuanApi, createLogger } from "../../dist/index.js";

const NVR_HOST = process.env.NVR_HOST || "192.168.1.161";
const NVR_USERNAME = process.env.NVR_USERNAME || "admin";
const NVR_PASSWORD = process.env.NVR_PASSWORD || "";
const NVR_UID = process.env.NVR_UID || "9527000HY0GDYRIW";
const CHANNEL = parseInt(process.env.CHANNEL || "0", 10);

const logger = createLogger({
    name: "nvr-search-wide",
    level: "debug",
});

async function main() {
    console.log("=== NVR Search Wide ===\n");
    console.log(`Host: ${NVR_HOST}`);
    console.log(`Channel: ${CHANNEL}`);
    console.log(`UID: ${NVR_UID}`);

    const api = new ReolinkBaichuanApi({
        host: NVR_HOST,
        username: NVR_USERNAME,
        password: NVR_PASSWORD,
        uid: NVR_UID,
        channel: CHANNEL,
        logger,
    });

    try {
        await api.login();
        console.log("✅ Login OK\n");

        // Cerca negli ultimi 30 giorni (date fisse nel 2025)
        const end = new Date('2025-01-25T23:59:59');
        const start = new Date('2024-12-25T00:00:00');

        console.log(`🔍 Cercando registrazioni:`);
        console.log(`   Da: ${start.toISOString()}`);
        console.log(`   A:  ${end.toISOString()}\n`);

        const files = await api.listRecordings({
            start,
            end,
            streamType: 'mainStream',
            recordType: 'manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package'
        });

        console.log(`✅ Trovate ${files.length} registrazioni\n`);

        if (files.length > 0) {
            console.log("📋 Prime 5 registrazioni:");
            for (const f of files.slice(0, 5)) {
                console.log(`   - ${f.fileName} (${f.startTime?.toISOString()} - ${f.endTime?.toISOString()})`);
            }
            console.log("\n📋 Ultime 5 registrazioni:");
            for (const f of files.slice(-5)) {
                console.log(`   - ${f.fileName} (${f.startTime?.toISOString()} - ${f.endTime?.toISOString()})`);
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
