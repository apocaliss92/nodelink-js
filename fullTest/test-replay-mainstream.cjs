// Test replay con mainStream
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
        console.log(`Encryption: ${api.client?.enc?.kind}`);

        // Lista recordings mainStream
        const files = await api.getVideoclips({
            channel: 0,
            streamType: 'mainStream',  // Main invece di sub
            start: new Date(2026, 0, 25, 0, 0, 0),
            end: new Date(2026, 0, 25, 23, 59, 59),
        });

        if (files.length === 0) {
            console.log('No recordings found');
            return;
        }

        console.log(`Found ${files.length} recordings`);
        const file = files[0];
        console.log(`File: ${file.fileName}`);

        // Avvia replay mainStream
        console.log('\nStarting replay stream (mainStream)...');
        const result = await api.startRecordingReplayStream({
            channel: 0,
            fileName: file.fileName,
            streamType: 'mainStream',  // Main invece di sub
        });

        const stream = result.stream;
        const stopStream = result.stop;

        const chunks = [];
        let frameCount = 0;
        let keyframeCount = 0;
        let validFrames = 0;
        const maxFrames = 30;

        await new Promise((resolve) => {
            stream.on('videoAccessUnit', (au) => {
                frameCount++;
                chunks.push(au.data);

                if (au.isKeyframe) keyframeCount++;

                // Verifica se valido
                const hasStartCode = au.data.length >= 4 &&
                    au.data[0] === 0 && au.data[1] === 0 &&
                    au.data[2] === 0 && au.data[3] === 1;
                if (hasStartCode) {
                    const nalType = au.data[4] & 0x1f;
                    if (nalType >= 1 && nalType <= 12 || nalType === 19 || nalType === 20) {
                        validFrames++;
                    }
                }

                if (frameCount <= 5) {
                    const nalType = au.data.length >= 5 ? (au.data[4] & 0x1f) : -1;
                    console.log(`Frame ${frameCount}: keyframe=${au.isKeyframe} len=${au.data.length} nalType=${nalType}`);
                }

                if (frameCount >= maxFrames) {
                    stopStream().then(resolve);
                }
            });

            stream.on('end', resolve);
            setTimeout(async () => {
                console.log('\nTimeout');
                await stopStream();
                resolve();
            }, 15000);
        });

        console.log(`\n=== Summary ===`);
        console.log(`Total frames: ${frameCount}`);
        console.log(`Keyframes: ${keyframeCount}`);
        console.log(`Valid frames: ${validFrames} (${((validFrames / frameCount) * 100).toFixed(1)}%)`);

        if (chunks.length > 0) {
            const data = Buffer.concat(chunks);
            console.log(`Total data: ${(data.length / 1024).toFixed(1)} KB`);

            // Salva
            const outDir = path.join(__dirname, '..', 'downloads', 'replay-main');
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(outDir, 'video.h264'), data);
            console.log(`Saved: ${outDir}/video.h264`);
        }

    } finally {
        await api.close();
        console.log('\nDone');
    }
}

main().catch(console.error);
