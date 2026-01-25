const fs = require('fs');
const { execSync } = require('child_process');

const videoData = fs.readFileSync('iframe-only.h264');
console.log('Video data size:', videoData.length);

// Find NAL units
const nals = [];
for (let i = 0; i < videoData.length - 4; i++) {
    if (videoData[i] === 0 && videoData[i + 1] === 0 && videoData[i + 2] === 0 && videoData[i + 3] === 1) {
        nals.push(i);
    }
}
console.log('NAL start codes at:', nals);

// Analyze each segment
for (let n = 0; n < nals.length; n++) {
    const start = nals[n] + 4;
    const end = n + 1 < nals.length ? nals[n + 1] : videoData.length;
    const nalType = videoData[start] & 0x1f;
    const size = end - start;
    console.log(`\nNAL ${n}: type=${nalType} size=${size}`);

    if (nalType === 5) { // IDR
        // Analyze entropy at different offsets within IDR
        console.log('  Analyzing IDR entropy at different offsets:');

        const blockSize = 500;
        for (let offset = 0; offset < Math.min(size, 5000); offset += blockSize) {
            const block = videoData.subarray(start + offset, start + offset + blockSize);

            // Calculate entropy
            const freq = new Array(256).fill(0);
            for (let i = 0; i < block.length; i++) freq[block[i]]++;
            let entropy = 0;
            for (let i = 0; i < 256; i++) {
                if (freq[i] > 0) {
                    const p = freq[i] / block.length;
                    entropy -= p * Math.log2(p);
                }
            }

            // Count zeros
            const zeros = block.filter(b => b === 0).length;

            // Count emulation prevention (00 00 03)
            let epb = 0;
            for (let i = 0; i < block.length - 2; i++) {
                if (block[i] === 0 && block[i + 1] === 0 && block[i + 2] === 3) epb++;
            }

            const status = entropy < 7.5 ? '✓ OK' : '✗ HIGH';
            console.log(`    Offset ${offset}-${offset + blockSize}: entropy=${entropy.toFixed(2)} zeros=${zeros} epb=${epb} ${status}`);
        }
    }
}

// Try to find where valid data ends
console.log('\n--- Looking for transition point ---');
const idrStart = nals[2] + 5; // After start code and NAL type
const idrData = videoData.subarray(idrStart);

// Sliding window entropy
const windowSize = 100;
for (let i = 0; i < Math.min(2000, idrData.length - windowSize); i += 100) {
    const window = idrData.subarray(i, i + windowSize);
    const freq = new Array(256).fill(0);
    for (let j = 0; j < window.length; j++) freq[window[j]]++;
    let entropy = 0;
    for (let j = 0; j < 256; j++) {
        if (freq[j] > 0) {
            const p = freq[j] / windowSize;
            entropy -= p * Math.log2(p);
        }
    }
    if (entropy < 7.0) {
        console.log(`Offset ${i}: entropy=${entropy.toFixed(2)} <- LOW (valid data?)`);
    }
}
