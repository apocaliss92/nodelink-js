#!/usr/bin/env node
/**
 * Test completo per tutti i dispositivi
 * - List recordings
 * - Download con demux a MP4 visualizzabile
 * - Thumbnail JPEG estratto con ffmpeg
 * 
 * Output: test/artifacts/*.mp4 e *.jpg
 */
import { ReolinkBaichuanApi } from './dist/index.js';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'test', 'artifacts');
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

const PASSWORD = process.env.TCP_PASSWORD;

// Device con date specifiche
const DEVICES = [
    {
        name: 'E1_Outdoor_PoE',
        host: '192.168.1.170',
        isNvr: false,
        channels: [0],
        startDate: new Date('2026-01-22T00:00:00'),
        endDate: new Date('2026-01-22T23:59:59')
    },
    {
        name: 'TrackMix_PoE',
        host: '192.168.50.226',
        isNvr: false,
        channels: [0],
        startDate: new Date('2026-01-01T00:00:00'),
        endDate: new Date('2026-01-31T23:59:59')
    },
    {
        name: 'NVR',
        host: '192.168.1.161',
        isNvr: true,
        channels: [0, 1, 2],
        channelDates: {
            0: { start: new Date('2026-01-01T00:00:00'), end: new Date('2026-01-31T23:59:59') },
            1: { start: new Date('2026-01-01T00:00:00'), end: new Date('2026-01-31T23:59:59') },
            2: { start: new Date('2026-01-16T00:00:00'), end: new Date('2026-01-16T23:59:59') }
        }
    },
];

function getDateRange(device, channel) {
    if (device.channelDates && device.channelDates[channel]) {
        return device.channelDates[channel];
    }
    return { start: device.startDate, end: device.endDate };
}

// Converti Annex-B (h264/h265) in MP4 con ffmpeg
async function annexBToMp4(annexB, outputPath, isH265 = false) {
    return new Promise((resolve, reject) => {
        const inputFormat = isH265 ? 'hevc' : 'h264';
        const ff = spawn('ffmpeg', [
            '-y',
            '-hide_banner',
            '-loglevel', 'error',
            '-framerate', '25',  // Force 25fps input (Reolink standard)
            '-f', inputFormat,
            '-i', 'pipe:0',
            '-c:v', 'copy',
            '-movflags', '+faststart',
            outputPath
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        let stderr = '';
        ff.stderr.on('data', d => stderr += d.toString());
        ff.on('close', code => {
            if (code === 0) resolve(true);
            else reject(new Error(`ffmpeg failed: ${stderr}`));
        });
        ff.on('error', reject);

        ff.stdin.write(annexB);
        ff.stdin.end();
    });
}

// Estrai thumbnail JPEG da MP4 con ffmpeg
async function extractJpeg(mp4Path, jpgPath) {
    return new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
            '-y',
            '-hide_banner',
            '-loglevel', 'error',
            '-i', mp4Path,
            '-vframes', '1',
            '-q:v', '2',
            jpgPath
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        let stderr = '';
        ff.stderr.on('data', d => stderr += d.toString());
        ff.on('close', code => {
            if (code === 0) resolve(true);
            else reject(new Error(`ffmpeg thumbnail failed: ${stderr}`));
        });
        ff.on('error', reject);
    });
}

async function testDevice(device) {
    const results = [];

    console.log(`\n${'='.repeat(60)}`);
    console.log(`${device.name} (${device.host})`);
    console.log('='.repeat(60));

    const api = new ReolinkBaichuanApi({
        host: device.host,
        port: 9000,
        username: 'admin',
        password: PASSWORD
    });

    try {
        await api.login();
        console.log('  ✓ Connected');

        for (const channel of device.channels) {
            const { start, end } = getDateRange(device, channel);
            const dateStr = start.toISOString().split('T')[0];
            console.log(`\n  Channel ${channel} (${dateStr}):`);

            const result = {
                device: device.name,
                channel,
                date: dateStr,
                list: { ok: false, count: 0 },
                download: { ok: false },
                thumbnail: { ok: false }
            };

            // 1. List recordings
            try {
                const recordings = await api.getVideoclips({
                    channel,
                    start,
                    end,
                    timeoutMs: 15000
                }) || [];

                result.list = { ok: recordings.length > 0, count: recordings.length };
                console.log(`    List: ${recordings.length} recordings ${recordings.length > 0 ? '✓' : '✗'}`);

                if (recordings.length > 0) {
                    const rec = recordings[0];
                    console.log(`    File: ${rec.fileName.split('/').pop()}`);

                    // 2. Download con demux
                    try {
                        console.log(`    Downloading...`);
                        const { annexB, videoType, stats } = await api.downloadRecordingDemuxed({
                            channel,
                            fileName: rec.fileName,
                            timeoutMs: 120000
                        });

                        if (annexB.length > 0) {
                            const isH265 = videoType === 'H265';
                            const mp4Path = join(OUTPUT_DIR, `${device.name}_ch${channel}.mp4`);

                            console.log(`    Converting to MP4 (${videoType}, ${stats.videoPackets} packets, ${(annexB.length / 1024).toFixed(0)}KB)...`);
                            await annexBToMp4(annexB, mp4Path, isH265);

                            result.download = { ok: true, bytes: annexB.length, file: `${device.name}_ch${channel}.mp4` };
                            console.log(`    ✓ Saved: ${result.download.file}`);

                            // 3. Extract JPEG thumbnail from MP4
                            try {
                                const jpgPath = join(OUTPUT_DIR, `${device.name}_ch${channel}.jpg`);
                                await extractJpeg(mp4Path, jpgPath);

                                const { statSync } = await import('fs');
                                const jpgSize = statSync(jpgPath).size;
                                result.thumbnail = { ok: true, bytes: jpgSize, file: `${device.name}_ch${channel}.jpg` };
                                console.log(`    ✓ Thumbnail: ${result.thumbnail.file} (${(jpgSize / 1024).toFixed(1)}KB)`);
                            } catch (e) {
                                console.log(`    ✗ Thumbnail failed: ${e.message}`);
                            }
                        } else {
                            console.log(`    ✗ Download returned empty annexB`);
                        }
                    } catch (e) {
                        console.log(`    ✗ Download failed: ${e.message}`);
                    }
                }
            } catch (e) {
                console.log(`    ✗ List failed: ${e.message}`);
            }

            results.push(result);
        }
    } catch (e) {
        console.log(`  ✗ Connection failed: ${e.message}`);
    } finally {
        await api.close().catch(() => { });
    }

    return results;
}

async function main() {
    if (!PASSWORD) {
        console.error('ERROR: TCP_PASSWORD not set');
        process.exit(1);
    }

    console.log('=== FULL TEST SUITE ===');
    console.log(`Output: ${OUTPUT_DIR}`);

    const allResults = [];

    for (const device of DEVICES) {
        const results = await testDevice(device);
        allResults.push(...results);
    }

    // Summary
    console.log('\n\n=== SUMMARY ===');
    console.log('-'.repeat(80));
    console.log('Device'.padEnd(20) + 'Ch'.padEnd(4) + 'Date'.padEnd(12) + 'List'.padEnd(10) + 'MP4'.padEnd(20) + 'JPEG');
    console.log('-'.repeat(80));

    for (const r of allResults) {
        const listCol = r.list.ok ? `✓ (${r.list.count})` : '✗';
        const mp4Col = r.download.ok ? `✓ ${r.download.file}` : '✗';
        const jpgCol = r.thumbnail.ok ? `✓ ${r.thumbnail.file}` : '✗';

        console.log(
            r.device.padEnd(20) +
            String(r.channel).padEnd(4) +
            r.date.padEnd(12) +
            listCol.padEnd(10) +
            mp4Col.padEnd(20) +
            jpgCol
        );
    }
    console.log('-'.repeat(80));

    // File salvati
    console.log('\n=== FILES IN test/artifacts/ ===');
    const { readdirSync } = await import('fs');
    const files = readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.mp4') || f.endsWith('.jpg'));
    for (const f of files.sort()) {
        const { statSync } = await import('fs');
        const size = statSync(join(OUTPUT_DIR, f)).size;
        console.log(`  ${f} (${(size / 1024).toFixed(1)} KB)`);
    }
}

main().catch(console.error);
