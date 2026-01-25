const fs = require('fs');
const path = require('path');

const raw = fs.readFileSync(path.join(__dirname, 'test-buffer-raw.bin'));

console.log('=== BcMedia Structure Analysis ===\n');
console.log('Total file size:', raw.length, 'bytes\n');

// InfoV1 header: 32 bytes
console.log('InfoV1 (32 bytes):');
console.log('  Magic:', raw.slice(0, 4).toString('hex'));
for (let i = 0; i < 32; i += 4) {
    const val = raw.readUInt32LE(i);
    console.log(`  +${i.toString().padStart(2)}: ${val.toString(16).padStart(8, '0')} = ${val}`);
}

// IFrame header at offset 32
console.log('\nIFrame Header (starts at 32):');
for (let i = 32; i < 64; i += 4) {
    const val = raw.readUInt32LE(i);
    console.log(`  +${(i - 32).toString().padStart(2)}: ${val.toString(16).padStart(8, '0')} = ${val}`);
}

// Find first start code
console.log('\nLooking for H.264 start codes:');
for (let i = 32; i < 150; i++) {
    if (raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 0 && raw[i + 3] === 1) {
        const nalType = raw[i + 4] & 0x1f;
        const nalTypeNames = { 1: 'Non-IDR', 5: 'IDR', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD' };
        console.log(`  Offset ${i}: NAL type ${nalType} (${nalTypeNames[nalType] || 'Unknown'})`);
    }
}

// Now let's compare with what we extracted
console.log('\n=== Comparison with video-payload-raw.bin ===');
const payload = fs.readFileSync(path.join(__dirname, 'video-payload-raw.bin'));
console.log('Extracted payload size:', payload.length);

// The payload should start at some offset in raw
// Find where
for (let start = 32; start < 100; start++) {
    if (raw[start] === payload[0] &&
        raw[start + 1] === payload[1] &&
        raw[start + 2] === payload[2] &&
        raw[start + 3] === payload[3]) {
        // Verify match
        let match = true;
        for (let j = 0; j < Math.min(100, payload.length); j++) {
            if (raw[start + j] !== payload[j]) {
                match = false;
                break;
            }
        }
        if (match) {
            console.log('Payload starts at raw offset:', start);
            console.log('Header size before payload:', start, 'bytes');
            console.log('  (InfoV1=32 + IFrameHeader=' + (start - 32) + ')');
            break;
        }
    }
}

// Check payloadSize field vs actual payload
const declaredPayloadSize = raw.readUInt32LE(44);
console.log('\nDeclared payload size (offset 44):', declaredPayloadSize);
console.log('Actual extracted payload size:', payload.length);
console.log('Match:', declaredPayloadSize === payload.length);
