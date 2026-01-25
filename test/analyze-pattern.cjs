const fs = require('fs');
const buf = fs.readFileSync('video-payload-raw.bin');

// Skip NAL headers (SPS+PPS) and analyze IDR slice data
// Structure: 00 00 00 01 67 ... (SPS 12 bytes) 00 00 00 01 68 ... (PPS 4 bytes) 00 00 00 01 65 ... (IDR)
const idrStart = 28; // After start code + NAL type byte for IDR
const idr = buf.subarray(idrStart);

console.log('Total file size:', buf.length);
console.log('IDR slice start:', idrStart);
console.log('IDR slice size:', idr.length);

// Check byte distribution - if encrypted, should be uniform
const freq = new Array(256).fill(0);
for (let i = 0; i < idr.length; i++) {
    freq[idr[i]]++;
}

// Find most and least common bytes
let maxFreq = 0, minFreq = Infinity, maxByte = 0, minByte = 0;
for (let i = 0; i < 256; i++) {
    if (freq[i] > maxFreq) { maxFreq = freq[i]; maxByte = i; }
    if (freq[i] < minFreq && freq[i] > 0) { minFreq = freq[i]; minByte = i; }
}
console.log('\nMost common byte:', maxByte.toString(16), 'count:', maxFreq);
console.log('Least common byte:', minByte.toString(16), 'count:', minFreq);

// Check for width-related patterns (640 pixels = 1280 bytes for YUV, or 640 for grayscale)
console.log('\n--- Looking for row-based patterns ---');
const widths = [640, 1280, 320, 160, 80, 40, 20, 16];
for (const w of widths) {
    let matches = 0;
    for (let i = 0; i < Math.min(10000, idr.length - w); i++) {
        if (idr[i] === idr[i + w]) matches++;
    }
    const pct = (matches / Math.min(10000, idr.length - w) * 100).toFixed(1);
    if (parseFloat(pct) > 1) {
        console.log(`Width ${w}: ${pct}% matching bytes`);
    }
}

// Analyze the actual IDR header (first bytes after start code)
console.log('\n--- IDR slice header analysis ---');
console.log('IDR first 32 bytes:', buf.subarray(24, 56).toString('hex'));
// NAL type at offset 24+4=28 should be 0x65 (IDR)
console.log('NAL unit type:', (buf[28] & 0x1f), '(should be 5 for IDR)');

// Check if there's a pattern in the macroblock data
console.log('\n--- Macroblock pattern check ---');
// For 640x360 @ 16x16 macroblocks = 40x22.5 = 40x23 MBs
const mbWidth = 40;
const mbHeight = 23;
console.log('Expected MBs:', mbWidth, 'x', mbHeight, '=', mbWidth * mbHeight);

// Try to find if data repeats at macroblock boundaries
const mbSizes = [16 * 16, 16 * 16 * 1.5, 16 * 16 * 2, 256, 384, 512];
for (const mbSize of mbSizes) {
    let similar = 0;
    for (let i = 0; i < Math.min(5000, idr.length - mbSize * 2); i += mbSize) {
        const b1 = idr.subarray(i, i + 16);
        const b2 = idr.subarray(i + mbSize, i + mbSize + 16);
        let diff = 0;
        for (let j = 0; j < 16; j++) {
            diff += Math.abs(b1[j] - b2[j]);
        }
        if (diff < 50) similar++;
    }
    if (similar > 0) {
        console.log(`MB size ${mbSize}: ${similar} similar blocks`);
    }
}
