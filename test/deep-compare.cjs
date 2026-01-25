const fs = require('fs');

const raw = fs.readFileSync('test-buffer-raw.bin');
const demuxed = fs.readFileSync('downloads/nvr-events-cover-download/ch0_2026-01-24_clip_RecS04_20260124_080329_080359_0_280_168_033C8000000000_10C552.mp4.h264');

// Header offsets
const INFOV1_SIZE = 32;
const IFRAME_HEADER_SIZE = 24;
const ADDITIONAL_HEADER_SIZE = raw.readUInt32LE(0x20 + 12);

const videoStart = INFOV1_SIZE + IFRAME_HEADER_SIZE + ADDITIONAL_HEADER_SIZE;
console.log('Video data starts at offset:', videoStart, '(0x' + videoStart.toString(16) + ')');

// Prima confrontiamo i primi 100 bytes
console.log('\nFirst 100 bytes comparison:');
console.log('Raw:     ', raw.subarray(videoStart, videoStart + 100).toString('hex'));
console.log('Demuxed: ', demuxed.subarray(0, 100).toString('hex'));

// Trova il primo byte diverso
let firstDiff = -1;
for (let i = 0; i < Math.min(demuxed.length, raw.length - videoStart); i++) {
    if (raw[videoStart + i] !== demuxed[i]) {
        firstDiff = i;
        break;
    }
}
console.log('\nFirst difference at offset:', firstDiff);

if (firstDiff >= 0) {
    console.log('At offset', firstDiff, ':');
    console.log('  Raw:    ', raw.subarray(videoStart + firstDiff, videoStart + firstDiff + 20).toString('hex'));
    console.log('  Demuxed:', demuxed.subarray(firstDiff, firstDiff + 20).toString('hex'));

    // Mostra contesto
    const ctx = 16;
    console.log('\nContext (16 bytes before):');
    console.log('  Raw:    ', raw.subarray(videoStart + firstDiff - ctx, videoStart + firstDiff).toString('hex'));
    console.log('  Demuxed:', demuxed.subarray(firstDiff - ctx, firstDiff).toString('hex'));
}

// Il raw che abbiamo è dallo scoring test, quindi dovrebbe essere già "scelto" correttamente
// Ma il demuxed viene da un download separato. Verifichiamo che entrambi abbiano la stessa struttura

// Cerchiamo magic nel demuxed (non dovrebbe avercene - è puro H264)
let h264Magics = 0;
for (let i = 0; i < demuxed.length - 4; i++) {
    const m = demuxed.readUInt32LE(i);
    if (m >= 0x63643030 && m <= 0x63643039) h264Magics++;
    if (m >= 0x63643130 && m <= 0x63643139) h264Magics++;
}
console.log('\nBcMedia magics in demuxed (should be 0):', h264Magics);

// Cerchiamo NAL start codes
let nalCount = 0;
for (let i = 0; i < demuxed.length - 4; i++) {
    if (demuxed[i] === 0 && demuxed[i + 1] === 0 && demuxed[i + 2] === 0 && demuxed[i + 3] === 1) {
        nalCount++;
    }
}
console.log('NAL start codes in demuxed:', nalCount);
