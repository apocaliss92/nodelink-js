import { ReolinkBaichuanApi } from './dist/index.js';
import 'dotenv/config';

const api = new ReolinkBaichuanApi({ host: '192.168.1.170', port: 9000, username: 'admin', password: process.env.TCP_PASSWORD });
await api.login();

const recs = await api.getVideoclips({ channel: 0, start: new Date('2026-01-22'), end: new Date('2026-01-22T23:59:59') });

console.log('Analyzing first 5 recordings:');
for (const r of recs.slice(0, 5)) {
    const match = r.fileName.match(/_(\d{6})_(\d{6})_/);
    if (match) {
        const start = match[1];
        const end = match[2];
        const startSec = parseInt(start.slice(0, 2)) * 3600 + parseInt(start.slice(2, 4)) * 60 + parseInt(start.slice(4, 6));
        const endSec = parseInt(end.slice(0, 2)) * 3600 + parseInt(end.slice(2, 4)) * 60 + parseInt(end.slice(4, 6));
        const duration = endSec - startSec;
        console.log(r.fileName.split('/').pop(), ':', duration, 'sec');
    }
}
await api.close();
