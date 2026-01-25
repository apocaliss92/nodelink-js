#!/usr/bin/env node
/**
 * Test diagnostico per capire il formato dei dati raw di download
 */

import "dotenv/config";
import * as fs from "node:fs/promises";
import { ReolinkBaichuanApi, createLogger } from "../../dist/index.js";

const NVR_HOST = process.env.NVR_HOST || "192.168.1.161";
const NVR_USERNAME = process.env.NVR_USERNAME || "admin";
const NVR_PASSWORD = process.env.NVR_PASSWORD || "";

const KNOWN_CAMERA_UIDS = {
    0: "9527000HXOHJ142G",  // Verificato da cmd 145 push
    1: "95270003L6BEJQMG",
    2: "9527000HXOJ4JJSZ",
};

async function main() {
    console.log("=== RAW DOWNLOAD DIAGNOSTICS ===\n");

    const logger = createLogger({
        name: "raw-debug",
        level: "debug",
    });

    const api = new ReolinkBaichuanApi({
        host: NVR_HOST,
        username: NVR_USERNAME,
        password: NVR_PASSWORD,
        channel: 0,
        logger,
        debugOptions: { traceRecordings: true },
    });

    try {
        await api.login();
        await new Promise(r => setTimeout(r, 1500));

        // Recupera eventi
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const end = now;

        const uidForRecordings = KNOWN_CAMERA_UIDS[0];

        console.log(`Cercando eventi per channel 0, uid=${uidForRecordings}...`);
        console.log(`Start: ${today.toISOString()}`);
        console.log(`End: ${end.toISOString()}\n`);

        // Prova mainStream (H.265) invece di subStream (H.264)
        const USE_MAIN_STREAM = process.env.USE_MAIN_STREAM === "1";
        const streamType = USE_MAIN_STREAM ? "mainStream" : "subStream";
        console.log(`StreamType: ${streamType}\n`);

        const events = await api.listRecordings({
            channel: 0,
            uid: uidForRecordings,
            start: today,
            end: end,
            streamType,
        });

        console.log(`Trovati ${events.length} eventi\n`);

        if (events.length === 0) {
            console.log("Nessun evento trovato. Esci.");
            return;
        }

        // Prendi il primo evento
        const event = events[0];
        console.log("Primo evento:", {
            fileName: event.fileName,
            startTime: event.startTime,
            endTime: event.endTime,
        });

        // Scarica i dati RAW (non demuxati)
        console.log("\nScaricando dati RAW...\n");

        const rawBuffer = await api.downloadRecording({
            channel: 0,
            uid: uidForRecordings,
            fileName: event.fileName,
            streamType,
        });

        console.log(`Raw buffer size: ${rawBuffer.length} bytes`);

        // Salva il buffer raw
        await fs.writeFile("./downloads/raw_debug.bin", rawBuffer);
        console.log("Salvato: ./downloads/raw_debug.bin\n");

        // Analizza i primi 256 byte
        console.log("=== PRIMI 256 BYTES ===");
        const hexDump = (buf, maxLines = 16) => {
            const lines = [];
            for (let i = 0; i < Math.min(buf.length, maxLines * 16); i += 16) {
                const slice = buf.subarray(i, Math.min(i + 16, buf.length));
                const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
                const ascii = Array.from(slice).map(b => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.').join('');
                lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(48, ' ')}  ${ascii}`);
            }
            return lines.join('\n');
        };

        console.log(hexDump(rawBuffer, 16));
        console.log();

        // Cerca magic BcMedia
        const magics = {
            "1001 (InfoV1)": 0x31303031,
            "1002 (InfoV2)": 0x32303031,
            "cd00-cd09 (IFrame)": [0x63643030, 0x63643039],
            "cd10-cd19 (PFrame)": [0x63643130, 0x63643139],
            "bw50 (AAC)": 0x62773530,
            "bw10 (ADPCM)": 0x62773130,
        };

        console.log("=== RICERCA MAGIC BCMEDIA ===");

        const findMagic = (buf, magic, maxOccurrences = 3) => {
            const positions = [];
            for (let i = 0; i <= buf.length - 4 && positions.length < maxOccurrences; i++) {
                const val = buf.readUInt32LE(i);
                if (val === magic) {
                    positions.push(i);
                }
            }
            return positions;
        };

        // InfoV1
        const infoV1Pos = findMagic(rawBuffer, 0x31303031, 3);
        console.log(`InfoV1 (1001) @ offsets: ${infoV1Pos.length > 0 ? infoV1Pos.map(p => '0x' + p.toString(16)).join(', ') : '(non trovato)'}`);

        // InfoV2
        const infoV2Pos = findMagic(rawBuffer, 0x32303031, 3);
        console.log(`InfoV2 (1002) @ offsets: ${infoV2Pos.length > 0 ? infoV2Pos.map(p => '0x' + p.toString(16)).join(', ') : '(non trovato)'}`);

        // IFrame range cd00-cd09
        let iframePositions = [];
        for (let m = 0x63643030; m <= 0x63643039; m++) {
            iframePositions = iframePositions.concat(findMagic(rawBuffer, m, 3));
        }
        iframePositions.sort((a, b) => a - b);
        console.log(`IFrame (cd0X) @ offsets: ${iframePositions.length > 0 ? iframePositions.slice(0, 5).map(p => '0x' + p.toString(16)).join(', ') + (iframePositions.length > 5 ? '...' : '') : '(non trovato)'}`);

        // PFrame range cd10-cd19
        let pframePositions = [];
        for (let m = 0x63643130; m <= 0x63643139; m++) {
            pframePositions = pframePositions.concat(findMagic(rawBuffer, m, 3));
        }
        pframePositions.sort((a, b) => a - b);
        console.log(`PFrame (cd1X) @ offsets: ${pframePositions.length > 0 ? pframePositions.slice(0, 5).map(p => '0x' + p.toString(16)).join(', ') + (pframePositions.length > 5 ? '...' : '') : '(non trovato)'}`);

        // Primo byte magic trovato
        const firstMagicOffset = Math.min(
            infoV1Pos[0] ?? Infinity,
            infoV2Pos[0] ?? Infinity,
            iframePositions[0] ?? Infinity,
            pframePositions[0] ?? Infinity
        );

        if (firstMagicOffset !== Infinity && firstMagicOffset > 0) {
            console.log(`\n⚠️ PRIMO MAGIC BCMEDIA a offset 0x${firstMagicOffset.toString(16)} (${firstMagicOffset} bytes)`);
            console.log(`I primi ${firstMagicOffset} bytes NON sono BcMedia!`);
            console.log(`\nBytes prima del primo magic:`);
            console.log(hexDump(rawBuffer.subarray(0, Math.min(firstMagicOffset, 64)), 4));

            if (firstMagicOffset > 4) {
                // Prova a leggere come uint32
                for (let i = 0; i < Math.min(firstMagicOffset, 32); i += 4) {
                    const val = rawBuffer.readUInt32LE(i);
                    const valBE = rawBuffer.readUInt32BE(i);
                    console.log(`  offset ${i}: 0x${val.toString(16).padStart(8, '0')} (LE) / 0x${valBE.toString(16).padStart(8, '0')} (BE) = ${val} / ${valBE}`);
                }
            }
        } else if (firstMagicOffset === 0) {
            console.log("\n✅ Primo magic BcMedia a offset 0 - formato corretto");
        } else {
            console.log("\n❌ Nessun magic BcMedia trovato nel buffer!");
        }

        // Test demuxing
        console.log("\n=== TEST DEMUXING ===");
        const demuxResult = await api.downloadRecordingDemuxed({
            channel: 0,
            uid: uidForRecordings,
            fileName: event.fileName,
            streamType,
        });

        console.log(`Demuxed: ${demuxResult.annexB.length} bytes`);
        console.log(`VideoType: ${demuxResult.videoType}`);
        console.log(`Stats:`, demuxResult.stats);

        // Salva il demuxed
        await fs.writeFile("./downloads/raw_debug_demuxed.h264", demuxResult.annexB);
        console.log("\nSalvato: ./downloads/raw_debug_demuxed.h264");

        // Verifica primi byte demuxed
        console.log("\nPrimi 64 bytes demuxed:");
        console.log(hexDump(demuxResult.annexB, 4));

        // Cerca start codes H264
        console.log("\n=== H264 NAL ANALYSIS ===");
        const nalTypes = {
            1: "Non-IDR slice",
            5: "IDR slice",
            6: "SEI",
            7: "SPS",
            8: "PPS",
            9: "AUD",
        };

        let nalCount = { total: 0, byType: {} };
        for (let i = 0; i < demuxResult.annexB.length - 4; i++) {
            if (demuxResult.annexB[i] === 0 && demuxResult.annexB[i + 1] === 0 &&
                demuxResult.annexB[i + 2] === 0 && demuxResult.annexB[i + 3] === 1) {
                const nalType = demuxResult.annexB[i + 4] & 0x1f;
                nalCount.total++;
                nalCount.byType[nalType] = (nalCount.byType[nalType] || 0) + 1;
                if (nalCount.total <= 10) {
                    console.log(`NAL #${nalCount.total} @ 0x${i.toString(16)}: type ${nalType} (${nalTypes[nalType] || 'unknown'})`);
                }
            }
        }
        console.log(`\nTotale NAL units: ${nalCount.total}`);
        console.log("Per tipo:", Object.entries(nalCount.byType).map(([t, c]) => `${nalTypes[parseInt(t)] || `type ${t}`}: ${c}`).join(', '));

    } catch (e) {
        console.error("Errore:", e);
    } finally {
        await api.close();
    }
}

main().catch(console.error);
