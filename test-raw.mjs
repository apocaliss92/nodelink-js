import { ReolinkBaichuanApi } from './dist/index.js';
import { writeFileSync } from 'fs';
import 'dotenv/config';

const api = new ReolinkBaichuanApi({ host: '192.168.1.170', port: 9000, username: 'admin', password: process.env.TCP_PASSWORD });
await api.login();

const recs = await api.getVideoclips({ channel: 0, start: new Date('2026-01-22'), end: new Date('2026-01-22T23:59:59') });

console.log('File:', recs[0].fileName.split('/').pop());

// Download RAW data
const raw = await api.downloadRecording({ channel: 0, fileName: recs[0].fileName, timeoutMs: 120000 });
writeFileSync('/tmp/raw_download.bin', raw);
console.log('Raw size:', raw.length, 'bytes');

// Demux to see frames
const { annexB, stats, videoType } = await api.downloadRecordingDemuxed({ channel: 0, fileName: recs[0].fileName, timeoutMs: 120000 });
writeFileSync('/tmp/annexb.h264', annexB);
console.log('AnnexB size:', annexB.length, 'bytes');
console.log('Stats:', stats);

await api.close();
