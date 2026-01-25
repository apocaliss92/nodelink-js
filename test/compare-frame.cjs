const fs = require('fs');
const buf = fs.readFileSync('test-buffer-raw.bin');

// Estrae solo l'H264 data del primo frame
const iframeOffset = 0x20;
const payloadSize = buf.readUInt32LE(iframeOffset + 8);
const additionalHeaderSize = buf.readUInt32LE(iframeOffset + 12);
const dataOffset = iframeOffset + 24 + additionalHeaderSize;

console.log('Extracting first IFrame:');
console.log('  dataOffset:', dataOffset);
console.log('  payloadSize:', payloadSize);

const firstFrame = buf.subarray(dataOffset, dataOffset + payloadSize);
fs.writeFileSync('test-first-iframe-only.h264', firstFrame);
console.log('Saved: test-first-iframe-only.h264');

// Ora compariamo con il demuxed
const demuxed = fs.readFileSync('downloads/nvr-events-cover-download/ch0_2026-01-24_clip_RecS04_20260124_080329_080359_0_280_168_033C8000000000_10C552.mp4.h264');
console.log('\nComparing with demuxed:');
console.log('  First frame size:', payloadSize);
console.log('  Demuxed total size:', demuxed.length);

// Confronta i primi N bytes
const compare = Math.min(payloadSize, demuxed.length);
let diff = 0;
for (let i = 0; i < compare; i++) {
    if (firstFrame[i] !== demuxed[i]) {
        if (diff < 5) {
            console.log(`  Diff at offset ${i}: first=${firstFrame[i]?.toString(16) || 'undef'} demuxed=${demuxed[i]?.toString(16)}`);
        }
        diff++;
    }
}
console.log('  Total differences:', diff);
