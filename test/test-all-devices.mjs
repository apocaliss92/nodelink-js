#!/usr/bin/env node
/**
 * Complete test for all devices: NVR channels 0,1,2 and standalone cameras
 * Tests: list recordings, replay stream, download, thumbnail
 * Uses dates: 16.01.2026 and 24.01.2026
 */
import { ReolinkBaichuanApi } from '../dist/index.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'artifacts');
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

// Date ranges to search (16.01 and 24.01.2026, plus 20.01 for NVR)
const DATE_RANGES = [
    { start: new Date('2026-01-16T00:00:00'), end: new Date('2026-01-16T23:59:59'), label: '16.01.2026' },
    { start: new Date('2026-01-20T00:00:00'), end: new Date('2026-01-20T23:59:59'), label: '20.01.2026' },
    { start: new Date('2026-01-24T00:00:00'), end: new Date('2026-01-24T23:59:59'), label: '24.01.2026' },
];

// Device configurations
const DEVICES = [
    {
        name: 'NVR',
        host: '192.168.1.161',
        passEnv: 'NVR_PASSWORD',
        isNvr: true,
        channels: [0, 1, 2],
    },
    {
        name: 'E1 Outdoor PoE (TCP265)',
        host: '192.168.1.170',
        passEnv: 'TCP265_PASSWORD',
        isNvr: false,
        channels: [0],
    },
    {
        name: 'TrackMix PoE',
        host: '192.168.50.226',
        passEnv: 'TCP_PASSWORD',
        isNvr: false,
        channels: [0],
    },
];

function log(msg, indent = 0) {
    console.log('  '.repeat(indent) + msg);
}

async function testReplayStream(api, recording, channel, isNvr, deviceKey) {
    try {
        log(`Testing replay stream...`, 3);
        const { stream, stop } = await api.startRecordingReplayStream({
            channel,
            fileName: recording.fileName,
            streamType: 'mainStream',
            timeoutMs: 20000
        });

        let frames = 0;
        let bytes = 0;
        const chunks = [];

        stream.on('videoFrame', (data) => {
            frames++;
            bytes += data.length;
            if (chunks.length < 10) chunks.push(data); // Save first 10 frames
        });

        await new Promise(r => setTimeout(r, 3000));
        await stop();

        if (frames > 0) {
            const filename = `${deviceKey}_ch${channel}_replay_sample.h265`;
            writeFileSync(join(OUTPUT_DIR, filename), Buffer.concat(chunks));
            log(`✓ Replay: ${frames} frames, ${(bytes / 1024).toFixed(0)} KB in 3s -> ${filename}`, 3);
            return true;
        } else {
            log(`✗ Replay: no frames received`, 3);
            return false;
        }
    } catch (e) {
        log(`✗ Replay failed: ${e.message}`, 3);
        return false;
    }
}

async function testDownload(api, recording, channel, isNvr, deviceKey) {
    try {
        log(`Testing download...`, 3);

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
        let bytes = 0;

        mp4Stream.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes < 500000) chunks.push(chunk); // Save first 500KB
        });

        await new Promise(r => setTimeout(r, 5000));
        await stopFn();

        if (bytes > 0) {
            const filename = `${deviceKey}_ch${channel}_download.mp4`;
            writeFileSync(join(OUTPUT_DIR, filename), Buffer.concat(chunks));
            log(`✓ Download: ${(bytes / 1024).toFixed(0)} KB in 5s -> ${filename}`, 3);
            return true;
        } else {
            log(`✗ Download: no data received`, 3);
            return false;
        }
    } catch (e) {
        log(`✗ Download failed: ${e.message}`, 3);
        return false;
    }
}

async function testThumbnail(api, recording, channel, isNvr, deviceKey) {
    try {
        log(`Testing thumbnail...`, 3);

        let thumbnail;
        if (isNvr) {
            thumbnail = await api.getRecordingThumbnail({
                channel,
                time: recording.startTime,
                streamType: 'sub',
                timeoutMs: 30000
            });
        } else {
            thumbnail = await api.standaloneGetThumbnail({
                time: recording.startTime,
                snapType: 'sub',
                timeoutMs: 30000
            });
        }

        if (thumbnail && thumbnail.frame && thumbnail.frame.length > 0) {
            const ext = thumbnail.encoding === 'H265' ? 'h265' : 'h264';
            const filename = `${deviceKey}_ch${channel}_thumbnail.${ext}`;
            writeFileSync(join(OUTPUT_DIR, filename), thumbnail.frame);
            log(`✓ Thumbnail: ${thumbnail.encoding} ${thumbnail.streamInfo?.width || '?'}x${thumbnail.streamInfo?.height || '?'} (${thumbnail.frame.length} bytes) -> ${filename}`, 3);
            return true;
        } else {
            log(`✗ Thumbnail: no data`, 3);
            return false;
        }
    } catch (e) {
        log(`✗ Thumbnail failed: ${e.message}`, 3);
        return false;
    }
}

async function testDevice(device) {
    const password = process.env[device.passEnv];
    if (!password) {
        log(`⚠ Skipping ${device.name} - no password (${device.passEnv} not set)`, 1);
        return { device: device.name, skipped: true };
    }

    log(`\n${'='.repeat(60)}`, 0);
    log(`Testing: ${device.name} (${device.host})`, 0);
    log(`${'='.repeat(60)}`, 0);

    const api = new ReolinkBaichuanApi({
        host: device.host,
        port: 9000,
        username: 'admin',
        password
    });

    const results = {
        device: device.name,
        host: device.host,
        channels: {},
        errors: []
    };

    try {
        await api.login();
        log(`✓ Connected`, 1);

        for (const channel of device.channels) {
            log(`\n--- Channel ${channel} ---`, 1);

            const channelResults = {
                recordings: 0,
                replay: false,
                download: false,
                thumbnail: false
            };

            // Try each date range
            let recording = null;
            for (const dateRange of DATE_RANGES) {
                try {
                    log(`Searching recordings for ${dateRange.label}...`, 2);

                    let recordings;
                    if (device.isNvr) {
                        // NVR uses getVideoclips
                        recordings = await api.getVideoclips({
                            channel,
                            start: dateRange.start,
                            end: dateRange.end,
                            timeoutMs: 15000
                        }) || [];
                    } else {
                        recordings = await api.standaloneListRecordings({
                            start: dateRange.start,
                            end: dateRange.end,
                            timeoutMs: 15000
                        }) || [];
                    }

                    if (recordings.length > 0) {
                        log(`✓ Found ${recordings.length} recordings on ${dateRange.label}`, 2);
                        channelResults.recordings += recordings.length;
                        if (!recording) recording = recordings[0];
                    } else {
                        log(`No recordings on ${dateRange.label}`, 2);
                    }
                } catch (e) {
                    log(`✗ List recordings failed for ${dateRange.label}: ${e.message}`, 2);
                }
            }

            if (recording) {
                log(`\nUsing: ${recording.fileName}`, 2);
                const deviceKey = device.host.replace(/\./g, '_');

                // Test replay stream
                channelResults.replay = await testReplayStream(api, recording, channel, device.isNvr, deviceKey);

                // Test download
                channelResults.download = await testDownload(api, recording, channel, device.isNvr, deviceKey);

                // Test thumbnail
                channelResults.thumbnail = await testThumbnail(api, recording, channel, device.isNvr, deviceKey);
            } else {
                log(`⚠ No recordings found for channel ${channel}`, 2);
            }

            results.channels[channel] = channelResults;
        }

        await api.close();
        log(`\n✓ Disconnected`, 1);

    } catch (e) {
        results.errors.push(e.message);
        log(`\n✗ Error: ${e.message}`, 1);
        try { await api.close(); } catch { }
    }

    return results;
}

async function main() {
    console.log('========================================');
    console.log('  COMPLETE DEVICE TEST');
    console.log('  Dates: 16.01.2026, 24.01.2026');
    console.log('========================================\n');

    const allResults = [];

    for (const device of DEVICES) {
        const result = await testDevice(device);
        allResults.push(result);
    }

    // Summary
    console.log('\n\n========================================');
    console.log('  SUMMARY');
    console.log('========================================');

    for (const result of allResults) {
        if (result.skipped) {
            console.log(`\n${result.device}: SKIPPED`);
            continue;
        }

        console.log(`\n${result.device} (${result.host}):`);
        for (const [ch, data] of Object.entries(result.channels)) {
            const status = [];
            if (data.recordings > 0) status.push(`${data.recordings} recs`);
            if (data.replay) status.push('✓replay');
            if (data.download) status.push('✓download');
            if (data.thumbnail) status.push('✓thumbnail');
            console.log(`  Channel ${ch}: ${status.join(', ') || 'no data'}`);
        }
        if (result.errors.length > 0) {
            console.log(`  Errors: ${result.errors.join(', ')}`);
        }
    }

    console.log(`\nOutput files saved to: ${OUTPUT_DIR}`);
}

main().catch(console.error);
