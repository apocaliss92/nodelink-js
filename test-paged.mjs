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

// Prova direttamente il paged download (cmdId=14/15/16)
console.log('\nTrying paged download (cmdId=14/15/16)...');
try {
    const pagedData = await api.fileInfoListPagedDownload({
        channel: 0,
        fileName,
        timeoutMs: 120000
    });
    console.log('Paged download size:', pagedData.length, 'bytes');
    if (pagedData.length > 0) {
        writeFileSync('/tmp/paged_download.bin', pagedData);
    }
} catch (e) {
    console.log('Paged download failed:', e.message);
}

await api.close();
