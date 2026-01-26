#!/usr/bin/env node
// Debug script to analyze frame decryption
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function main() {
    const { ReolinkBaichuanApi } = await import('../dist/index.js');
    const fs = require('fs');
    const path = require('path');

    const host = process.env.TCP_HOST;
    const username = process.env.TCP_USERNAME;
    const password = process.env.TCP_PASSWORD;
    const streamArg = process.argv[2] || 'sub';
    const streamType = streamArg === 'main' ? 'mainStream' : 'subStream';

    const outDir = path.join(__dirname, '..', 'downloads', 'debug-frames');
    fs.mkdirSync(outDir, { recursive: true });

    console.log(`Stream type: ${streamType}`);
    console.log(`Connecting to ${host}...`);

    const api = new ReolinkBaichuanApi({
        host, username, password,
        debug: { recordings: false },
    });

    try {
        await api.login();
        console.log('Login OK\n');

        // Lista recordings di oggi
        const today = new Date();
        const files = await api.getVideoclips({
            channel: 0,
            streamType: streamType,
            start: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0),
            end: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59),
        });

        if (!files.length) {
            console.log('No recordings found');
            await api.logout();
            return;
        }

        const file = files[files.length - 1];
        console.log('File:', file.fileName);

        const { stream, stop } = await api.startRecordingReplayStream({
            channel: 0,
            fileName: file.fileName,
            streamType,
        });

        let frameCount = 0;
        let keyframeCount = 0;
        const maxKeyframes = 3;

        stream.on('videoAccessUnit', (frame) => {
            frameCount++;
            const isKeyframe = frame.isKeyframe;

            if (isKeyframe) {
                keyframeCount++;
                console.log(`\n=== KEYFRAME ${keyframeCount} (frame ${frameCount}) ===`);
                console.log(`  Size: ${frame.data.length} bytes`);

                // Save the raw frame
                const filename = path.join(outDir, `keyframe-${keyframeCount}.bin`);
                fs.writeFileSync(filename, frame.data);
                console.log(`  Saved: ${filename}`);

                // Show first 64 bytes
                console.log('  First 64 bytes:');
                const hex = frame.data.subarray(0, 64).toString('hex').match(/.{1,32}/g);
                hex.forEach((line, i) => {
                    console.log(`    ${(i * 16).toString(16).padStart(4, '0')}: ${line.match(/.{1,2}/g).join(' ')}`);
                });

                // Check for H.264 start codes
                const hasStartCode = frame.data[0] === 0 && frame.data[1] === 0 &&
                    (frame.data[2] === 1 || (frame.data[2] === 0 && frame.data[3] === 1));
                console.log(`  Has H.264 start code: ${hasStartCode}`);

                if (!hasStartCode) {
                    console.log('  *** WARNING: No H.264 start code - possible encryption issue ***');
                }

                // Check bytes around 1024 boundary
                if (frame.data.length > 1024) {
                    console.log('  Bytes at 1020-1036:');
                    const boundary = frame.data.subarray(1020, 1036).toString('hex').match(/.{1,2}/g).join(' ');
                    console.log(`    ${boundary}`);
                }

                if (keyframeCount >= maxKeyframes) {
                    stop();
                }
            } else {
                // P-frame - just count and show first few
                if (frameCount <= 10) {
                    console.log(`  P-frame ${frameCount}: ${frame.data.length} bytes`);

                    // Show first 32 bytes
                    const hex = frame.data.subarray(0, 32).toString('hex').match(/.{1,2}/g).join(' ');
                    console.log(`    First 32: ${hex}`);

                    const hasStartCode = frame.data[0] === 0 && frame.data[1] === 0 &&
                        (frame.data[2] === 1 || (frame.data[2] === 0 && frame.data[3] === 1));
                    if (!hasStartCode) {
                        console.log('    *** WARNING: No H.264 start code ***');
                    }
                }
            }
        });

        stream.on('close', () => {
            console.log(`\nStream closed. Frames: ${frameCount}, Keyframes: ${keyframeCount}`);
        });

        stream.on('error', (err) => {
            console.error('Stream error:', err.message);
        });

        // Wait for stream to end
        await new Promise((resolve) => {
            stream.on('close', resolve);
            setTimeout(() => {
                console.log('\nTimeout reached');
                stop();
                resolve();
            }, 30000);
        });

    } finally {
        await api.close();
    }
}

main().catch(console.error);
