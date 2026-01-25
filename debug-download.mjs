import { ReolinkBaichuanApi } from './dist/index.js';
import 'dotenv/config';

// Test download con debug
const api = new ReolinkBaichuanApi({
    host: '192.168.1.170',
    port: 9000,
    username: 'admin',
    password: process.env.TCP_PASSWORD,
    debug: { recording: true }  // Enable debug
});

await api.login();

const recs = await api.getVideoclips({ channel: 0, start: new Date('2026-01-22'), end: new Date('2026-01-22T23:59:59') });

if (recs.length > 0) {
    const fileName = recs[0].fileName;
    console.log('Downloading:', fileName.split('/').pop());

    const { annexB, stats, videoType } = await api.downloadRecordingDemuxed({
        channel: 0,
        fileName,
        timeoutMs: 60000
    });

    console.log('Result:', {
        annexBSize: annexB.length,
        videoType,
        stats
    });
}

await api.close();
