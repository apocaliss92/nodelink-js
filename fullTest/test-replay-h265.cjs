// Test replay per camera H.265 (192.168.1.170)
// Uso: node test-replay-h265.cjs [main|sub] [date: YYYY-MM-DD]
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function main() {
    const { ReolinkBaichuanApi } = await import('../dist/index.js');
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');

    const streamArg = process.argv[2] || 'sub';
    const dateArg = process.argv[3] || '2026-01-23'; // Default to Jan 23
    const streamType = streamArg === 'main' ? 'mainStream' : 'subStream';

    console.log(`=== H.265 Camera Test ===`);
    console.log(`Stream type: ${streamType}`);
    console.log(`Date: ${dateArg}`);

    const host = process.env.TCP265_HOST;
    const username = process.env.TCP265_USERNAME;
    const password = process.env.TCP265_PASSWORD;

    console.log(`Connecting to ${host}...`);

    const api = new ReolinkBaichuanApi({
        host, username, password,
        debug: { recordings: false },
    });

    try {
        await api.login();
        console.log('Login OK');

        // Parse date
        const [year, month, day] = dateArg.split('-').map(Number);
        const start = new Date(year, month - 1, day, 0, 0, 0);
        const end = new Date(year, month - 1, day, 23, 59, 59);

        const files = await api.getVideoclips({
            channel: 0,
            streamType: streamType,
            start,
            end,
        });

        console.log(`Found ${files.length} recordings on ${dateArg}`);

        if (files.length === 0) {
            console.log('No recordings found');
            return;
        }

        const file = files[files.length - 1];
        console.log(`\nFile: ${file.fileName}`);
        console.log(`Time: ${new Date(file.startTime * 1000).toLocaleString()}`);

        // Start replay stream
        console.log('\n--- Starting replay stream ---');

        const videoFrames = [];
        let frameCount = 0;
        let keyframes = 0;
        let firstKeyframe = null;
        let firstTimestamp = null;
        let lastFrame = null;

        const { stream, stop } = await api.startRecordingReplayStream({
            channel: 0,
            fileName: file.fileName,
            streamType: streamType,
        });

        stream.on('videoAccessUnit', (frame) => {
            frameCount++;

            if (firstTimestamp === null) {
                firstTimestamp = frame.microseconds;
            }
            const normalizedUs = frame.microseconds - firstTimestamp;

            if (frame.isKeyframe) {
                keyframes++;
                if (!firstKeyframe) {
                    firstKeyframe = Buffer.from(frame.data);
                    console.log(`First keyframe: ${firstKeyframe.length} bytes @ ${(normalizedUs / 1000000).toFixed(3)}s`);
                }
            }

            lastFrame = {
                data: Buffer.from(frame.data),
                isKeyframe: frame.isKeyframe,
                microseconds: normalizedUs,
            };
            videoFrames.push(lastFrame);
        });

        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('Timeout reached (30s)');
                stop();
                resolve();
            }, 30000);

            stream.on('close', () => {
                clearTimeout(timeout);
                console.log('Stream closed');
                resolve();
            });
        });

        console.log(`\nCollected ${videoFrames.length} video frames (${keyframes} keyframes)`);

        if (videoFrames.length === 0) {
            console.log('No frames collected');
            return;
        }

        // Output directory
        const outDir = path.join(__dirname, '..', 'downloads', `clip-h265-${streamArg}`);
        fs.mkdirSync(outDir, { recursive: true });

        // Save raw H.265
        const h265Data = Buffer.concat(videoFrames.map(f => f.data));
        const h265Path = path.join(outDir, 'clip.h265');
        fs.writeFileSync(h265Path, h265Data);
        console.log(`\nSaved H.265: ${h265Path} (${h265Data.length} bytes)`);

        // Check for errors
        console.log('\n--- Checking for H.265 errors ---');
        try {
            const errors = execSync(
                `ffmpeg -v error -f hevc -i "${h265Path}" -f null - 2>&1`,
                { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
            );
            const errorCount = errors.trim() ? errors.trim().split('\n').length : 0;
            console.log(`H.265 errors: ${errorCount}`);
            if (errorCount > 0 && errorCount <= 10) {
                console.log(errors);
            }
        } catch (e) {
            console.log(`H.265 errors found`);
        }

        // Convert to MP4
        console.log('\n--- Converting to MP4 ---');
        const mp4Path = path.join(outDir, 'clip.mp4');
        const avgGap = lastFrame.microseconds / (videoFrames.length - 1);
        const fps = 1000000 / avgGap;
        console.log(`Calculated FPS: ${fps.toFixed(2)}`);

        try {
            execSync(
                `ffmpeg -y -r ${fps.toFixed(2)} -f hevc -i "${h265Path}" -c:v libx265 -preset fast -crf 18 "${mp4Path}" 2>&1`,
                { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
            );
            const stats = fs.statSync(mp4Path);
            console.log(`MP4 created: ${mp4Path} (${(stats.size / 1024).toFixed(1)} KB)`);
        } catch (e) {
            console.error('FFmpeg MP4 error:', e.message);
        }

        // Generate thumbnail
        console.log('\n--- Generating Thumbnail ---');
        const thumbPath = path.join(outDir, 'thumbnail.jpg');

        if (firstKeyframe) {
            const keyframePath = path.join(outDir, 'keyframe.h265');
            fs.writeFileSync(keyframePath, firstKeyframe);
            console.log(`Keyframe saved: ${keyframePath} (${firstKeyframe.length} bytes)`);

            try {
                execSync(
                    `ffmpeg -y -f hevc -i "${keyframePath}" -frames:v 1 -q:v 2 "${thumbPath}" 2>&1`,
                    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
                );

                if (fs.existsSync(thumbPath)) {
                    const thumbStats = fs.statSync(thumbPath);
                    console.log(`Thumbnail created: ${thumbPath} (${(thumbStats.size / 1024).toFixed(1)} KB)`);
                }
            } catch (e) {
                console.error('FFmpeg thumbnail error:', e.message);
            }
        }

        // List output files
        console.log('\n--- Output files ---');
        console.log(`Directory: ${outDir}`);
        const outFiles = fs.readdirSync(outDir);
        outFiles.forEach(f => {
            const stats = fs.statSync(path.join(outDir, f));
            console.log(`  ${f}: ${(stats.size / 1024).toFixed(1)} KB`);
        });

        // Open files
        console.log('\nOpening files...');
        execSync(`open "${outDir}"`);

    } finally {
        await api.close();
    }

    console.log('\nDone');
}

main().catch(console.error);
