/**
 * Test replay streaming on camera 192.168.50.226
 * Load credentials from .env file
 */

const path = require('path');
const fs = require('fs');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const [key, ...valueParts] = trimmed.split('=');
            if (key && valueParts.length > 0) {
                process.env[key] = valueParts.join('=');
            }
        }
    }
}

const { ReolinkBaichuanApi } = require('../dist/index.cjs');

(async () => {
    console.log('Camera:', process.env.TCP_HOST);

    const api = new ReolinkBaichuanApi({
        host: process.env.TCP_HOST,
        username: process.env.TCP_USERNAME,
        password: process.env.TCP_PASSWORD,
        debug: true,
    });

    try {
        await api.login();
        console.log('Logged in');

        // Get a recording
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

        const recordings = await api.getVideoclips({
            channel: 0,
            start,
            end,
            streamType: 'mainStream',
        });

        if (!recordings || recordings.length === 0) {
            console.log('No recordings found');
            return;
        }

        const rec = recordings[0];
        const fileName = rec.fileName;
        console.log('Testing replay for:', fileName);

        console.log('\n=== Starting replay stream ===');
        const { stream, stop, msgNum } = await api.startRecordingReplayStream({
            channel: 0,
            fileName,
            streamType: 'mainStream',
            timeoutMs: 30000,
        });

        console.log('Stream started, msgNum:', msgNum);

        let frames = 0;
        let keyframes = 0;

        stream.on('videoAccessUnit', (au) => {
            frames++;
            if (au.isKeyframe) keyframes++;
            if (frames <= 5 || frames % 30 === 0) {
                console.log(`Frame #${frames}: keyframe=${au.isKeyframe}, len=${au.data.length}, type=${au.videoType}`);
            }
        });

        stream.on('videoFrame', (data) => {
            console.log('videoFrame event:', data.length, 'bytes');
        });

        stream.on('error', (e) => console.error('Stream error:', e.message));
        stream.on('close', () => console.log('Stream closed'));

        // Wait for frames
        console.log('Waiting for frames (10 seconds)...');
        await new Promise(r => setTimeout(r, 10000));

        await stop();
        console.log('\n=== Results ===');
        console.log('Total frames:', frames);
        console.log('Keyframes:', keyframes);

    } finally {
        await api.close();
    }
})().catch(e => {
    console.error('Error:', e);
    process.exit(1);
});
