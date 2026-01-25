#!/usr/bin/env node
/**
 * test-nvr-events-cover-download.mjs
 *
 * Replica del flusso catturato in "pcap/192.168.1.161 events+cover+download.pcapng"
 *
 * Questo script esegue la stessa sequenza di operazioni catturate nel PCAP:
 *
 * FLUSSO BAICHUAN:
 * ================
 * 1. Login (cmdId=1) - Autenticazione con l'NVR
 * 2. Per ogni channel (0, 1, 2):
 *    a. FileInfoList Open (cmdId=14) - Apre una ricerca per registrazioni
 *       - Usa l'UID specifico del channel (ottenuto da cmd 145 push o CGI)
 *       - Specifica intervallo temporale (oggi/ieri)
 *       - Specifica streamType=mainStream
 *    b. FileInfoList Get (cmdId=15) - Recupera i risultati paginati
 *    c. FileInfoList Close (cmdId=16) - Chiude l'handle di ricerca
 *    d. Se FileInfoList fallisce (400), prova findAlarmVideo (cmdId=272/273/274)
 *
 * 3. Download clip MP4:
 *    - FileInfoList Replay (cmdId=5) oppure
 *    - FileInfoList Download (cmdId=13) - Download binario del file
 *
 * 4. Download cover/snapshot:
 *    - CoverPreview (cmdId=298) - Ottiene un I-frame come anteprima
 *    - Restituisce dati H.264/H.265 raw
 *
 * UTILIZZO:
 * =========
 *   node fullTest/nvr/test-nvr-events-cover-download.mjs
 *
 * VARIABILI D'AMBIENTE:
 * ====================
 *   NVR_HOST       - IP dell'NVR (default: da .env)
 *   NVR_USERNAME   - Username (default: admin)
 *   NVR_PASSWORD   - Password (required)
 *   NVR_UID        - UID dell'NVR (opzionale)
 *   CHANNELS       - Lista canali (default: 0,1,2)
 *   DEBUG          - Abilita log dettagliati (1/true)
 *   OUT_DIR        - Directory output (default: ./downloads/nvr-events-cover-download)
 *
 * ESEMPI:
 * =======
 *   # Solo channel 0 e 1
 *   CHANNELS=0,1 node fullTest/nvr/test-nvr-events-cover-download.mjs
 *
 *   # Con debug
 *   DEBUG=1 node fullTest/nvr/test-nvr-events-cover-download.mjs
 *
 * OUTPUT:
 * =======
 *   - downloads/nvr-events-cover-download/ch{N}_{date}_clip_*.mp4
 *   - downloads/nvr-events-cover-download/ch{N}_{date}_cover_*.h264
 *   - downloads/nvr-events-cover-download/report.json
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
const NVR_UID = process.env.NVR_UID || "";

const CHANNELS = process.env.CHANNELS
    ? process.env.CHANNELS.split(",").map((s) => parseInt(s.trim(), 10))
    : [0, 1, 2];

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
const OUT_DIR = process.env.OUT_DIR || "./downloads/nvr-events-cover-download";

// ============================================================================
// Utilità
// ============================================================================

function getStartOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function getEndOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function formatDateForFile(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function sanitizeFileName(name) {
    return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║  NVR Events + Cover + Download Test                          ║");
    console.log("║  (Replica del flusso pcap/192.168.1.161 events+cover+download)║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log();

    if (!NVR_HOST || !NVR_USERNAME || !NVR_PASSWORD) {
        console.error("❌ Mancano le credenziali NVR! Configura NVR_HOST, NVR_USERNAME, NVR_PASSWORD in .env");
        process.exitCode = 1;
        return;
    }

    console.log(`📡 Host: ${NVR_HOST}`);
    console.log(`👤 Username: ${NVR_USERNAME}`);
    console.log(`🔑 Password: ${"*".repeat(NVR_PASSWORD.length)}`);
    console.log(`📺 Channels: ${CHANNELS.join(", ")}`);
    console.log(`📁 Output dir: ${OUT_DIR}`);
    console.log();

    // Crea la directory di output
    await fs.mkdir(OUT_DIR, { recursive: true });

    // Date di riferimento
    // Se DATE_OVERRIDE è impostato (formato: YYYY-MM-DD), usa quella data come "oggi"
    // Utile se la data del sistema è sbagliata o per testare date specifiche
    const dateOverride = process.env.DATE_OVERRIDE;
    const now = dateOverride ? new Date(dateOverride + "T12:00:00") : new Date();

    if (dateOverride) {
        console.log(`⚠️  DATE_OVERRIDE: usando ${dateOverride} come data di riferimento`);
    }

    const today = {
        start: getStartOfDay(now),
        end: now,
        label: "today",
        dateStr: formatDateForFile(now),
    };
    const yesterday = {
        start: getStartOfDay(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
        end: getEndOfDay(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
        label: "yesterday",
        dateStr: formatDateForFile(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    };

    console.log(`📅 Oggi: ${today.start.toISOString()} - ${today.end.toISOString()}`);
    console.log(`📅 Ieri: ${yesterday.start.toISOString()} - ${yesterday.end.toISOString()}`);
    console.log();

    const logger = createLogger({
        name: "nvr-events-cover-download",
        level: DEBUG ? "debug" : "info",
    });

    const results = [];

    for (const channel of CHANNELS) {
        console.log("━".repeat(70));
        console.log(`📺 CHANNEL ${channel}`);
        console.log("━".repeat(70));

        const result = {
            channel,
            todayEvents: [],
            yesterdayEvents: [],
            downloads: [],
        };

        // Crea un'istanza API per questo canale
        const api = new ReolinkBaichuanApi({
            host: NVR_HOST,
            username: NVR_USERNAME,
            password: NVR_PASSWORD,
            uid: NVR_UID || undefined,
            channel,
            logger,
            debugOptions: DEBUG ? { traceRecordings: true } : undefined,
        });

        try {
            // Login e attende che l'NVR invii i channel info (cmd 145 push)
            await api.login();

            // Aspetta un po' per ricevere il push 145 con gli UID delle camere
            // L'NVR invia automaticamente il push dopo il login
            await new Promise(r => setTimeout(r, 1500));

            // Ottieni l'UID della camera per questo channel dal push cache
            const channelInfo = api.getChannelInfoFromPushCache();
            const chInfo = channelInfo.get(channel);
            let cameraUid = chInfo?.uid;

            // Fallback: UIDs noti per questo NVR (da PCAP analysis)
            const KNOWN_CAMERA_UIDS = {
                0: "9527000HXOHJ142G",  // Videocamera lavanderia
                1: "952700093ABW14UB",
                2: "9527000HZ56U1ORU",
            };

            if (!cameraUid) {
                cameraUid = KNOWN_CAMERA_UIDS[channel];
                if (cameraUid) {
                    console.log(`  📷 Usando UID noto per channel ${channel}: ${cameraUid}`);
                } else {
                    console.log(`  ⚠️  Nessun UID trovato per channel ${channel}`);
                }
            } else {
                console.log(`  📷 Camera UID per channel ${channel}: ${cameraUid}`);
                if (chInfo.name) console.log(`     Nome: ${chInfo.name}`);
            }

            // Usa l'UID della camera (da push o noto), altrimenti fallback su NVR UID
            const uidForRecordings = cameraUid || NVR_UID || "9527000HY0GDYRIW";

            // ========================================================================
            // 1. Lista eventi di OGGI (prova entrambi i metodi)
            // ========================================================================
            console.log(`\n  🔍 Recupero eventi di OGGI (channel ${channel})...`);
            try {
                // NOTA: Il PCAP mostra che si usa subStream, non mainStream!
                // Prima proviamo con listRecordings (FileInfoList)
                let todayEventsRaw = await api.listRecordings({
                    channel,
                    uid: uidForRecordings,  // Usa UID della CAMERA (da push 145), non dell'NVR!
                    start: today.start,
                    end: today.end,
                    streamType: "subStream",  // PCAP mostra subStream, non mainStream
                    recordType: "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package",
                    timeoutMs: 30_000,
                });

                // Se non troviamo nulla, proviamo con findAlarmVideo
                if (todayEventsRaw.length === 0) {
                    console.log(`     📋 FileInfoList vuoto, provo findAlarmVideo...`);
                    try {
                        todayEventsRaw = await api.listAlarmVideosViaBaichuan({
                            channel,
                            start: today.start,
                            end: today.end,
                            streamType: "subStream",
                            timeoutMs: 30_000,
                        });
                    } catch {
                        // findAlarmVideo può non essere supportato
                        console.log(`     📋 findAlarmVideo non disponibile`);
                    }
                }

                result.todayEvents = todayEventsRaw.map((e) => ({
                    fileName: e.fileName,
                    startTime: e.startTime ?? null,
                    endTime: e.endTime ?? null,
                    recordType: e.recordType,
                }));

                console.log(`     ✅ Trovati ${result.todayEvents.length} eventi oggi`);
                if (result.todayEvents.length > 0) {
                    const first = result.todayEvents[0];
                    console.log(`        Primo evento: ${first.fileName}`);
                    if (first.startTime) {
                        console.log(`        Start: ${first.startTime.toISOString()}`);
                    }
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.log(`     ⚠️  Errore lista eventi oggi: ${msg}`);
            }

            // ========================================================================
            // 2. Lista eventi di IERI (prova entrambi i metodi)
            // ========================================================================
            console.log(`\n  🔍 Recupero eventi di IERI (channel ${channel})...`);
            try {
                // Prima proviamo con listRecordings (FileInfoList)
                let yesterdayEventsRaw = await api.listRecordings({
                    channel,
                    uid: uidForRecordings,  // Usa UID della CAMERA (da push 145), non dell'NVR!
                    start: yesterday.start,
                    end: yesterday.end,
                    streamType: "subStream",  // PCAP mostra subStream, non mainStream
                    recordType: "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package",
                    timeoutMs: 30_000,
                });

                // Se non troviamo nulla, proviamo con findAlarmVideo
                if (yesterdayEventsRaw.length === 0) {
                    console.log(`     📋 FileInfoList vuoto, provo findAlarmVideo...`);
                    try {
                        yesterdayEventsRaw = await api.listAlarmVideosViaBaichuan({
                            channel,
                            start: yesterday.start,
                            end: yesterday.end,
                            streamType: "subStream",
                            timeoutMs: 30_000,
                        });
                    } catch {
                        // findAlarmVideo può non essere supportato
                        console.log(`     📋 findAlarmVideo non disponibile`);
                    }
                }

                result.yesterdayEvents = yesterdayEventsRaw.map((e) => ({
                    fileName: e.fileName,
                    startTime: e.startTime ?? null,
                    endTime: e.endTime ?? null,
                    recordType: e.recordType,
                }));

                console.log(`     ✅ Trovati ${result.yesterdayEvents.length} eventi ieri`);
                if (result.yesterdayEvents.length > 0) {
                    const first = result.yesterdayEvents[0];
                    console.log(`        Primo evento: ${first.fileName}`);
                    if (first.startTime) {
                        console.log(`        Start: ${first.startTime.toISOString()}`);
                    }
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.log(`     ⚠️  Errore lista eventi ieri: ${msg}`);
            }

            // ========================================================================
            // 3. Download clip MP4 - primo evento di OGGI
            // ========================================================================
            if (result.todayEvents.length > 0) {
                const event = result.todayEvents[0];
                const outFileNameH264 = `ch${channel}_${today.dateStr}_clip_${sanitizeFileName(path.basename(event.fileName))}.h264`;
                const outFileNameMp4 = `ch${channel}_${today.dateStr}_clip_${sanitizeFileName(path.basename(event.fileName))}.mp4`;
                const outPathH264 = path.join(OUT_DIR, outFileNameH264);
                const outPathMp4 = path.join(OUT_DIR, outFileNameMp4);

                console.log(`\n  📥 Download clip OGGI (channel ${channel})...`);
                console.log(`     File: ${event.fileName}`);

                try {
                    // Usa downloadRecordingDemuxed per ottenere video Annex-B
                    const demuxResult = await api.downloadRecordingDemuxed({
                        channel,
                        uid: uidForRecordings,
                        fileName: event.fileName,
                        streamType: "subStream",
                        timeoutMs: 120_000,
                    });

                    // Salva H264 raw
                    await fs.writeFile(outPathH264, demuxResult.annexB);
                    console.log(`     📝 H264 raw: ${demuxResult.annexB.length} bytes (${demuxResult.videoType}, ${demuxResult.stats.keyframes} keyframes)`);

                    // Converti in MP4 con ffmpeg
                    const { spawn } = await import("node:child_process");
                    const demux = demuxResult.videoType === "H265" ? "hevc" : "h264";

                    await new Promise((resolve, reject) => {
                        const ff = spawn("ffmpeg", [
                            "-hide_banner", "-loglevel", "error", "-y",
                            "-fflags", "+genpts",
                            "-r", "15",
                            "-f", demux,
                            "-i", outPathH264,
                            "-c", "copy",
                            "-movflags", "frag_keyframe+empty_moov",
                            "-f", "mp4",
                            outPathMp4,
                        ]);
                        let stderr = "";
                        ff.stderr.on("data", (d) => (stderr += String(d)));
                        ff.on("close", (code) => {
                            if (code === 0) resolve();
                            else reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
                        });
                        ff.on("error", reject);
                    });

                    const stats = await fs.stat(outPathMp4);

                    result.downloads.push({
                        type: "clip",
                        day: "today",
                        fileName: event.fileName,
                        outputPath: outPathMp4,
                        success: true,
                        sizeBytes: stats.size,
                        videoType: demuxResult.videoType,
                        demuxStats: demuxResult.stats,
                    });

                    console.log(`     ✅ MP4 salvato: ${stats.size} bytes`);
                    console.log(`     Output: ${outPathMp4}`);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    result.downloads.push({
                        type: "clip",
                        day: "today",
                        fileName: event.fileName,
                        outputPath: outPathMp4,
                        success: false,
                        error: msg,
                    });
                    console.log(`     ⚠️  Errore download clip: ${msg}`);
                }
            }

            // ========================================================================
            // 4. Download clip MP4 - primo evento di IERI
            // ========================================================================
            if (result.yesterdayEvents.length > 0) {
                const event = result.yesterdayEvents[0];
                const outFileNameH264 = `ch${channel}_${yesterday.dateStr}_clip_${sanitizeFileName(path.basename(event.fileName))}.h264`;
                const outFileNameMp4 = `ch${channel}_${yesterday.dateStr}_clip_${sanitizeFileName(path.basename(event.fileName))}.mp4`;
                const outPathH264 = path.join(OUT_DIR, outFileNameH264);
                const outPathMp4 = path.join(OUT_DIR, outFileNameMp4);

                console.log(`\n  📥 Download clip IERI (channel ${channel})...`);
                console.log(`     File: ${event.fileName}`);

                try {
                    // Usa downloadRecordingDemuxed per ottenere video Annex-B
                    const demuxResult = await api.downloadRecordingDemuxed({
                        channel,
                        uid: uidForRecordings,
                        fileName: event.fileName,
                        streamType: "subStream",
                        timeoutMs: 120_000,
                    });

                    // Salva H264 raw
                    await fs.writeFile(outPathH264, demuxResult.annexB);
                    console.log(`     📝 H264 raw: ${demuxResult.annexB.length} bytes (${demuxResult.videoType}, ${demuxResult.stats.keyframes} keyframes)`);

                    // Converti in MP4 con ffmpeg
                    const { spawn } = await import("node:child_process");
                    const demux = demuxResult.videoType === "H265" ? "hevc" : "h264";

                    await new Promise((resolve, reject) => {
                        const ff = spawn("ffmpeg", [
                            "-hide_banner", "-loglevel", "error", "-y",
                            "-fflags", "+genpts",
                            "-r", "15",
                            "-f", demux,
                            "-i", outPathH264,
                            "-c", "copy",
                            "-movflags", "frag_keyframe+empty_moov",
                            "-f", "mp4",
                            outPathMp4,
                        ]);
                        let stderr = "";
                        ff.stderr.on("data", (d) => (stderr += String(d)));
                        ff.on("close", (code) => {
                            if (code === 0) resolve();
                            else reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
                        });
                        ff.on("error", reject);
                    });

                    const stats = await fs.stat(outPathMp4);

                    result.downloads.push({
                        type: "clip",
                        day: "yesterday",
                        fileName: event.fileName,
                        outputPath: outPathMp4,
                        success: true,
                        sizeBytes: stats.size,
                        videoType: demuxResult.videoType,
                        demuxStats: demuxResult.stats,
                    });

                    console.log(`     ✅ MP4 salvato: ${stats.size} bytes`);
                    console.log(`     Output: ${outPathMp4}`);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    result.downloads.push({
                        type: "clip",
                        day: "yesterday",
                        fileName: event.fileName,
                        outputPath: outPathMp4,
                        success: false,
                        error: msg,
                    });
                    console.log(`     ⚠️  Errore download clip: ${msg}`);
                }
            }

            // ========================================================================
            // 5. Download cover (snapshot) - primo evento di OGGI
            // ========================================================================
            if (result.todayEvents.length > 0 && result.todayEvents[0].startTime) {
                const event = result.todayEvents[0];
                const outFileName = `ch${channel}_${today.dateStr}_cover_${sanitizeFileName(path.basename(event.fileName))}.h264`;
                const outPath = path.join(OUT_DIR, outFileName);

                console.log(`\n  🖼️  Download cover OGGI (channel ${channel})...`);
                console.log(`     Time: ${event.startTime.toISOString()}`);
                console.log(`     Output: ${outPath}`);

                try {
                    const snapshot = await api.snapshotFromPlayback({
                        channel,
                        uid: uidForRecordings,
                        time: event.startTime,
                        snapType: "sub",
                        timeoutMs: 30_000,
                    });

                    await fs.writeFile(outPath, snapshot.frame);
                    const stats = await fs.stat(outPath);

                    result.downloads.push({
                        type: "cover",
                        day: "today",
                        fileName: event.fileName,
                        outputPath: outPath,
                        success: true,
                        sizeBytes: stats.size,
                    });

                    console.log(`     ✅ Salvato: ${stats.size} bytes (codec: ${snapshot.encoding})`);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    result.downloads.push({
                        type: "cover",
                        day: "today",
                        fileName: event.fileName,
                        outputPath: outPath,
                        success: false,
                        error: msg,
                    });
                    console.log(`     ⚠️  Errore download cover: ${msg}`);
                }
            }

            // ========================================================================
            // 6. Download cover (snapshot) - primo evento di IERI
            // ========================================================================
            if (result.yesterdayEvents.length > 0 && result.yesterdayEvents[0].startTime) {
                const event = result.yesterdayEvents[0];
                const outFileName = `ch${channel}_${yesterday.dateStr}_cover_${sanitizeFileName(path.basename(event.fileName))}.h264`;
                const outPath = path.join(OUT_DIR, outFileName);

                console.log(`\n  🖼️  Download cover IERI (channel ${channel})...`);
                console.log(`     Time: ${event.startTime.toISOString()}`);
                console.log(`     Output: ${outPath}`);

                try {
                    const snapshot = await api.snapshotFromPlayback({
                        channel,
                        uid: uidForRecordings,
                        time: event.startTime,
                        snapType: "sub",
                        timeoutMs: 30_000,
                    });

                    await fs.writeFile(outPath, snapshot.frame);
                    const stats = await fs.stat(outPath);

                    result.downloads.push({
                        type: "cover",
                        day: "yesterday",
                        fileName: event.fileName,
                        outputPath: outPath,
                        success: true,
                        sizeBytes: stats.size,
                    });

                    console.log(`     ✅ Salvato: ${stats.size} bytes (codec: ${snapshot.encoding})`);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    result.downloads.push({
                        type: "cover",
                        day: "yesterday",
                        fileName: event.fileName,
                        outputPath: outPath,
                        success: false,
                        error: msg,
                    });
                    console.log(`     ⚠️  Errore download cover: ${msg}`);
                }
            }
        } finally {
            // Chiudi la connessione
            try {
                await api.client.close();
            } catch {
                // ignore
            }
        }

        results.push(result);
    }

    // ============================================================================
    // Riepilogo finale
    // ============================================================================
    console.log("\n");
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║  RIEPILOGO                                                   ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");

    for (const r of results) {
        console.log(`\n📺 Channel ${r.channel}:`);
        console.log(`   Eventi oggi:     ${r.todayEvents.length}`);
        console.log(`   Eventi ieri:     ${r.yesterdayEvents.length}`);

        const successClips = r.downloads.filter((d) => d.type === "clip" && d.success);
        const failedClips = r.downloads.filter((d) => d.type === "clip" && !d.success);
        const successCovers = r.downloads.filter((d) => d.type === "cover" && d.success);
        const failedCovers = r.downloads.filter((d) => d.type === "cover" && !d.success);

        console.log(`   Clip scaricate:  ${successClips.length} ✅ / ${failedClips.length} ❌`);
        console.log(`   Cover scaricate: ${successCovers.length} ✅ / ${failedCovers.length} ❌`);

        if (successClips.length > 0 || successCovers.length > 0) {
            console.log(`   File salvati:`);
            for (const d of r.downloads.filter((d) => d.success)) {
                const sizeKb = d.sizeBytes ? `${(d.sizeBytes / 1024).toFixed(1)} KB` : "?";
                console.log(`     - ${path.basename(d.outputPath)} (${sizeKb})`);
            }
        }
    }

    // Salva il report JSON
    const reportPath = path.join(OUT_DIR, "report.json");
    await fs.writeFile(reportPath, JSON.stringify(results, null, 2));
    console.log(`\n📝 Report salvato: ${reportPath}`);

    // Exit code
    const totalSuccess = results.flatMap((r) => r.downloads).filter((d) => d.success).length;
    const totalFailed = results.flatMap((r) => r.downloads).filter((d) => !d.success).length;

    if (totalFailed > 0 && totalSuccess === 0) {
        process.exitCode = 1;
    }

    console.log("\n✨ Completato!");
}

main().catch((e) => {
    console.error("💥 Errore fatale:", e);
    process.exitCode = 1;
});
