#!/usr/bin/env node
/**
 * Esempio di utilizzo semplice dell'API per scaricare registrazioni.
 * 
 * Questo esempio mostra come:
 * 1. Cercare le registrazioni disponibili
 * 2. Scaricare una registrazione
 * 3. Salvare il file video
 * 
 * USO:
 *   node examples/download-recording.mjs
 * 
 * VARIABILI D'AMBIENTE:
 *   TCP_HOST     - IP della camera (default: 192.168.1.170)
 *   TCP_USERNAME - Username (default: admin)
 *   TCP_PASSWORD - Password (obbligatoria)
 */

import "dotenv/config";
import { ReolinkBaichuanApi, createLogger } from "../dist/index.js";
import { writeFileSync, mkdirSync } from "node:fs";

// Configurazione
const HOST = process.env.TCP_HOST || "192.168.1.170";
const USERNAME = process.env.TCP_USERNAME || "admin";
const PASSWORD = process.env.TCP_PASSWORD || "";

if (!PASSWORD) {
    console.error("Errore: TCP_PASSWORD non impostata");
    process.exit(1);
}

// Logger opzionale (può essere omesso per output pulito)
const logger = createLogger({ name: "example", level: "info" });

async function main() {
    // Crea l'istanza API
    const api = new ReolinkBaichuanApi({
        host: HOST,
        username: USERNAME,
        password: PASSWORD,
        logger
    });

    try {
        console.log(`\nConnessione a ${HOST}...`);

        // 1. Ottieni info dispositivo
        const info = await api.getInfo();
        console.log(`✓ Dispositivo: ${info.devName || "Camera"}`);
        console.log(`  Firmware: ${info.firmwareVersion}`);

        // 2. Cerca registrazioni di oggi
        const today = new Date();
        console.log(`\nCerco registrazioni del ${today.toLocaleDateString()}...`);

        const recordings = await api.getVideoclips({
            channel: 0,
            start: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0),
            end: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59),
            streamType: "mainStream"
        });

        console.log(`✓ Trovate ${recordings.length} registrazioni`);

        if (recordings.length === 0) {
            console.log("Nessuna registrazione trovata.");
            return;
        }

        // 3. Scarica la prima registrazione come MP4 già muxato
        const recording = recordings[0];
        const fileName = recording.fileName || recording.name || recording.id;
        console.log(`\nScarico: ${fileName}`);

        const startTime = Date.now();
        const { mp4, stats } = await api.getRecordingVideo({
            channel: 0,
            fileName: fileName,
            timeoutMs: 120_000
        });

        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✓ Scaricati ${(mp4.length / 1024 / 1024).toFixed(2)} MB MP4 in ${elapsedSec}s`);
        console.log(`  Video: ${stats.videoCodec}, FPS: ${stats.fps}, Keyframes: ${stats.keyframes}`);
        console.log(`  Audio: ${stats.hasAudio ? stats.audioCodec : "nessuno"}`);
        console.log(`  Durata: ${stats.durationSeconds.toFixed(1)}s`);

        // 4. Salva il file MP4
        mkdirSync("./output", { recursive: true });
        const mp4Path = "./output/recording.mp4";
        writeFileSync(mp4Path, mp4);
        console.log(`\n✓ MP4 salvato: ${mp4Path}`);
        console.log("\nFatto!");

    } catch (err) {
        console.error(`\n✗ Errore: ${err.message}`);
        process.exit(1);
    } finally {
        await api.close();
    }
}

main();
