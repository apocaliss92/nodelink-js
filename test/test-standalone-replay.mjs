#!/usr/bin/env node
/**
 * Test standalone replay stream with cleaned up method
 */
import { ReolinkBaichuanApi } from '../dist/index.js';

async function test() {
    // Try multiple cameras with their specific passwords
    const cameras = [
        { host: '192.168.1.170', name: 'E1 Outdoor PoE (TCP265)', passEnv: 'TCP265_PASSWORD' },
        { host: '192.168.50.226', name: 'TrackMix PoE', passEnv: 'TCP_PASSWORD' },
    ];

    for (const cam of cameras) {
        console.log(`\n=== Testing ${cam.name} (${cam.host}) ===`);

        const password = process.env[cam.passEnv] || process.env.CAM_PASS;
        if (!password) {
            console.log(`Skipping - no password (${cam.passEnv} not set)`);
            continue;
        }

        const api = new ReolinkBaichuanApi({
            host: cam.host,
            port: 9000,
            username: 'admin',
            password
        });

        try {
            await api.login();
            console.log(`✓ Logged in to ${cam.host}`);

            // Get recordings
            const now = new Date();
            const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const recordings = await api.standaloneListRecordings({
                start: yesterday,
                end: now,
                timeoutMs: 10000
            });

            if (!recordings || recordings.length === 0) {
                console.log('No recordings found');
                await api.close();
                continue;
            }

            console.log(`✓ Found ${recordings.length} recordings`);
            const rec = recordings[0];
            console.log(`  Testing with: ${rec.fileName}`);

            // Test replay stream
            console.log('\nStarting replay stream...');
            const { stream, stop } = await api.standaloneStartReplayStream({
                fileName: rec.fileName,
                streamType: 'mainStream',
                timeoutMs: 20000
            });

            let frames = 0;
            let bytes = 0;
            stream.on('videoFrame', (data) => {
                frames++;
                bytes += data.length;
            });

            await new Promise(r => setTimeout(r, 3000));
            await stop();

            console.log(`✓ Received ${frames} frames, ${(bytes / 1024).toFixed(0)} KB in 3s`);
            console.log('\n✅ SUCCESS - Standalone replay works!');

            await api.close();
            return; // Success, exit
        } catch (e) {
            console.error(`❌ ERROR: ${e.message}`);
            try { await api.close(); } catch { }
        }
    }

    console.log('\n❌ No cameras available for testing');
    process.exit(1);
}

test();
