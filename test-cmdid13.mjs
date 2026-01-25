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

// Test cmdId=13 direttamente
console.log('\nTrying cmdId=13 (FileInfoListDownload)...');
try {
    const data = await api.fileInfoListDownload({
        channel: 0,
        fileName,
        timeoutMs: 120000
    });
    console.log('cmdId=13 download size:', data.length, 'bytes');
    if (data.length > 0) {
        writeFileSync('/tmp/cmdid13_download.bin', data);
    }
} catch (e) {
    console.log('cmdId=13 failed:', e.message);
}

await api.close();
