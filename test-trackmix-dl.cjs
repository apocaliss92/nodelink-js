const dotenv = require('dotenv');
const { ReolinkBaichuanApi } = require('./dist/index.js');

dotenv.config();

const api = new ReolinkBaichuanApi({
  host: '192.168.50.226', // TrackMix PoE
  port: 9000,
  username: process.env.TCP_USERNAME || 'admin',
  password: process.env.TCP_PASSWORD,
  debug: {
    recordingsTrace: true,
  },
});

(async function main() {
  try {
    await api.login();
    console.log('Logged in');

    const now = new Date();
    // 22 gennaio 2026
    const start = new Date('2026-01-22T00:00:00');
    const end = new Date('2026-01-22T23:59:59');

    const recs = await api.standaloneListRecordings({
      channel: 0,
      start: start,
      end: end,
    });
    console.log('Found ' + recs.length + ' recordings');

    if (recs.length === 0) {
      console.log('No recordings found');
      return;
    }

    const rec = recs[0];
    console.log('Downloading: ' + rec.fileName);

    const buf = await api.downloadRecording({
      channel: 0,
      fileName: rec.fileName,
      timeoutMs: 60000,
    });

    console.log('Downloaded ' + buf.length + ' bytes');
  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
  } finally {
    await api.close();
  }
})();
