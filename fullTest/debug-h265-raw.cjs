#!/usr/bin/env node
// Debug raw BcMedia frames before processing
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function main() {
    const { BaichuanClient } = await import('../dist/index.js');
    const fs = require('fs');
    const path = require('path');

    const host = process.env.TCP265_HOST;
    const username = process.env.TCP265_USERNAME;
    const password = process.env.TCP265_PASSWORD;

    const outDir = path.join(__dirname, '..', 'downloads', 'debug-h265-raw');
    fs.mkdirSync(outDir, { recursive: true });

    console.log(`=== H.265 Raw BcMedia Debug ===`);
    console.log(`Connecting to ${host}...`);

    const client = new BaichuanClient({
        host, port: 9000, username, password,
        debug: false,
    });

    try {
        await client.connect();
        console.log('Login OK\n');

        // Get recordings
        const today = new Date();
        const searchResult = await client.sendCmd(null, {
            name: 'FileSearch',
            body: {
                FileSearch: {
                    channel: 0,
                    streamType: 'mainStream',
                    StartTime: {
                        year: today.getFullYear(),
                        mon: today.getMonth() + 1,
                        day: today.getDate(),
                        hour: 0, min: 0, sec: 0
                    },
                    EndTime: {
                        year: today.getFullYear(),
                        mon: today.getMonth() + 1,
                        day: today.getDate(),
                        hour: 23, min: 59, sec: 59
                    }
                }
            }
        });

        const files = searchResult?.body?.FileSearch?.SearchResult?.File || [];
        console.log(`Found ${files.length} recordings`);

        if (!files.length) return;

        const file = files[files.length - 1];
        console.log('File:', file.name);

        // Start playback - listen to raw bcMediaFrame events
        const videoStream = await client.playbackStream({
            channel: 0,
            filename: file.name,
            startTime: file.StartTime,
            endTime: file.EndTime,
            streamType: 'mainStream',
        });

        let frameCount = 0;
        let iframeCount = 0;
        let pframeCount = 0;

        videoStream.on('bcMediaFrame', (frame) => {
            frameCount++;

            const isIframe = frame.frameType === 1 || frame.isKeyframe;
            const isPframe = frame.frameType === 0 || !frame.isKeyframe;

            if (isIframe) iframeCount++;
            else pframeCount++;

            if (frameCount <= 30 || isIframe) {
                const typeStr = isIframe ? 'I-FRAME' : 'P-frame';
                console.log(`\n${typeStr} #${frameCount}: ${frame.payload.length} bytes`);

                // Show raw payload header
                const hex = frame.payload.subarray(0, 48).toString('hex').match(/.{1,2}/g).join(' ');
                console.log(`  Raw: ${hex}`);

                // Save first I-frame
                if (isIframe && iframeCount === 1) {
                    const filename = path.join(outDir, 'raw-iframe-1.bin');
                    fs.writeFileSync(filename, frame.payload);
                    console.log(`  Saved: ${filename}`);
                }
            }

            if (frameCount >= 200) {
                videoStream.stop();
            }
        });

        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('\n\nTimeout reached');
                videoStream.stop();
                resolve();
            }, 30000);

            videoStream.on('close', () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        console.log(`\n\nTotal: ${frameCount} frames (I=${iframeCount}, P=${pframeCount})`);

    } finally {
        await client.close();
    }
}

main().catch(console.error);
