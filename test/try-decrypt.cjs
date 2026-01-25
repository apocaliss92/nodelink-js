const fs = require('fs');
const crypto = require('crypto');

const buf = fs.readFileSync('video-payload-raw.bin');

// BC_XML_KEY used in bcEncrypt
const BC_XML_KEY = Buffer.from([0x1F, 0x2D, 0x3C, 0x4B, 0x5A, 0x69, 0x78, 0xFF]);

// Try bcDecrypt on the IDR slice data
function bcDecrypt(data, offset) {
    const out = Buffer.alloc(data.length);
    const off = offset & 0xff;
    for (let i = 0; i < data.length; i++) {
        const key = BC_XML_KEY[(off + i) % BC_XML_KEY.length];
        out[i] = data[i] ^ key ^ off;
    }
    return out;
}

// Get IDR slice (skip SPS, PPS, and start codes)
// SPS: 00 00 00 01 + 12 bytes = 16
// PPS: 00 00 00 01 + 4 bytes = 8  
// IDR start code: 00 00 00 01 = 4
// Total header: 28 bytes, then IDR NAL byte (65) at position 28
const idrPayload = buf.subarray(29); // Skip everything including the 65 NAL type byte

console.log('IDR payload size:', idrPayload.length);
console.log('First 32 bytes:', idrPayload.subarray(0, 32).toString('hex'));

// Try bcDecrypt with different offsets
console.log('\n--- Trying bcDecrypt ---');
for (const offset of [0, 1, 32, 64, 250]) {
    const dec = bcDecrypt(idrPayload.subarray(0, 64), offset);
    // Check if result looks more like valid CABAC data
    // Valid slice data should have certain patterns
    const zeros = dec.filter(b => b === 0).length;
    console.log(`Offset ${offset}: ${dec.subarray(0, 16).toString('hex')} (zeros: ${zeros})`);
}

// Try AES-CFB on just the slice data
console.log('\n--- Trying AES-CFB on slice data ---');
const BC_AES_IV = Buffer.from("0123456789abcdef", "utf8");

// We need the AES key - let's try with a known test key
// The key changes per session, but let's see if there's a pattern
const testKeys = [
    '35343442433231313631344539464545', // From last test
    '41453934383339353045344234414536', // Another key seen
    '31433636364434304539323743383632', // Another
];

for (const keyHex of testKeys) {
    try {
        const key = Buffer.from(keyHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-128-cfb', key, BC_AES_IV);
        decipher.setAutoPadding(false);
        const dec = Buffer.concat([decipher.update(idrPayload.subarray(0, 64)), decipher.final()]);

        // Check for NAL-like patterns (should have some 0x00 bytes and valid ranges)
        const zeros = dec.filter(b => b === 0).length;
        const hasStartCode = dec[0] === 0 && dec[1] === 0;
        console.log(`Key ${keyHex.slice(0, 8)}...: ${dec.subarray(0, 16).toString('hex')} (zeros: ${zeros}, startCode: ${hasStartCode})`);
    } catch (e) {
        console.log(`Key ${keyHex.slice(0, 8)}...: error`);
    }
}

// Try XOR with simple patterns
console.log('\n--- Trying simple XOR patterns ---');
const xorPatterns = [
    Buffer.from([0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88]),
    Buffer.from([0x80, 0x02, 0x00, 0x00, 0x47, 0x40, 0xd5, 0xb6, 0x35, 0x4c, 0xf8, 0x45, 0xad, 0x47, 0xd6, 0x8c]),
];

for (let p = 0; p < xorPatterns.length; p++) {
    const pattern = xorPatterns[p];
    const dec = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
        dec[i] = idrPayload[i] ^ pattern[i % pattern.length];
    }
    console.log(`Pattern ${p}: ${dec.toString('hex')}`);
}
