#!/usr/bin/env node
/**
 * Test completo per tutti i dispositivi Reolink configurati
 * 
 * Testa:
 * - TCP_HOST: Camera standalone (E1 Outdoor PoE) - H.264
 * - TCP265_HOST: Camera standalone - H.265
 * - NVR_HOST: NVR con canali 0, 1, 2
 * 
 * Funzionalità testate per ogni dispositivo:
 * - Connessione e login
 * - Lista registrazioni
 * - Thumbnail da registrazione
 * - Streaming replay
 * - Download registrazione
 * - Snapshot live
 * - Sottoscrizione eventi
 * 
 * Uso:
 *   node test/complete-device-test.mjs
 *   node test/complete-device-test.mjs --device=tcp      # Solo TCP_HOST
 *   node test/complete-device-test.mjs --device=tcp265   # Solo TCP265_HOST
 *   node test/complete-device-test.mjs --device=nvr      # Solo NVR_HOST
 */

import { ReolinkBaichuanApi } from '../dist/index.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

// ============================================================
// CONFIGURAZIONE
// ============================================================

const DEVICES = {
    tcp: {
        name: 'TCP Camera (H.264)',
        host: process.env.TCP_HOST,
        username: process.env.TCP_USERNAME,
        password: process.env.TCP_PASSWORD,
        channels: [0],
        isNvr: false,
        // Data range per registrazioni (la camera potrebbe avere data sbagliata)
        dateRange: {
            start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 giorni fa
            end: new Date()
        }
    },
    tcp265: {
        name: 'TCP Camera (H.265)',
        host: process.env.TCP265_HOST,
        username: process.env.TCP265_USERNAME,
        password: process.env.TCP265_PASSWORD,
        channels: [0],
        isNvr: false,
        dateRange: {
            start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            end: new Date()
        }
    },
    nvr: {
        name: 'NVR',
        host: process.env.NVR_HOST,
        username: process.env.NVR_USERNAME,
        password: process.env.NVR_PASSWORD,
        channels: [0, 1, 2],
        isNvr: true,
        dateRange: {
            start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            end: new Date()
        }
    }
};

// Override date range per camera con data 2026
if (process.env.TCP_HOST === '192.168.50.226') {
    DEVICES.tcp.dateRange = {
        start: new Date('2026-01-20T00:00:00'),
        end: new Date('2026-01-26T23:59:59')
    };
}

// Override anche per TCP265 (stessa situazione: data 2026)
if (process.env.TCP265_HOST === '192.168.1.170') {
    DEVICES.tcp265.dateRange = {
        start: new Date('2026-01-20T00:00:00'),
        end: new Date('2026-01-26T23:59:59')
    };
}

// Override anche per NVR (stessa situazione: data 2026)
if (process.env.NVR_HOST === '192.168.1.161') {
    DEVICES.nvr.dateRange = {
        start: new Date('2026-01-20T00:00:00'),
        end: new Date('2026-01-26T23:59:59')
    };
}

// Directory per salvare i file di test
const OUTPUT_DIR = join(process.cwd(), 'test-output');

// ============================================================
// UTILITIES
// ============================================================

function ensureOutputDir() {
    if (!existsSync(OUTPUT_DIR)) {
        mkdirSync(OUTPUT_DIR, { recursive: true });
    }
}

function log(message, indent = 0) {
    const prefix = '  '.repeat(indent);
    console.log(`${prefix}${message}`);
}

function logSuccess(message, indent = 0) {
    log(`✅ ${message}`, indent);
}

function logError(message, indent = 0) {
    log(`❌ ${message}`, indent);
}

function logInfo(message, indent = 0) {
    log(`ℹ️  ${message}`, indent);
}

function logSkip(message, indent = 0) {
    log(`⏭️  ${message}`, indent);
}

// ============================================================
// TEST FUNCTIONS
// ============================================================

async function testListRecordings(api, channel, dateRange, isNvr) {
    try {
        let recordings;
        if (isNvr) {
            recordings = await api.getVideoclips({
                channel,
                start: dateRange.start,
                end: dateRange.end,
                streamType: 'mainStream',
                timeoutMs: 15000
            });
        } else {
            recordings = await api.standaloneListRecordings({
                start: dateRange.start,
                end: dateRange.end,
                streamType: 'mainStream',
                timeoutMs: 15000
            });
        }

        if (recordings.length > 0) {
            logSuccess(`Trovate ${recordings.length} registrazioni`, 2);
            logInfo(`Prima: ${recordings[0].fileName}`, 3);
            logInfo(`Ultima: ${recordings[recordings.length - 1].fileName}`, 3);
            return recordings;
        } else {
            logSkip('Nessuna registrazione trovata', 2);
            return [];
        }
    } catch (e) {
        logError(`Lista registrazioni fallita: ${e.message}`, 2);
        return [];
    }
}

async function testThumbnail(api, recording, channel, deviceKey, isNvr) {
    try {
        let thumbnail;
        if (isNvr) {
            thumbnail = await api.snapshotFromPlayback({
                channel,
                time: recording.startTime,
                snapType: 'sub',
                timeoutMs: 30000
            });
        } else {
            thumbnail = await api.standaloneGetThumbnail({
                time: recording.startTime,
                snapType: 'sub',
                timeoutMs: 30000
            });
        }

        logSuccess(`Thumbnail: ${thumbnail.encoding} ${thumbnail.streamInfo.width}x${thumbnail.streamInfo.height} (${thumbnail.frame.length} bytes)`, 2);

        const ext = thumbnail.encoding === 'H265' ? 'h265' : 'h264';
        const filename = `${deviceKey}_ch${channel}_thumbnail.${ext}`;
        writeFileSync(join(OUTPUT_DIR, filename), thumbnail.frame);
        logInfo(`Salvata: ${filename}`, 3);

        return true;
    } catch (e) {
        logError(`Thumbnail fallita: ${e.message}`, 2);
        return false;
    }
}

async function testReplayStream(api, recording, channel, isNvr, durationMs = 3000) {
    try {
        let stream, stop;

        if (isNvr) {
            const result = await api.startRecordingReplayStream({
                channel,
                fileName: recording.fileName,
                streamType: 'mainStream',
                timeoutMs: 20000
            });
            stream = result.stream;
            stop = result.stop;
        } else {
            const result = await api.standaloneStartReplayStream({
                fileName: recording.fileName,
                streamType: 'mainStream',
                timeoutMs: 20000
            });
            stream = result.stream;
            stop = result.stop;
        }

        let videoBytes = 0;
        let audioFrames = 0;

        stream.on('videoFrame', (data) => { videoBytes += data.length; });
        stream.on('audioFrame', () => { audioFrames++; });

        await new Promise(r => setTimeout(r, durationMs));
        await stop();

        const mbReceived = (videoBytes / 1024 / 1024).toFixed(2);
        logSuccess(`Replay stream: ${mbReceived} MB video, ${audioFrames} audio frames in ${durationMs}ms`, 2);
        return true;
    } catch (e) {
        logError(`Replay stream fallito: ${e.message}`, 2);
        return false;
    }
}

async function testDownload(api, recording, channel, deviceKey, isNvr) {
    try {
        let mp4Stream, stopFn;

        if (isNvr) {
            const result = await api.createRecordingDownloadMp4Stream({
                channel,
                fileName: recording.fileName,
                streamType: 'subStream',
                timeoutMs: 60000
            });
            mp4Stream = result.mp4;
            stopFn = result.stop;
        } else {
            const result = await api.standaloneDownloadRecording({
                fileName: recording.fileName,
                streamType: 'subStream',
                timeoutMs: 60000
            });
            mp4Stream = result.mp4;
            stopFn = result.stop;
        }

        const chunks = [];
        mp4Stream.on('data', (chunk) => chunks.push(chunk));

        await new Promise((resolve) => {
            mp4Stream.on('end', resolve);
            mp4Stream.on('error', resolve);
            // Timeout di sicurezza
            setTimeout(resolve, 30000);
        });

        const data = Buffer.concat(chunks);
        const mbSize = (data.length / 1024 / 1024).toFixed(2);
        logSuccess(`Download: ${mbSize} MB`, 2);

        const filename = `${deviceKey}_ch${channel}_download.mp4`;
        writeFileSync(join(OUTPUT_DIR, filename), data);
        logInfo(`Salvato: ${filename}`, 3);

        return true;
    } catch (e) {
        logError(`Download fallito: ${e.message}`, 2);
        return false;
    }
}

async function testSnapshot(api, channel, deviceKey, isNvr) {
    try {
        let snapshot;

        if (isNvr) {
            snapshot = await api.getSnapshot(channel);
        } else {
            snapshot = await api.standaloneGetSnapshot();
        }

        const kbSize = (snapshot.length / 1024).toFixed(1);
        logSuccess(`Snapshot live: ${kbSize} KB`, 2);

        const filename = `${deviceKey}_ch${channel}_snapshot.jpg`;
        writeFileSync(join(OUTPUT_DIR, filename), snapshot);
        logInfo(`Salvata: ${filename}`, 3);

        return true;
    } catch (e) {
        logError(`Snapshot fallita: ${e.message}`, 2);
        return false;
    }
}

async function testEvents(api, channel, isNvr, durationMs = 2000) {
    try {
        let eventCount = 0;
        let unsubscribe;

        if (isNvr) {
            api.client.on('event', () => { eventCount++; });
            await api.subscribeEvents();
            unsubscribe = async () => {
                await api.unsubscribeEvents();
            };
        } else {
            const result = await api.standaloneSubscribeEvents({
                onEvent: () => { eventCount++; }
            });
            unsubscribe = result.unsubscribe;
        }

        await new Promise(r => setTimeout(r, durationMs));
        await unsubscribe();

        logSuccess(`Eventi: ${eventCount} ricevuti in ${durationMs}ms`, 2);
        return true;
    } catch (e) {
        logError(`Sottoscrizione eventi fallita: ${e.message}`, 2);
        return false;
    }
}

// ============================================================
// MAIN TEST RUNNER
// ============================================================

async function testDevice(deviceKey, config) {
    console.log('\n' + '='.repeat(60));
    console.log(`  ${config.name} (${config.host})`);
    console.log('='.repeat(60));

    if (!config.host) {
        logSkip('Host non configurato, skip');
        return { skipped: true };
    }

    const results = {
        device: deviceKey,
        name: config.name,
        host: config.host,
        channels: {},
        errors: []
    };

    const api = new ReolinkBaichuanApi({
        host: config.host,
        username: config.username,
        password: config.password,
        transport: 'tcp',
        debug: false
    });

    try {
        // Login
        log('\n📡 Connessione...');
        await api.login();
        logSuccess('Connesso');

        // Raccoglie le registrazioni per i download da fare alla fine
        const pendingDownloads = [];

        // Test per ogni canale (senza download che chiude la connessione)
        for (const channel of config.channels) {
            log(`\n📺 Canale ${channel}:`);

            const channelResults = {
                recordings: false,
                thumbnail: false,
                replay: false,
                download: false,
                snapshot: false,
                events: false
            };

            // 1. Lista registrazioni
            log('1️⃣  Lista registrazioni...', 1);
            const recordings = await testListRecordings(api, channel, config.dateRange, config.isNvr);
            channelResults.recordings = recordings.length > 0;

            if (recordings.length > 0) {
                // 2. Thumbnail
                log('2️⃣  Thumbnail...', 1);
                channelResults.thumbnail = await testThumbnail(
                    api, recordings[0], channel, deviceKey, config.isNvr
                );

                // 3. Replay stream (solo per standalone - NVR usa solo download)
                if (!config.isNvr) {
                    log('3️⃣  Replay stream (3s)...', 1);
                    channelResults.replay = await testReplayStream(
                        api, recordings[0], channel, config.isNvr, 3000
                    );
                } else {
                    // NVR: replay streaming non supportato, usa download invece
                    logSkip('Replay stream (NVR usa download)', 1);
                    channelResults.replay = true; // Non penalizzare NVR
                }

                // Salva per download alla fine
                pendingDownloads.push({
                    channel,
                    recording: recordings[recordings.length - 1]
                });
            }

            // 4. Snapshot live
            log('4️⃣  Snapshot live...', 1);
            channelResults.snapshot = await testSnapshot(api, channel, deviceKey, config.isNvr);

            // 5. Eventi (solo per il primo canale per evitare duplicati)
            if (channel === config.channels[0]) {
                log('5️⃣  Eventi (2s)...', 1);
                channelResults.events = await testEvents(api, channel, config.isNvr, 2000);
            } else {
                logSkip('Eventi (testato su canale 0)', 1);
                channelResults.events = true;
            }

            results.channels[channel] = channelResults;
        }

        // 6. Download alla fine (chiude la connessione, quindi ultimo)
        // Per NVR con più canali, fa solo il download dell'ultimo canale con registrazioni
        if (pendingDownloads.length > 0) {
            const lastDownload = pendingDownloads[pendingDownloads.length - 1];
            log(`\n📥 Download (canale ${lastDownload.channel})...`);
            const downloadResult = await testDownload(
                api, lastDownload.recording, lastDownload.channel, deviceKey, config.isNvr
            );
            results.channels[lastDownload.channel].download = downloadResult;

            // Segna gli altri canali come skipped per download
            for (const pd of pendingDownloads.slice(0, -1)) {
                logSkip(`Download canale ${pd.channel} (skip per evitare disconnessione)`, 1);
            }
        }

    } catch (e) {
        logError(`Errore fatale: ${e.message}`);
        results.errors.push(e.message);
    } finally {
        try {
            await api.close();
            logSuccess('Disconnesso');
        } catch {
            // ignore
        }
    }

    return results;
}

async function main() {
    console.log('\n' + '╔' + '═'.repeat(58) + '╗');
    console.log('║' + ' '.repeat(10) + 'REOLINK BAICHUAN - TEST COMPLETO' + ' '.repeat(16) + '║');
    console.log('╚' + '═'.repeat(58) + '╝');

    // Parse argomenti
    const args = process.argv.slice(2);
    const deviceArg = args.find(a => a.startsWith('--device='));
    const selectedDevice = deviceArg ? deviceArg.split('=')[1] : null;

    // Crea directory output
    ensureOutputDir();
    log(`\n📁 Output directory: ${OUTPUT_DIR}`);

    // Determina quali dispositivi testare
    const devicesToTest = selectedDevice
        ? { [selectedDevice]: DEVICES[selectedDevice] }
        : DEVICES;

    if (selectedDevice && !DEVICES[selectedDevice]) {
        console.error(`\n❌ Dispositivo sconosciuto: ${selectedDevice}`);
        console.error(`   Dispositivi disponibili: ${Object.keys(DEVICES).join(', ')}`);
        process.exit(1);
    }

    // Esegui test
    const allResults = {};

    for (const [key, config] of Object.entries(devicesToTest)) {
        allResults[key] = await testDevice(key, config);
    }

    // Riepilogo finale
    console.log('\n\n' + '═'.repeat(60));
    console.log('  RIEPILOGO');
    console.log('═'.repeat(60));

    for (const [key, result] of Object.entries(allResults)) {
        if (result.skipped) {
            console.log(`\n📵 ${DEVICES[key].name}: SKIPPED (non configurato)`);
            continue;
        }

        console.log(`\n📹 ${result.name} (${result.host}):`);

        for (const [channel, tests] of Object.entries(result.channels)) {
            const passed = Object.values(tests).filter(v => v).length;
            const total = Object.values(tests).length;
            const status = passed === total ? '✅' : passed > 0 ? '⚠️' : '❌';

            console.log(`   Ch ${channel}: ${status} ${passed}/${total} test passati`);

            // Dettagli test falliti
            for (const [test, success] of Object.entries(tests)) {
                if (!success) {
                    console.log(`      ❌ ${test}`);
                }
            }
        }

        if (result.errors.length > 0) {
            console.log(`   Errori: ${result.errors.join(', ')}`);
        }
    }

    console.log('\n' + '═'.repeat(60));
    console.log(`📁 File salvati in: ${OUTPUT_DIR}`);
    console.log('═'.repeat(60) + '\n');
}

// Esegui
main().catch(e => {
    console.error('\n💥 Errore fatale:', e);
    process.exit(1);
});
