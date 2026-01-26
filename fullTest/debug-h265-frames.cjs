#!/usr/bin/env node
// Debug H.265 mainstream frames
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function main() {
    const { ReolinkBaichuanApi } = await import('../dist/index.js');
    const fs = require('fs');
    const path = require('path');

    const host = process.env.TCP265_HOST;
    const username = process.env.TCP265_USERNAME;
    const password = process.env.TCP265_PASSWORD;
    const streamArg = process.argv[2] || 'main';
    const streamType = streamArg === 'main' ? 'mainStream' : 'subStream';

    const outDir = path.join(__dirname, '..', 'downloads', 'debug-h265');
    fs.mkdirSync(outDir, { recursive: true });

    console.log(`=== H.265 Frame Debug ===`);
    console.log(`Stream type: ${streamType}`);
    console.log(`Connecting to ${host}...`);

    const api = new ReolinkBaichuanApi({
        host, username, password,
        debug: { recordings: false },
    });

    try {
        await api.login();
        console.log('Login OK\n');

        const today = new Date();
        const files = await api.getVideoclips({
            channel: 0,
            streamType: streamType,
            start: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0),
            end: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59),
        });

        if (!files.length) {
            console.log('No recordings found');
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

        stream.on('videoAccessUnit', (frame) => {
            frameCount++;

            // Analyze NAL units
            const data = frame.data;
            let nalTypes = [];
            let pos = 0;

            while (pos < data.length - 4) {
                // Look for start code
                if (data[pos] === 0 && data[pos + 1] === 0) {
                    let startCodeLen = 0;
                    if (data[pos + 2] === 1) {
                        startCodeLen = 3;
                    } else if (data[pos + 2] === 0 && data[pos + 3] === 1) {
                        startCodeLen = 4;
                    }

                    if (startCodeLen > 0) {
                        const nalByte = data[pos + startCodeLen];
                        // H.265 NAL type is (nalByte >> 1) & 0x3F
                        const nalType = (nalByte >> 1) & 0x3F;
                        nalTypes.push(nalType);
                        pos += startCodeLen + 1;
                        continue;
                    }
                }
                pos++;
            }

            const isKeyframe = frame.isKeyframe;

            // H.265 NAL types:
            // 32 = VPS, 33 = SPS, 34 = PPS
            // 19 = IDR_W_RADL, 20 = IDR_N_LP (keyframes)
            // 0-9 = TRAIL (P/B frames)
            const hasVPS = nalTypes.includes(32);
            const hasSPS = nalTypes.includes(33);
            const hasPPS = nalTypes.includes(34);
            const hasIDR = nalTypes.includes(19) || nalTypes.includes(20);
            const hasIRAP = nalTypes.some(t => t >= 16 && t <= 23);

            if (frameCount <= 20 || isKeyframe || hasVPS || hasSPS || hasPPS || hasIDR) {
                console.log(`Frame ${frameCount}: ${data.length} bytes, isKeyframe=${isKeyframe}`);
                console.log(`  NAL types: [${nalTypes.join(', ')}]`);
                console.log(`  VPS=${hasVPS} SPS=${hasSPS} PPS=${hasPPS} IDR=${hasIDR} IRAP=${hasIRAP}`);

                // Show first 32 bytes
                const hex = data.subarray(0, 32).toString('hex').match(/.{1,2}/g).join(' ');
                console.log(`  First 32: ${hex}`);

                // Save first keyframe/IDR
                if ((isKeyframe || hasIDR) && keyframeCount === 0) {
                    keyframeCount++;
                    const filename = path.join(outDir, `keyframe-${keyframeCount}.h265`);
                    fs.writeFileSync(filename, data);
                    console.log(`  Saved: ${filename}`);
                }
            }

            if (frameCount >= 100) {
                stop();
            }
        });

        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('\nTimeout reached');
                stop();
                resolve();
            }, 30000);

            stream.on('close', () => {
                clearTimeout(timeout);
                console.log('\nStream closed');
                resolve();
            });
        });

        console.log(`\nTotal: ${frameCount} frames, ${keyframeCount} keyframes detected`);

    } finally {
        await api.close();
    }
}

main().catch(console.error);
