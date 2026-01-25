const { parseBcMedia, convertToAnnexB } = require('./dist/index.js');
const fs = require('fs');
const buf = fs.readFileSync('test-buffer-raw.bin');

let pos = 0;
const videoFrames = [];
let count = 0;
let iframes = 0;
const types = {};

while (pos < buf.length && count < 1000) {
    const result = parseBcMedia(buf.subarray(pos));
    if (!result) {
        console.log('Parse failed at offset', pos, '- first 8 bytes:', buf.subarray(pos, pos + 8).toString('hex'));
        break;
    }

    const { media, consumed } = result;
    count++;
    types[media.type] = (types[media.type] || 0) + 1;

    if (count <= 5) {
        console.log('Packet', count, ':', media.type, 'consumed:', consumed);
        console.log('  media keys:', Object.keys(media));
        if (media.payload) console.log('  payload size:', media.payload.length);
        if (media.data) console.log('  data size:', media.data.length);
        if (media.videoType) console.log('  videoType:', media.videoType);
    }

    // Check what field has the video data
    const videoData = media.payload || media.data;
    if ((media.type === 'Iframe' || media.type === 'Pframe') && videoData) {
        const annexb = convertToAnnexB(videoData, media.videoType);
        videoFrames.push(annexb);
        if (media.type === 'Iframe') iframes++;
    }

    pos += consumed;
}
console.log('\nPacket types:', types);

console.log('Parsed:', count, 'packets');
console.log('Video frames:', videoFrames.length, '(IFrames:', iframes + ')');

const video = Buffer.concat(videoFrames);
fs.writeFileSync('full-video.h264', video);
console.log('Written full-video.h264:', video.length, 'bytes');
