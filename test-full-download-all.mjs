#!/usr/bin/env node
/**
 * Full test: download recordings from all cameras (TCP, TCP265, NVR ch 0,1,2)
 * Tests the new unified getRecordingVideo() API with audio support.
 */

import "dotenv/config";
import { ReolinkBaichuanApi, createLogger } from "./dist/index.js";
import { writeFileSync, mkdirSync } from "node:fs";

// Configurazione telecamere
const cameras = [];

// TCP camera (H.264)
if (process.env.TCP_HOST && process.env.TCP_PASSWORD) {
    cameras.push({
        name: "TCP (H.264)",
        host: process.env.TCP_HOST,
        username: process.env.TCP_USERNAME || "admin",
        password: process.env.TCP_PASSWORD,
        channels: [0],
        isNvr: false
    });
}

// TCP265 camera (H.265)
if (process.env.TCP265_HOST && process.env.TCP265_PASSWORD) {
    cameras.push({
        name: "TCP265 (H.265)",
        host: process.env.TCP265_HOST,
        username: process.env.TCP265_USERNAME || "admin",
        password: process.env.TCP265_PASSWORD,
        channels: [0],
        isNvr: false
    });
}

// NVR (Home Hub) - channels 0, 1, 2
if (process.env.NVR_HOST && process.env.NVR_PASSWORD) {
    cameras.push({
        name: "NVR (Home Hub)",
        host: process.env.NVR_HOST,
        username: process.env.NVR_USERNAME || "admin",
        password: process.env.NVR_PASSWORD,
        channels: [0, 1, 2],
        isNvr: true
    });
}

if (cameras.length === 0) {
    console.error("❌ Nessuna telecamera configurata!");
    console.error("   Imposta le variabili d'ambiente:");
    console.error("   - TCP_HOST, TCP_PASSWORD");
    console.error("   - TCP265_HOST, TCP265_PASSWORD");
    console.error("   - NVR_HOST, NVR_PASSWORD");
    process.exit(1);
}

const logger = createLogger({ name: "full-test", level: "info" });
const outputDir = "./downloads/full-test";
mkdirSync(outputDir, { recursive: true });

// Risultati
const results = [];

async function testCamera(cam) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`📹 ${cam.name} - ${cam.host}`);
    console.log("=".repeat(60));

    const api = new ReolinkBaichuanApi({
        host: cam.host,
        username: cam.username,
        password: cam.password,
        logger
    });

    try {
        // 1. Info dispositivo
        const info = await api.getInfo();
        console.log(`✓ Dispositivo: ${info.devName || "N/A"} - FW: ${info.firmwareVersion || "N/A"}`);

        // 2. Test ogni canale
        for (const channel of cam.channels) {
            console.log(`\n  📺 Canale ${channel}:`);

            try {
                // Cerca registrazioni: prima oggi, poi 22 gennaio, poi ultimi 7 giorni
                const today = new Date();
                let recordings = await api.getVideoclips({
                    channel,
                    start: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0),
                    end: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59),
                    streamType: "mainStream"
                });

                // Se non trova oggi, prova il 22 gennaio
                if (recordings.length === 0) {
                    console.log(`     Nessuna registrazione oggi, provo 22 gennaio...`);
                    recordings = await api.getVideoclips({
                        channel,
                        start: new Date(2026, 0, 22, 0, 0, 0),
                        end: new Date(2026, 0, 22, 23, 59, 59),
                        streamType: "mainStream"
                    });
                }

                // Se ancora niente, prova ultimi 7 giorni
                if (recordings.length === 0) {
                    console.log(`     Nessuna registrazione il 22, provo ultimi 7 giorni...`);
                    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
                    recordings = await api.getVideoclips({
                        channel,
                        start: weekAgo,
                        end: today,
                        streamType: "mainStream"
                    });
                }

                console.log(`     Registrazioni trovate: ${recordings.length}`);

                if (recordings.length === 0) {
                    results.push({
                        camera: cam.name,
                        channel,
                        status: "⚠️ SKIP",
                        reason: "Nessuna registrazione",
                        mp4Size: 0
                    });
                    continue;
                }

                // Prendi la prima registrazione
                const rec = recordings[0];
                const fileName = rec.fileName || rec.name || rec.id;
                console.log(`     File: ${fileName}`);

                // Prima prova download diretto, poi fallback a streaming
                const startTime = Date.now();
                let mp4, stats, method = "download";

                try {
                    // Prova il download diretto
                    const result = await api.getRecordingVideo({
                        channel,
                        fileName,
                        timeoutMs: 120_000
                    });
                    mp4 = result.mp4;
                    stats = result.stats;
                } catch (_) {
                    // Fallback a streaming se il download fallisce
                    console.log(`     ⚠️  Download fallito, provo streaming...`);
                    method = "streaming";
                    const result = await api.getRecordingVideoViaStreaming({
                        channel,
                        fileName,
                        maxDurationMs: 120_000,
                        idleTimeoutMs: 5_000
                    });
                    mp4 = result.mp4;
                    stats = {
                        ...result.stats,
                        hasAudio: false,
                        audioCodec: null,
                        bytesIn: 0,
                        videoBytesOut: mp4.length,
                        audioBytesOut: 0,
                        audioPackets: 0
                    };
                }

                const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

                // Salva file MP4
                const safeName = cam.name.replace(/[^a-zA-Z0-9]/g, "_");
                const mp4Path = `${outputDir}/${safeName}_ch${channel}.mp4`;
                writeFileSync(mp4Path, mp4);

                console.log(`     ✅ MP4: ${(mp4.length / 1024 / 1024).toFixed(2)} MB (${method})`);
                console.log(`     📊 Video: ${stats.videoCodec}, Audio: ${stats.hasAudio ? stats.audioCodec : "nessuno"}`);
                console.log(`     ⏱️  FPS: ${stats.fps} | Durata: ${stats.durationSeconds.toFixed(1)}s | Keyframes: ${stats.keyframes}`);
                console.log(`     📁 Salvato: ${mp4Path}`);

                results.push({
                    camera: cam.name,
                    channel,
                    status: "✅ OK",
                    method,
                    mp4Size: mp4.length,
                    videoCodec: stats.videoCodec,
                    audioCodec: stats.hasAudio ? stats.audioCodec : "none",
                    fps: stats.fps,
                    duration: stats.durationSeconds,
                    keyframes: stats.keyframes,
                    elapsedSec,
                    file: mp4Path
                });

            } catch (err) {
                console.log(`     ❌ Errore: ${err.message}`);
                results.push({
                    camera: cam.name,
                    channel,
                    status: "❌ FAIL",
                    reason: err.message,
                    mp4Size: 0
                });
            }
        }

    } catch (err) {
        console.log(`❌ Errore connessione: ${err.message}`);
        for (const channel of cam.channels) {
            results.push({
                camera: cam.name,
                channel,
                status: "❌ FAIL",
                reason: `Connessione: ${err.message}`,
                mp4Size: 0
            });
        }
    } finally {
        await api.close().catch(() => { });
    }
}

async function main() {
    console.log("🚀 Test completo download registrazioni");
    console.log(`📋 Telecamere configurate: ${cameras.length}`);
    cameras.forEach(c => console.log(`   - ${c.name}: ${c.host} (ch: ${c.channels.join(",")})`));

    for (const cam of cameras) {
        await testCamera(cam);
    }

    // Riepilogo finale
    console.log(`\n${"=".repeat(60)}`);
    console.log("📊 RIEPILOGO FINALE");
    console.log("=".repeat(60));

    console.log("\n| Camera | Ch | Status | MP4 Size | Video | Audio | FPS | Duration |");
    console.log("|--------|----:|--------|------:|-------|-------|----:|-------:|");

    for (const r of results) {
        const mp4MB = ((r.mp4Size || 0) / 1024 / 1024).toFixed(2);
        const video = r.videoCodec || "-";
        const audio = r.audioCodec || "-";
        const fps = r.fps || "-";
        const dur = r.duration ? `${r.duration.toFixed(1)}s` : "-";
        console.log(`| ${r.camera.padEnd(15)} | ${r.channel} | ${r.status} | ${mp4MB} MB | ${video} | ${audio} | ${fps} | ${dur} |`);
    }

    const successCount = results.filter(r => r.status === "✅ OK").length;
    const failCount = results.filter(r => r.status === "❌ FAIL").length;
    const skipCount = results.filter(r => r.status === "⚠️ SKIP").length;

    console.log(`\n✅ Successi: ${successCount} | ❌ Falliti: ${failCount} | ⚠️ Saltati: ${skipCount}`);
    console.log(`📁 Output: ${outputDir}/`);

    if (failCount > 0) {
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error("💥 Errore fatale:", err);
    process.exitCode = 1;
});
