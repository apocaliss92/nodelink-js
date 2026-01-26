// Debug BcMedia packet sizes for mainstream
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function main() {
    const { ReolinkBaichuanApi } = await import('../dist/index.js');

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

        let frameCount = 0;
        let iframePackets = [];
        let currentIframeData = null;

        const { stream, stop } = await api.startRecordingReplayStream({
            channel: 0,
            fileName: file.fileName,
            streamType: 'mainStream',
        });

        // Hook into the raw BcMedia events if available
        stream.on('videoAccessUnit', (frame) => {
            frameCount++;

            if (frame.isKeyframe) {
                console.log(`\n=== I-frame #${frameCount} ===`);
                console.log(`  Total size: ${frame.data.length} bytes`);
                console.log(`  First 32 bytes: ${frame.data.subarray(0, 32).toString('hex')}`);

                // Check for corruption at various offsets
                const checkOffsets = [720, 1024, 2048, 4096];
                for (const offset of checkOffsets) {
                    if (frame.data.length > offset + 16) {
                        console.log(`  Bytes @${offset}: ${frame.data.subarray(offset, offset + 16).toString('hex')}`);
                    }
                }
            }

            if (frameCount >= 100) {
                stop();
            }
        });

        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('\nTimeout (30s)');
                resolve();
            }, 30000);

            stream.on('close', () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        await stop();
        console.log(`\nTotal frames: ${frameCount}`);

    } finally {
        await api.close();
        console.log('\nDone');
    }
}

main().catch(console.error);
