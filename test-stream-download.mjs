import { ReolinkBaichuanApi } from './dist/index.js';
import { writeFileSync } from 'fs';
import 'dotenv/config';

const api = new ReolinkBaichuanApi({
    host: '192.168.1.170',
    port: 9000,
    username: 'admin',
    password: process.env.TCP_PASSWORD
});

await api.login();

const recs = await api.getVideoclips({ channel: 0, start: new Date('2026-01-22'), end: new Date('2026-01-22T23:59:59') });

const fileName = recs[0].fileName;
console.log('File:', fileName.split('/').pop());
console.log('Expected: ~26 seconds');

console.log('\nStarting replay stream...');
const startTime = Date.now();

const { stream, stop } = await api.startRecordingReplayStream({
    channel: 0,
    fileName,
    streamType: 'mainStream',
    timeoutMs: 120000
});

const chunks = [];
let frameCount = 0;
let totalBytes = 0;

stream.on('videoFrame', (data) => {
    frameCount++;
    totalBytes += data.length;
    chunks.push(data);
    if (frameCount % 100 === 0) {
        console.log(`  Frames: ${frameCount}, Bytes: ${totalBytes}`);
    }
});

stream.on('end', () => {
    console.log('\nStream ended!');
});

stream.on('error', (err) => {
    console.log('Stream error:', err.message);
});

// Wait for stream to complete (up to 60 seconds)
console.log('Waiting for stream to complete...');
await new Promise(resolve => setTimeout(resolve, 60000));

console.log(`\nTotal time: ${Date.now() - startTime}ms`);
console.log(`Total frames: ${frameCount}`);
console.log(`Total bytes: ${totalBytes}`);

if (chunks.length > 0) {
    const buffer = Buffer.concat(chunks);
    writeFileSync('/tmp/stream_download.h264', buffer);
    console.log('Saved to /tmp/stream_download.h264');
}

await stop().catch(() => { });
await api.close();
