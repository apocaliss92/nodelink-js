// Test full video stream to MP4
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function main() {
    const { ReolinkBaichuanApi } = await import('../dist/index.js');
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');

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

        // Lista recordings
        const files = await api.getVideoclips({
            channel: 0,
            streamType: 'subStream',
            start: new Date(2026, 0, 25, 0, 0, 0),
            end: new Date(2026, 0, 25, 23, 59, 59),
        });

        if (files.length === 0) {
            console.log('No recordings found');
            return;
        }

        const file = files[0];
        console.log(`File: ${file.fileName}`);

        // Start replay stream
        console.log('\nStarting replay stream...');

        const videoFrames = [];
        let frameCount = 0;
        let keyframes = 0;

        const { stream, stop } = await api.startRecordingReplayStream({
            channel: 0,
            fileName: file.fileName,
            streamType: 'subStream',
        });

        stream.on('videoAccessUnit', (frame) => {
            frameCount++;
            if (frame.isKeyframe) keyframes++;
            videoFrames.push({
                data: frame.data,
                isKeyframe: frame.isKeyframe,
                microseconds: frame.microseconds,
            });
        });

        // Wait for frames with timeout
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('Timeout reached');
                resolve();
            }, 45000);

            stream.on('close', () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        await stop();

        console.log(`\nCollected ${frameCount} video frames (${keyframes} keyframes)`);

        // Save as H.264
        const outDir = path.join(__dirname, '..', 'downloads', 'stream-test');
        fs.mkdirSync(outDir, { recursive: true });

        const h264Data = Buffer.concat(videoFrames.map(f => f.data));
        const h264Path = path.join(outDir, 'stream.h264');
        fs.writeFileSync(h264Path, h264Data);
        console.log(`Saved H.264: ${h264Path} (${h264Data.length} bytes)`);

        // Analyze NAL types
        let validFrames = 0;
        let invalidFrames = 0;
        for (const frame of videoFrames) {
            const buf = frame.data;
            const hasStartCode = buf.length >= 4 &&
                (buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 1 ||
                    buf[0] === 0 && buf[1] === 0 && buf[2] === 1);
            if (hasStartCode) {
                const nalOffset = buf[2] === 1 ? 3 : 4;
                const nalType = buf[nalOffset] & 0x1F;
                // Valid NAL types: 1 (non-IDR), 5 (IDR), 6 (SEI), 7 (SPS), 8 (PPS)
                if ([1, 5, 6, 7, 8].includes(nalType)) {
                    validFrames++;
                } else {
                    invalidFrames++;
                }
            } else {
                invalidFrames++;
            }
        }
        console.log(`Valid frames: ${validFrames}/${frameCount} (${(validFrames / frameCount * 100).toFixed(1)}%)`);
        console.log(`Invalid frames: ${invalidFrames}`);

        // Convert to MP4 with ffmpeg
        console.log('\nConverting to MP4...');
        const mp4Path = path.join(outDir, 'stream.mp4');

        try {
            const ffmpegOutput = execSync(
                `ffmpeg -y -i "${h264Path}" -c:v copy "${mp4Path}" 2>&1`,
                { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
            );
            console.log(ffmpegOutput.split('\n').slice(-10).join('\n'));

            // Check output file
            const stats = fs.statSync(mp4Path);
            console.log(`\nMP4 created: ${mp4Path} (${(stats.size / 1024).toFixed(1)} KB)`);

            // Get video info
            const probeOutput = execSync(
                `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration,nb_frames -of csv=p=0 "${mp4Path}"`,
                { encoding: 'utf8' }
            );
            console.log(`Video info: ${probeOutput.trim()}`);

        } catch (e) {
            console.error('FFmpeg error:', e.message);
            if (e.stdout) console.log(e.stdout);
            if (e.stderr) console.log(e.stderr);
        }

    } finally {
        await api.close();
        console.log('\nDone');
    }
}

main().catch(console.error);
