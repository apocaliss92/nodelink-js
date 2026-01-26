// Test minimo replay streaming
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

        // Lista recordings del 25 gennaio 2026
        const targetDate = new Date(2026, 0, 25);
        const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0);
        const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59);

        const files = await api.getVideoclips({
            channel: 0,
            streamType: 'subStream',
            start: startOfDay,
            end: endOfDay,
        });

        if (files.length === 0) {
            console.log('No recordings found');
            return;
        }

        console.log(`Found ${files.length} recordings`);
        const file = files[0];
        console.log(`File: ${file.fileName}`);

        // Avvia replay
        console.log('\nStarting replay stream...');
        console.log('  Calling api.startRecordingReplayStream...');
        const result = await api.startRecordingReplayStream({
            channel: 0,
            fileName: file.fileName,
            streamType: 'subStream',
        });
        console.log('  Got result:', Object.keys(result));

        const stream = result.stream;
        const stopStream = result.stop;

        // Debug: ascolta tutti gli eventi
        const originalEmit = stream.emit.bind(stream);
        stream.emit = function (event, ...args) {
            console.log(`[EVENT] ${event}`, event === 'videoAccessUnit' ? `(${args[0]?.data?.length || 0} bytes)` : '');
            return originalEmit(event, ...args);
        };

        const chunks = [];
        let frameCount = 0;
        const startTime = Date.now();
        const maxSeconds = 30; // Max 30 secondi

        console.log('Receiving frames...');

        await new Promise((resolve) => {
            stream.on('videoAccessUnit', (au) => {
                frameCount++;
                chunks.push(au.data);

                if (frameCount % 100 === 0) {
                    const elapsed = (Date.now() - startTime) / 1000;
                    console.log(`  ${frameCount} frames, ${(Buffer.concat(chunks).length / 1024).toFixed(0)} KB, ${elapsed.toFixed(1)}s`);
                }
            });

            stream.on('end', () => {
                console.log('Stream ended');
                resolve();
            });

            // Timeout
            setTimeout(async () => {
                console.log(`\nTimeout (${maxSeconds}s)`);
                await stopStream();
                resolve();
            }, maxSeconds * 1000);
        });

        console.log(`\nTotal: ${frameCount} frames`);

        if (chunks.length > 0) {
            const data = Buffer.concat(chunks);
            console.log(`Data: ${(data.length / 1024).toFixed(1)} KB`);

            // Salva
            const outDir = path.join(__dirname, '..', 'downloads', 'replay-min');
            fs.mkdirSync(outDir, { recursive: true });
            const outFile = path.join(outDir, 'video.h264');
            fs.writeFileSync(outFile, data);
            console.log(`Saved: ${outFile}`);
        }

    } finally {
        await api.close();
        console.log('Done');
    }
}

main().catch(console.error);
