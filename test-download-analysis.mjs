import { ReolinkBaichuanApi } from './dist/index.js';
import { writeFileSync } from 'fs';
import 'dotenv/config';

// Patch the client to log chunks
const api = new ReolinkBaichuanApi({
    host: '192.168.1.170',
    port: 9000,
    username: 'admin',
    password: process.env.TCP_PASSWORD,
    debug: { recording: true }
});

await api.login();

const recs = await api.getVideoclips({ channel: 0, start: new Date('2026-01-22'), end: new Date('2026-01-22T23:59:59') });

const fileName = recs[0].fileName;
console.log('File:', fileName.split('/').pop());
console.log('Expected duration from filename: ~26 seconds');

console.log('\nStarting download...');
const startTime = Date.now();

const raw = await api.downloadRecording({ channel: 0, fileName, timeoutMs: 120000 });

const elapsed = Date.now() - startTime;
console.log(`\nDownload completed in ${elapsed}ms`);
console.log('Raw size:', raw.length, 'bytes');
console.log('Size per second:', (raw.length / (elapsed / 1000)).toFixed(0), 'bytes/s');

// Check BcMedia structure
let offset = 0;
let packetCount = 0;
let iFrames = 0;
let pFrames = 0;
while (offset < raw.length - 4) {
    const magic = raw.readUInt32LE(offset);
    // Check for BcMedia markers
    if (magic === 0x31303031 || magic === 0x32303031) {
        // Info packet
        packetCount++;
        offset += 4;
    } else if (magic >= 0x63643030 && magic <= 0x63643039) {
        // I-frame (cd0X)
        iFrames++;
        packetCount++;
        offset += 4;
    } else if (magic >= 0x63643130 && magic <= 0x63643139) {
        // P-frame (cd1X) 
        pFrames++;
        packetCount++;
        offset += 4;
    } else {
        offset++;
    }
}

console.log('\nBcMedia analysis:');
console.log('  Total packets scanned:', packetCount);
console.log('  I-frames:', iFrames);
console.log('  P-frames:', pFrames);
console.log('  Estimated duration (1 keyframe/sec):', iFrames, 'seconds');

await api.close();
