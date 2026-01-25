// Analisi completa e tentativo di riparazione

const fs = require('fs');
const { execSync } = require('child_process');

const buf = fs.readFileSync('test-buffer-raw.bin');
console.log('Total buffer:', buf.length, 'bytes');

// Parse structure
let pos = 0;

// InfoV1
const infoMagic = buf.readUInt32LE(0);
const infoSize = buf.readUInt32LE(4);
const width = buf.readUInt32LE(8);
const height = buf.readUInt32LE(12);
console.log('\nInfoV1:');
console.log('  Size:', infoSize);
console.log('  Resolution:', width, 'x', height);
pos = infoSize;

// IFrame
const iframeMagic = buf.toString('utf8', pos, pos + 4);
const videoType = buf.toString('utf8', pos + 4, pos + 8);
const payloadSize = buf.readUInt32LE(pos + 8);
const addHeaderSize = buf.readUInt32LE(pos + 12);
console.log('\nIFrame:');
console.log('  Magic:', iframeMagic);
console.log('  Type:', videoType);
console.log('  Payload:', payloadSize);
console.log('  AddHeader:', addHeaderSize);

const dataStart = pos + 24 + addHeaderSize;
const videoData = buf.subarray(dataStart, dataStart + payloadSize);
console.log('  Video data:', videoData.length, 'bytes');

// Check padding
const padSize = payloadSize % 8 === 0 ? 0 : 8 - (payloadSize % 8);
console.log('  Padding:', padSize);

// Save just the first I-frame for analysis
fs.writeFileSync('iframe-only.h264', videoData);
console.log('\nSaved: iframe-only.h264');

// Try ffprobe
try {
    const probe = execSync('ffprobe -v error -show_entries stream=width,height,profile -of json iframe-only.h264 2>&1', { encoding: 'utf8' });
    console.log('\nffprobe result:');
    console.log(probe);
} catch (e) {
    console.log('\nffprobe error:', e.message);
}

// Try to decode and save frame
try {
    execSync('ffmpeg -y -v error -i iframe-only.h264 -frames:v 1 iframe-decoded.jpg 2>&1', { encoding: 'utf8' });
    console.log('Saved: iframe-decoded.jpg');

    // Check file size
    const stat = fs.statSync('iframe-decoded.jpg');
    console.log('JPEG size:', stat.size, 'bytes');
} catch (e) {
    console.log('ffmpeg decode error:', e.message);
}

// Count how many 00 00 03 sequences (emulation prevention)
let epb = 0;
for (let i = 0; i < videoData.length - 2; i++) {
    if (videoData[i] === 0 && videoData[i + 1] === 0 && videoData[i + 2] === 3) {
        epb++;
    }
}
console.log('\nEmulation prevention bytes:', epb);

// Calculate entropy
const freq = new Array(256).fill(0);
for (let i = 0; i < videoData.length; i++) freq[videoData[i]]++;
let entropy = 0;
for (let i = 0; i < 256; i++) {
    if (freq[i] > 0) {
        const p = freq[i] / videoData.length;
        entropy -= p * Math.log2(p);
    }
}
console.log('Entropy:', entropy.toFixed(4), '(normal H264: 6-7, encrypted: ~8)');
