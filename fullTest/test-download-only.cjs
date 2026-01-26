// Test ONLY download - isolated
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function main() {
    const { ReolinkBaichuanApi } = await import('../dist/index.js');
    const fs = require('fs');
    const path = require('path');

    const host = process.env.TCP_HOST;
    const username = process.env.TCP_USERNAME;
    const password = process.env.TCP_PASSWORD;

    console.log('='.repeat(60));
    console.log('DOWNLOAD ONLY TEST');
    console.log('='.repeat(60));

    const api = new ReolinkBaichuanApi({
        host, username, password,
        debug: { recordings: true },
    });

    const outDir = path.join(__dirname, '..', 'downloads', 'download-only-test');
    fs.mkdirSync(outDir, { recursive: true });

    try {
        await api.login();
        console.log('\n✓ Login OK');

        // Get recordings
        console.log('\n--- Finding recordings ---');
        const files = await api.getVideoclips({
            channel: 0,
            streamType: 'subStream',
            start: new Date(2026, 0, 25, 0, 0, 0),
            end: new Date(2026, 0, 25, 23, 59, 59),
        });

        if (files.length === 0) {
            console.log('No recordings found!');
            return;
        }

        console.log(`Found ${files.length} recordings`);
        const file = files[0];
        console.log(`Using: ${file.fileName}`);

        // DOWNLOAD
        console.log('\n--- Download ---');
        const downloadStart = Date.now();
        const downloadResult = await api.getRecordingVideo({
            channel: 0,
            fileName: file.fileName,
            streamType: 'subStream',
        });
        const downloadTime = ((Date.now() - downloadStart) / 1000).toFixed(1);

        console.log(`\n✓ Download completed in ${downloadTime}s`);
        console.log(`  MP4 size: ${(downloadResult.mp4.length / 1024).toFixed(1)} KB`);
        console.log(`  Video frames: ${downloadResult.stats.videoPackets}`);
        console.log(`  Keyframes: ${downloadResult.stats.keyframes}`);
        console.log(`  Duration: ${downloadResult.stats.durationSeconds.toFixed(2)}s`);
        console.log(`  Has audio: ${downloadResult.stats.hasAudio}`);

        if (downloadResult.mp4.length > 1500) {
            const downloadPath = path.join(outDir, 'clip_download.mp4');
            fs.writeFileSync(downloadPath, downloadResult.mp4);
            console.log(`\n  Saved: ${downloadPath}`);
        } else {
            console.log('\n  ⚠️ MP4 too small - likely failed');
        }

    } catch (e) {
        console.error('\n✗ Error:', e.message);
        console.error(e.stack);
    } finally {
        await api.close();
        console.log('\n✓ Connection closed');
    }
}

main().catch(console.error);
