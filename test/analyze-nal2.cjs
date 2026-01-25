const fs = require('fs');
const buf = fs.readFileSync('video-payload-raw.bin');

// Find NAL units
const nals = [];
for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
        nals.push(i);
    }
}
console.log('NAL offsets:', nals);

// SPS analysis
const sps = buf.subarray(nals[0] + 4, nals[1]);
console.log('\nSPS (' + sps.length + ' bytes):', sps.toString('hex'));

// PPS analysis  
const pps = buf.subarray(nals[1] + 4, nals[2]);
console.log('\nPPS (' + pps.length + ' bytes):', pps.toString('hex'));

// IDR analysis - first 100 bytes
const idr = buf.subarray(nals[2] + 4, nals[2] + 4 + 100);
console.log('\nIDR first 100 bytes:', idr.toString('hex'));

// Check for emulation prevention bytes in IDR (03 after 00 00)
let ep = 0;
for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 3) {
        ep++;
    }
}
console.log('\nEmulation prevention bytes found:', ep);
console.log('Expected for valid H264: some (>0)');

// Entropy of IDR only (excluding SPS/PPS)
const idrFull = buf.subarray(nals[2] + 4);
const freq = new Array(256).fill(0);
for (let i = 0; i < idrFull.length; i++) {
    freq[idrFull[i]]++;
}
let entropy = 0;
for (let i = 0; i < 256; i++) {
    if (freq[i] > 0) {
        const p = freq[i] / idrFull.length;
        entropy -= p * Math.log2(p);
    }
}
console.log('\nIDR entropy:', entropy.toFixed(4), 'bits/byte');
