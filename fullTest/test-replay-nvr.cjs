// Test replay per NVR canali 0, 1, 2
// Uso: node test-replay-nvr.cjs [channel: 0|1|2] [main|sub]
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function main() {
    const { ReolinkBaichuanApi } = await import('../dist/index.js');
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');

    const channelArg = parseInt(process.argv[2] || '0', 10);
    const streamArg = process.argv[3] || 'sub';
    const streamType = streamArg === 'main' ? 'mainStream' : 'subStream';
    
    console.log(`=== NVR Channel ${channelArg} Test ===`);
    console.log(`Stream type: ${streamType}`);

    const host = process.env.NVR_HOST;
    const username = process.env.NVR_USERNAME;
    const password = process.env.NVR_PASSWORD;

    console.log(`Connecting to ${host}...`);

    const api = new ReolinkBaichuanApi({
        host, username, password,
        debug: { recordings: false },
    });

    try {
        await api.login();
        console.log('Login OK');

        // Today's recordings
        const today = new Date();
        const files = await api.getVideoclips({
            channel: channelArg,
            streamType: streamType,
            start: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0),
            end: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59),
        });

        console.log(`Found ${files.length} recordings today for channel ${channelArg}`);

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
            channel: channelArg,
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
        const outDir = path.join(__dirname, '..', 'downloads', `clip-nvr-ch${channelArg}-${streamArg}`);
        fs.mkdirSync(outDir, { recursive: true });

        // Detect codec from first keyframe (H.264 vs H.265)
        const isH265 = firstKeyframe && (firstKeyframe[4] === 0x40 || firstKeyframe[4] === 0x42); // VPS or SPS NAL
        const codec = isH265 ? 'hevc' : 'h264';
        const ext = isH265 ? 'h265' : 'h264';
        console.log(`Detected codec: ${codec.toUpperCase()}`);

        // Save raw video
        const rawData = Buffer.concat(videoFrames.map(f => f.data));
        const rawPath = path.join(outDir, `clip.${ext}`);
        fs.writeFileSync(rawPath, rawData);
        console.log(`\nSaved ${ext.toUpperCase()}: ${rawPath} (${rawData.length} bytes)`);

        // Check for errors
        console.log('\n--- Checking for errors ---');
        try {
            const errors = execSync(
                `ffmpeg -v error -f ${codec} -i "${rawPath}" -f null - 2>&1`,
                { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
            );
            const errorCount = errors.trim() ? errors.trim().split('\n').length : 0;
            console.log(`${ext.toUpperCase()} errors: ${errorCount}`);
            if (errorCount > 0 && errorCount <= 10) {
                console.log(errors);
            }
        } catch (e) {
            const errorLines = e.stdout ? e.stdout.trim().split('\n').length : 'unknown';
            console.log(`Errors found: ${errorLines}`);
        }

        // Convert to MP4
        console.log('\n--- Converting to MP4 ---');
        const mp4Path = path.join(outDir, 'clip.mp4');
        const avgGap = lastFrame.microseconds / (videoFrames.length - 1);
        const fps = 1000000 / avgGap;
        console.log(`Calculated FPS: ${fps.toFixed(2)}`);

        const videoCodec = isH265 ? 'libx265' : 'libx264';
        try {
            execSync(
                `ffmpeg -y -r ${fps.toFixed(2)} -f ${codec} -i "${rawPath}" -c:v ${videoCodec} -preset fast -crf 18 "${mp4Path}" 2>&1`,
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
            const keyframePath = path.join(outDir, `keyframe.${ext}`);
            fs.writeFileSync(keyframePath, firstKeyframe);
            console.log(`Keyframe saved: ${keyframePath} (${firstKeyframe.length} bytes)`);

            try {
                execSync(
                    `ffmpeg -y -f ${codec} -i "${keyframePath}" -frames:v 1 -q:v 2 "${thumbPath}" 2>&1`,
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
