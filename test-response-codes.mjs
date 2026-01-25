import { ReolinkBaichuanApi } from './dist/index.js';
import 'dotenv/config';

// Hook into the client to log response codes
const api = new ReolinkBaichuanApi({
    host: '192.168.1.170',
    port: 9000,
    username: 'admin',
    password: process.env.TCP_PASSWORD
});

await api.login();

// Add listener to log all frames
const client = api.client;
let chunkCount = 0;
let lastRc = null;
client.on('frame', (frame) => {
    if (frame.header.cmdId === 5) {
        chunkCount++;
        if (frame.header.responseCode !== lastRc) {
            console.log(`Chunk ${chunkCount}: responseCode=${frame.header.responseCode}, bodyLen=${frame.header.bodyLen}`);
            lastRc = frame.header.responseCode;
        }
    }
});

const recs = await api.getVideoclips({ channel: 0, start: new Date('2026-01-22'), end: new Date('2026-01-22T23:59:59') });

const fileName = recs[0].fileName;
console.log('Downloading:', fileName.split('/').pop());
console.log('\nMonitoring response codes...');

const startTime = Date.now();
const raw = await api.downloadRecording({ channel: 0, fileName, timeoutMs: 120000 });
console.log(`\nTotal time: ${Date.now() - startTime}ms`);
console.log(`Total chunks: ${chunkCount}`);
console.log(`Raw size: ${raw.length} bytes`);

await api.close();
