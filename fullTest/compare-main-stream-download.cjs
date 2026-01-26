// Compare mainstream streaming vs download to find encryption boundary
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

        // 1. Download (gives us reference correct data)
        console.log('\n=== Downloading (reference) ===');
        const downloadResult = await api.getRecordingVideo({
            channel: 0,
            fileName: file.fileName,
            streamType: 'mainStream',
        });

        const downloadData = downloadResult.mp4;
        console.log(`Download size: ${downloadData.length} bytes`);
        console.log(`Stats: ${JSON.stringify(downloadResult.stats)}`);

        // The download is MP4, not raw BcMedia. We need to extract the H.264
        // For comparison, let's use the streaming approach differently

        // Find first I-frame in download (look for BcMedia magic)
        let downloadIframeOffset = -1;
        for (let i = 0; i < downloadData.length - 4; i++) {
            // Look for cd00, cd01, etc (I-frame magic)
            if (downloadData[i] === 0x63 && downloadData[i + 1] === 0x64 &&
                downloadData[i + 2] === 0x30 && downloadData[i + 3] >= 0x30 && downloadData[i + 3] <= 0x39) {
                downloadIframeOffset = i;
                break;
            }
        }

        if (downloadIframeOffset < 0) {
            console.log('No I-frame found in download!');
            return;
        }

        console.log(`First I-frame at offset ${downloadIframeOffset}`);

        // Extract first I-frame from download
        const dlIframeBuf = downloadData.subarray(downloadIframeOffset);
        const dlPayloadSize = dlIframeBuf.readUInt32LE(8);
        const dlAdditionalHeaderSize = dlIframeBuf.readUInt32LE(12);
        const dlHeaderSize = 24 + dlAdditionalHeaderSize;

        console.log(`Download I-frame: payloadSize=${dlPayloadSize}, additionalHeader=${dlAdditionalHeaderSize}, headerSize=${dlHeaderSize}`);

        // 2. Stream (get raw encrypted data)
        console.log('\n=== Streaming (encrypted) ===');

        let streamIframe = null;

        const { stream, stop } = await api.startRecordingReplayStream({
            channel: 0,
            fileName: file.fileName,
            streamType: 'mainStream',
        });

        await new Promise((resolve) => {
            stream.on('videoAccessUnit', (frame) => {
                if (frame.isKeyframe && !streamIframe) {
                    // This is already decrypted by our code, we need raw...
                    // For now, let's compare what we get
                    streamIframe = Buffer.from(frame.data);
                    console.log(`Stream I-frame: ${streamIframe.length} bytes`);
                    resolve();
                }
            });

            setTimeout(() => {
                console.log('Timeout');
                resolve();
            }, 10000);
        });

        await stop();

        if (!streamIframe) {
            console.log('No stream I-frame captured');
            return;
        }

        // 3. Compare
        console.log('\n=== Comparing ===');

        // The stream frame is H.264 data (no BcMedia header)
        // The download data has BcMedia header
        const dlH264 = dlIframeBuf.subarray(dlHeaderSize, dlHeaderSize + dlPayloadSize);

        console.log(`Download H.264: ${dlH264.length} bytes`);
        console.log(`Stream H.264: ${streamIframe.length} bytes`);

        // Find first difference
        const minLen = Math.min(dlH264.length, streamIframe.length);
        let firstDiff = -1;
        for (let i = 0; i < minLen; i++) {
            if (dlH264[i] !== streamIframe[i]) {
                firstDiff = i;
                break;
            }
        }

        if (firstDiff < 0 && dlH264.length === streamIframe.length) {
            console.log('\n✅ PERFECT MATCH! No differences found.');
        } else if (firstDiff < 0) {
            console.log(`\n⚠️ Data matches up to ${minLen} bytes, but lengths differ`);
        } else {
            console.log(`\n❌ First difference at offset ${firstDiff}`);
            console.log(`  Download: ${dlH264.subarray(firstDiff, firstDiff + 32).toString('hex')}`);
            console.log(`  Stream:   ${streamIframe.subarray(firstDiff, firstDiff + 32).toString('hex')}`);

            // Find where they match again
            let matchAgain = -1;
            for (let i = firstDiff + 1; i < minLen; i++) {
                let match = true;
                for (let j = 0; j < 16 && i + j < minLen; j++) {
                    if (dlH264[i + j] !== streamIframe[i + j]) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    matchAgain = i;
                    break;
                }
            }

            if (matchAgain >= 0) {
                console.log(`  Match resumes at offset ${matchAgain}`);
                console.log(`  Corrupted region: ${firstDiff} - ${matchAgain} (${matchAgain - firstDiff} bytes)`);
            }
        }

        // Show first 100 bytes comparison
        console.log('\n--- First 100 bytes ---');
        console.log('Download:', dlH264.subarray(0, 50).toString('hex'));
        console.log('Stream:  ', streamIframe.subarray(0, 50).toString('hex'));

    } finally {
        await api.close();
        console.log('\nDone');
    }
}

main().catch(console.error);
