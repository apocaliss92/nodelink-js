// Debug mainstream frame analysis
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function main() {
    const { ReolinkBaichuanApi } = await import('../dist/index.js');
    const fs = require('fs');
    const path = require('path');

    const host = process.env.TCP_HOST;
    const username = process.env.TCP_USERNAME;
    const password = process.env.TCP_PASSWORD;

    console.log(`Connecting to ${host}...`);

    const api = new ReolinkBaichuanApi({
        host, username, password,
        debug: { recordings: true },
    });

    try {
        await api.login();
        console.log('Login OK');

        const today = new Date();
        const files = await api.getVideoclips({
            channel: 0,
            streamType: 'mainStream',
            start: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0),
            end: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59),
        });

        if (files.length === 0) {
            console.log('No recordings found');
            return;
        }

        const file = files[files.length - 1];
        console.log(`\nFile: ${file.fileName}`);

        const frames = [];
        let frameCount = 0;

        const { stream, stop } = await api.startRecordingReplayStream({
            channel: 0,
            fileName: file.fileName,
            streamType: 'mainStream',
        });

        stream.on('videoAccessUnit', (frame) => {
            frameCount++;
            const buf = frame.data;

            // Analyze NAL units in frame
            let nalInfo = [];
            let offset = 0;
            while (offset < buf.length - 4) {
                // Find start code
                if (buf[offset] === 0 && buf[offset + 1] === 0 && buf[offset + 2] === 0 && buf[offset + 3] === 1) {
                    const nalType = buf[offset + 4] & 0x1F;
                    nalInfo.push({ offset, nalType });
                    offset += 4;
                } else if (buf[offset] === 0 && buf[offset + 1] === 0 && buf[offset + 2] === 1) {
                    const nalType = buf[offset + 3] & 0x1F;
                    nalInfo.push({ offset, nalType });
                    offset += 3;
                } else {
                    offset++;
                }
            }

            frames.push({
                index: frameCount,
                isKeyframe: frame.isKeyframe,
                size: buf.length,
                nalUnits: nalInfo.length,
                nalTypes: nalInfo.map(n => n.nalType),
                firstBytes: buf.subarray(0, 16).toString('hex'),
                lastBytes: buf.subarray(Math.max(0, buf.length - 16)).toString('hex'),
            });

            // Log keyframes and frames around them
            if (frame.isKeyframe) {
                console.log(`\nKeyframe ${frameCount}: ${buf.length} bytes, ${nalInfo.length} NAL units`);
                console.log(`  NAL types: ${nalInfo.map(n => n.nalType).join(', ')}`);
                console.log(`  First 32 bytes: ${buf.subarray(0, 32).toString('hex')}`);
            }
        });

        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('\nTimeout (15s)');
                resolve();
            }, 15000);

            stream.on('close', () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        await stop();

        console.log(`\n=== Summary ===`);
        console.log(`Total frames: ${frames.length}`);

        // Analyze frame sizes
        const keyframes = frames.filter(f => f.isKeyframe);
        const pframes = frames.filter(f => !f.isKeyframe);

        console.log(`\nKeyframes: ${keyframes.length}`);
        keyframes.forEach(f => {
            console.log(`  #${f.index}: ${f.size} bytes, NALs: [${f.nalTypes.join(',')}]`);
        });

        console.log(`\nP-frames: ${pframes.length}`);
        console.log(`  Size range: ${Math.min(...pframes.map(f => f.size))} - ${Math.max(...pframes.map(f => f.size))} bytes`);

        // Check for suspiciously small frames
        const tinyFrames = frames.filter(f => f.size < 50);
        if (tinyFrames.length > 0) {
            console.log(`\n⚠️ Tiny frames (<50 bytes): ${tinyFrames.length}`);
            tinyFrames.slice(0, 10).forEach(f => {
                console.log(`  #${f.index}: ${f.size} bytes, hex: ${f.firstBytes}`);
            });
        }

        // Check for frames without proper start codes
        const noStartCode = frames.filter(f => !f.firstBytes.startsWith('00000001') && !f.firstBytes.startsWith('000001'));
        if (noStartCode.length > 0) {
            console.log(`\n⚠️ Frames without start code: ${noStartCode.length}`);
            noStartCode.slice(0, 10).forEach(f => {
                console.log(`  #${f.index}: ${f.size} bytes, starts: ${f.firstBytes.slice(0, 16)}`);
            });
        }

    } finally {
        await api.close();
        console.log('\nDone');
    }
}

main().catch(console.error);
