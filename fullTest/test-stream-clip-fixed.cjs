// Test streaming replay: genera clip MP4 con timestamp normalizzati e thumbnail
// Uso: node test-stream-clip-fixed.cjs [main|sub]
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function main() {
    const { ReolinkBaichuanApi } = await import('../dist/index.js');
    const fs = require('fs');
    const path = require('path');
    const { execSync, spawnSync } = require('child_process');

    // Parse stream type argument
    const streamArg = process.argv[2] || 'sub';
    const streamType = streamArg === 'main' ? 'mainStream' : 'subStream';
    console.log(`Stream type: ${streamType}`);

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

        // Lista recordings di oggi
        const today = new Date();
        const files = await api.getVideoclips({
            channel: 0,
            streamType: streamType,
            start: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0),
            end: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59),
        });

        if (files.length === 0) {
            console.log('No recordings found today');
            return;
        }

        // Usa la clip più recente
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

        const { stream, stop } = await api.startRecordingReplayStream({
            channel: 0,
            fileName: file.fileName,
            streamType: streamType,
        });

        stream.on('videoAccessUnit', (frame) => {
            frameCount++;

            // Normalize timestamp relative to first frame
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
            videoFrames.push({
                data: Buffer.from(frame.data),
                isKeyframe: frame.isKeyframe,
                microseconds: normalizedUs, // Use normalized timestamp
                originalUs: frame.microseconds,
            });
        });

        // Wait for frames (max 30 seconds or stream end)
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('Timeout reached (30s)');
                resolve();
            }, 30000);

            stream.on('close', () => {
                clearTimeout(timeout);
                console.log('Stream closed');
                resolve();
            });
        });

        await stop();

        console.log(`\nCollected ${frameCount} video frames (${keyframes} keyframes)`);

        if (frameCount === 0) {
            console.log('No frames received!');
            return;
        }

        // Show timestamp range
        const lastFrame = videoFrames[videoFrames.length - 1];
        console.log(`Duration: ${(lastFrame.microseconds / 1000000).toFixed(2)}s (normalized)`);
        console.log(`Original range: ${(videoFrames[0].originalUs / 1000000).toFixed(2)}s - ${(lastFrame.originalUs / 1000000).toFixed(2)}s`);

        // Output directory - different for main vs sub
        const outDirName = streamType === 'mainStream' ? 'clip-main' : 'clip-sub';
        const outDir = path.join(__dirname, '..', 'downloads', outDirName);
        fs.mkdirSync(outDir, { recursive: true });

        // Save raw H.264
        const h264Data = Buffer.concat(videoFrames.map(f => f.data));
        const h264Path = path.join(outDir, 'clip.h264');
        fs.writeFileSync(h264Path, h264Data);
        console.log(`\nSaved H.264: ${h264Path} (${h264Data.length} bytes)`);

        // Convert to MP4 with proper framerate (re-encode to fix timestamps)
        console.log('\n--- Converting to MP4 ---');
        const mp4Path = path.join(outDir, 'clip.mp4');

        // Calculate average FPS from timestamps
        const avgGap = lastFrame.microseconds / (videoFrames.length - 1);
        const fps = 1000000 / avgGap;
        console.log(`Calculated FPS: ${fps.toFixed(2)}`);

        try {
            // Use -r to set input framerate, then re-encode for clean output
            execSync(
                `ffmpeg -y -r ${fps.toFixed(2)} -f h264 -i "${h264Path}" -c:v libx264 -preset fast -crf 18 "${mp4Path}" 2>&1`,
                { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
            );

            const stats = fs.statSync(mp4Path);
            console.log(`MP4 created: ${mp4Path} (${(stats.size / 1024).toFixed(1)} KB)`);

            // Get video info
            const probeOutput = execSync(
                `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration,nb_frames,r_frame_rate -of csv=p=0 "${mp4Path}"`,
                { encoding: 'utf8' }
            );
            console.log(`Video info: ${probeOutput.trim()}`);

        } catch (e) {
            console.error('FFmpeg MP4 error:', e.message);
        }

        // Generate thumbnail from first keyframe
        console.log('\n--- Generating Thumbnail ---');
        const thumbPath = path.join(outDir, 'thumbnail.jpg');

        if (firstKeyframe) {
            // Save keyframe H.264
            const keyframePath = path.join(outDir, 'keyframe.h264');
            fs.writeFileSync(keyframePath, firstKeyframe);
            console.log(`Keyframe saved: ${keyframePath} (${firstKeyframe.length} bytes)`);

            try {
                // Extract thumbnail with ffmpeg
                execSync(
                    `ffmpeg -y -f h264 -i "${keyframePath}" -frames:v 1 -q:v 2 "${thumbPath}" 2>&1`,
                    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
                );

                if (fs.existsSync(thumbPath)) {
                    const thumbStats = fs.statSync(thumbPath);
                    console.log(`Thumbnail created: ${thumbPath} (${(thumbStats.size / 1024).toFixed(1)} KB)`);

                    // Get thumbnail info
                    const thumbInfo = execSync(
                        `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${thumbPath}"`,
                        { encoding: 'utf8' }
                    );
                    console.log(`Thumbnail size: ${thumbInfo.trim()}`);
                }

            } catch (e) {
                console.error('FFmpeg thumbnail error:', e.message);
            }
        }

        // Verify timestamps in output
        console.log('\n--- Verifying output timestamps ---');
        try {
            const tsOutput = execSync(
                `ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags -of csv=p=0 "${mp4Path}" | head -20`,
                { encoding: 'utf8' }
            );
            console.log('First 20 packets (pts,flags):');
            console.log(tsOutput);
        } catch (e) {
            // Ignore
        }

        // Show output files
        console.log('\n--- Output files ---');
        console.log(`Directory: ${outDir}`);
        const outputFiles = fs.readdirSync(outDir);
        for (const f of outputFiles) {
            const fPath = path.join(outDir, f);
            const fStats = fs.statSync(fPath);
            console.log(`  ${f}: ${(fStats.size / 1024).toFixed(1)} KB`);
        }

        // Open files
        console.log('\nOpening files...');
        spawnSync('open', [mp4Path]);
        spawnSync('open', [thumbPath]);

    } finally {
        await api.close();
        console.log('\nDone');
    }
}

main().catch(console.error);
