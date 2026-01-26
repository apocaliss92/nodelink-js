// Full round test: Download, Streaming, Thumbnail
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function main() {
    const { ReolinkBaichuanApi } = await import('../dist/index.js');
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');

    const host = process.env.TCP_HOST;
    const username = process.env.TCP_USERNAME;
    const password = process.env.TCP_PASSWORD;

    console.log('='.repeat(60));
    console.log('FULL ROUND TEST - Download, Streaming, Thumbnail');
    console.log('='.repeat(60));
    console.log(`Host: ${host}`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log('='.repeat(60));

    const api = new ReolinkBaichuanApi({
        host, username, password,
        debug: { recordings: true },
    });

    const outDir = path.join(__dirname, '..', 'downloads', 'full-round-test');
    fs.mkdirSync(outDir, { recursive: true });

    try {
        await api.login();
        console.log('\n✓ Login OK');

        // Get device info
        const channelCount = await api.getChannelCount();
        const isNvr = await api.isNvrDevice();
        console.log(`  Channel count: ${channelCount}`);
        console.log(`  Is NVR: ${isNvr}`);

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
        console.log(`  Start: ${file.startTime}`);
        console.log(`  End: ${file.endTime}`);

        // Helper for delay
        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        // ==================== STREAMING FIRST ====================
        console.log('\n' + '='.repeat(60));
        console.log('1. STREAMING METHOD (first to avoid camera state issues)');
        console.log('='.repeat(60));

        let h264Data = null;
        const streamStart = Date.now();

        // Collect frames manually for more control
        const { stream, stop } = await api.startRecordingReplayStream({
            channel: 0,
            fileName: file.fileName,
            streamType: 'subStream',
        });

        const videoFrames = [];
        let keyframes = 0;

        stream.on('videoAccessUnit', (frame) => {
            videoFrames.push({
                data: frame.data,
                isKeyframe: frame.isKeyframe,
                microseconds: frame.microseconds,
            });
            if (frame.isKeyframe) keyframes++;
        });

        // Wait for stream to complete
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('  (Timeout reached)');
                resolve();
            }, 30000);

            stream.on('close', () => {
                clearTimeout(timeout);
                resolve();
            });
            stream.on('end', () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        await stop();
        const streamTime = ((Date.now() - streamStart) / 1000).toFixed(1);

        console.log(`\n✓ Streaming completed in ${streamTime}s`);
        console.log(`  Video frames: ${videoFrames.length}`);
        console.log(`  Keyframes: ${keyframes}`);

        // Analyze frames
        let validFrames = 0;
        let invalidFrames = 0;
        const nalTypes = {};

        for (const frame of videoFrames) {
            const buf = frame.data;
            const hasStartCode = buf.length >= 4 &&
                (buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 1 ||
                    buf[0] === 0 && buf[1] === 0 && buf[2] === 1);

            if (hasStartCode) {
                const nalOffset = buf[2] === 1 ? 3 : 4;
                const nalType = buf[nalOffset] & 0x1F;
                nalTypes[nalType] = (nalTypes[nalType] || 0) + 1;

                if ([1, 5, 6, 7, 8].includes(nalType)) {
                    validFrames++;
                } else {
                    invalidFrames++;
                }
            } else {
                invalidFrames++;
            }
        }

        if (videoFrames.length > 0) {
            console.log(`  Valid frames: ${validFrames}/${videoFrames.length} (${(validFrames / videoFrames.length * 100).toFixed(1)}%)`);
            console.log(`  NAL types: ${JSON.stringify(nalTypes)}`);

            // Save H.264 and convert to MP4
            h264Data = Buffer.concat(videoFrames.map(f => f.data));
            const h264Path = path.join(outDir, 'clip_streaming.h264');
            fs.writeFileSync(h264Path, h264Data);

            // Convert to MP4 - must specify framerate for subStream (10fps)
            const streamMp4Path = path.join(outDir, 'clip_streaming.mp4');
            try {
                execSync(`ffmpeg -y -f h264 -r 10 -i "${h264Path}" -c:v copy "${streamMp4Path}" 2>/dev/null`);
                const stats = fs.statSync(streamMp4Path);

                // Get duration with ffprobe
                const durationProbe = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${streamMp4Path}"`, { encoding: 'utf8' });
                const duration = parseFloat(durationProbe.trim());
                console.log(`\n  Saved: ${streamMp4Path} (${(stats.size / 1024).toFixed(1)} KB, ${duration.toFixed(1)}s)`);
            } catch (e) {
                console.log(`  FFmpeg conversion failed: ${e.message}`);
            }
        } else {
            console.log('  No frames received!');
        }

        // Delay before next operation
        console.log('\n  Waiting 3s before download...');
        await delay(3000);

        // Close and reopen connection for download (camera state issue)
        console.log('  Reconnecting for download...');
        await api.close();
        await api.login();
        console.log('  ✓ Reconnected');

        // ==================== DOWNLOAD ====================
        console.log('\n' + '='.repeat(60));
        console.log('2. DOWNLOAD METHOD');
        console.log('='.repeat(60));

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
        console.log(`  FPS: ${downloadResult.stats.fps}`);
        console.log(`  Has audio: ${downloadResult.stats.hasAudio}`);
        console.log(`  Video codec: ${downloadResult.stats.videoCodec}`);
        console.log(`  Audio codec: ${downloadResult.stats.audioCodec || 'N/A'}`);

        const downloadPath = path.join(outDir, 'clip_download.mp4');
        fs.writeFileSync(downloadPath, downloadResult.mp4);
        console.log(`\n  Saved: ${downloadPath}`);

        // Delay before thumbnail
        console.log('\n  Waiting 3s before thumbnail...');
        await delay(3000);

        // Close and reopen connection for thumbnail
        console.log('  Reconnecting for thumbnail...');
        await api.close();
        await api.login();
        console.log('  ✓ Reconnected');

        // ==================== THUMBNAIL ====================
        console.log('\n' + '='.repeat(60));
        console.log('3. THUMBNAIL');
        console.log('='.repeat(60));

        const thumbStart = Date.now();
        try {
            const thumbnail = await api.getRecordingThumbnail({
                channel: 0,
                fileName: file.fileName,
            });
            const thumbTime = ((Date.now() - thumbStart) / 1000).toFixed(1);

            console.log(`\n✓ Thumbnail retrieved in ${thumbTime}s`);
            console.log(`  Size: ${(thumbnail.length / 1024).toFixed(1)} KB`);

            // Check if it's a valid JPEG
            const isJpeg = thumbnail[0] === 0xFF && thumbnail[1] === 0xD8;
            console.log(`  Valid JPEG: ${isJpeg}`);

            const thumbPath = path.join(outDir, 'thumbnail.jpg');
            fs.writeFileSync(thumbPath, thumbnail);
            console.log(`\n  Saved: ${thumbPath}`);

            // Get dimensions with ffprobe
            try {
                const probe = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${thumbPath}" 2>/dev/null`, { encoding: 'utf8' });
                console.log(`  Dimensions: ${probe.trim()}`);
            } catch (e) {
                // ignore
            }
        } catch (e) {
            console.log(`\n✗ Thumbnail failed: ${e.message}`);
        }

        // ==================== SUMMARY ====================
        console.log('\n' + '='.repeat(60));
        console.log('SUMMARY');
        console.log('='.repeat(60));
        console.log(`\nFiles created in: ${outDir}/`);

        const createdFiles = fs.readdirSync(outDir);
        for (const f of createdFiles) {
            const stats = fs.statSync(path.join(outDir, f));
            console.log(`  - ${f} (${(stats.size / 1024).toFixed(1)} KB)`);
        }

        console.log('\n' + '='.repeat(60));
        console.log('COMPARISON');
        console.log('='.repeat(60));
        console.log(`\n${'Method'.padEnd(15)} ${'Frames'.padEnd(10)} ${'Time'.padEnd(10)} ${'Size'.padEnd(15)}`);
        console.log(`${'Download'.padEnd(15)} ${String(downloadResult.stats.videoPackets).padEnd(10)} ${(downloadTime + 's').padEnd(10)} ${((downloadResult.mp4.length / 1024).toFixed(1) + ' KB').padEnd(15)}`);
        console.log(`${'Streaming'.padEnd(15)} ${String(videoFrames.length).padEnd(10)} ${(streamTime + 's').padEnd(10)} ${((h264Data?.length || 0) / 1024).toFixed(1) + ' KB'}`);

    } catch (e) {
        console.error('\n✗ Error:', e.message);
        console.error(e.stack);
    } finally {
        await api.close();
        console.log('\n✓ Connection closed');
    }
}

main().catch(console.error);
