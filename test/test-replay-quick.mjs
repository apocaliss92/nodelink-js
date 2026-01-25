#!/usr/bin/env node
import { ReolinkBaichuanApi } from '../dist/index.js';
import 'dotenv/config';

const isNvr = process.argv.includes('--nvr');
const host = isNvr ? process.env.NVR_HOST : process.env.TCP265_HOST;
const username = isNvr ? process.env.NVR_USERNAME : process.env.TCP265_USERNAME;
const password = isNvr ? process.env.NVR_PASSWORD : process.env.TCP265_PASSWORD;
const channel = 0;

console.log('Testing replay on:', host, isNvr ? '(NVR)' : '(standalone)');

const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    transport: 'tcp',
    debug: process.argv.includes('--debug')
});

try {
    await api.login();
    console.log('✅ Connected');

    // Get recordings - use explicit Date objects to avoid timezone issues
    const dateRange = {
        start: new Date('2026-01-20T00:00:00'),
        end: new Date('2026-01-26T23:59:59')
    };
    let recs;

    if (isNvr) {
        // NVR uses getVideoclips
        recs = await api.getVideoclips({ channel, ...dateRange });
    } else {
        recs = await api.standaloneListRecordings(dateRange);
    }

    console.log(`✅ Found ${recs.length} recordings`);

    if (recs.length === 0) {
        console.log('❌ No recordings to test');
        await api.close();
        process.exit(1);
    }

    const rec = recs[0];
    console.log('Testing replay for:', rec.fileName);

    // Try startRecordingReplayStream
    console.log('\n--- Attempting startRecordingReplayStream ---');

    try {
        const { stream, stop, msgNum } = await api.startRecordingReplayStream({
            channel,
            fileName: rec.fileName
        });

        console.log('✅ Replay started, msgNum:', msgNum);

        let frames = 0;
        let audioFrames = 0;

        stream.on('videoAccessUnit', (au) => {
            frames++;
            if (frames <= 3) {
                console.log(`  Frame ${frames}: keyframe=${au.isKeyframe} type=${au.videoType} len=${au.data.length}`);
            }
        });

        stream.on('audioFrame', () => {
            audioFrames++;
        });

        stream.on('error', (e) => {
            console.error('Stream error:', e.message);
        });

        await new Promise(r => setTimeout(r, 3000));

        console.log(`\n✅ Received ${frames} video frames, ${audioFrames} audio frames in 3s`);

        await stop();
        console.log('✅ Replay stopped');

    } catch (e) {
        console.error('❌ Replay failed:', e.message);

        // Mostra tentativi dettagliati
        if (e.message.includes('attempts=')) {
            console.log('\nAttempts detail:');
            const attempts = e.message.match(/attempts=\[(.*?)\]/)?.[1];
            if (attempts) {
                attempts.split(' | ').forEach((a, i) => {
                    console.log(`  ${i + 1}. ${a}`);
                });
            }
        }
    }

    await api.close();
    console.log('\n✅ Disconnected');

} catch (e) {
    console.error('Fatal error:', e.message);
    process.exit(1);
}
