const fs = require('fs');
const path = require('path');

const raw = fs.readFileSync(path.join(__dirname, 'test-buffer-raw.bin'));

console.log('=== Multi-Frame Analysis ===\n');

// Parse all frames in the BcMedia stream
let offset = 0;
let frameNum = 0;

while (offset < raw.length - 64) {
    // Check for InfoV1 header (magic "1001" = 0x31303031)
    const magic = raw.readUInt32LE(offset);

    if (magic === 0x31303031) { // "1001"
        const infoV1Size = raw.readUInt32LE(offset + 4);
        const width = raw.readUInt32LE(offset + 8);
        const height = raw.readUInt32LE(offset + 12);

        // IFrame header follows
        const iframeHeaderOffset = offset + 32;
        const codecMagic = raw.slice(iframeHeaderOffset, iframeHeaderOffset + 8).toString('ascii');
        const payloadSize = raw.readUInt32LE(iframeHeaderOffset + 8);

        // Video data starts after 64 bytes total
        const videoOffset = offset + 64;

        // Check for NAL start code
        let nalType = -1;
        if (raw[videoOffset] === 0 && raw[videoOffset + 1] === 0 &&
            raw[videoOffset + 2] === 0 && raw[videoOffset + 3] === 1) {
            nalType = raw[videoOffset + 4] & 0x1f;
        }

        const nalNames = { 1: 'P', 5: 'IDR', 6: 'SEI', 7: 'SPS', 8: 'PPS' };

        if (frameNum < 10 || nalType === 5) { // Show first 10 and all IDRs
            console.log(`Frame ${frameNum}:`);
            console.log(`  Offset: ${offset}`);
            console.log(`  Codec: ${codecMagic.trim()}`);
            console.log(`  Payload size: ${payloadSize}`);
            console.log(`  First NAL: ${nalType} (${nalNames[nalType] || '?'})`);
            console.log(`  Video offset: ${videoOffset}`);
            console.log('');
        }

        // Move to next frame
        offset += 64 + payloadSize;
        frameNum++;
    } else {
        // Try to find next InfoV1
        offset++;
    }
}

console.log(`Total frames found: ${frameNum}`);

// Now let's extract the SECOND I-frame and compare
console.log('\n=== Extracting Second I-Frame ===');

offset = 0;
let iframeCount = 0;
while (offset < raw.length - 64) {
    const magic = raw.readUInt32LE(offset);

    if (magic === 0x31303031) {
        const iframeHeaderOffset = offset + 32;
        const payloadSize = raw.readUInt32LE(iframeHeaderOffset + 8);
        const videoOffset = offset + 64;

        if (raw[videoOffset] === 0 && raw[videoOffset + 1] === 0 &&
            raw[videoOffset + 2] === 0 && raw[videoOffset + 3] === 1) {
            const nalType = raw[videoOffset + 4] & 0x1f;

            if (nalType === 7) { // SPS = start of IDR group
                iframeCount++;
                if (iframeCount === 2) {
                    console.log('Found second I-frame at offset:', offset);
                    console.log('Payload size:', payloadSize);

                    // Extract it
                    const secondIFrame = raw.slice(videoOffset, videoOffset + payloadSize);
                    fs.writeFileSync(path.join(__dirname, 'second-iframe.h264'), secondIFrame);
                    console.log('Saved to second-iframe.h264');

                    // Quick analysis
                    console.log('\nFirst 40 bytes:');
                    console.log(secondIFrame.slice(0, 40).toString('hex').match(/.{2}/g).join(' '));
                    break;
                }
            }
        }

        offset += 64 + payloadSize;
    } else {
        offset++;
    }
}
