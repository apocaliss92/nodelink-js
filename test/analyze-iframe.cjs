const fs = require('fs');
const buf = fs.readFileSync('test-buffer-raw.bin');

// Offset 0x20 è l'IFrame
const iframeOffset = 0x20;
const magic = buf.toString('utf8', iframeOffset, iframeOffset + 4);
const videoType = buf.toString('utf8', iframeOffset + 4, iframeOffset + 8);
const payloadSize = buf.readUInt32LE(iframeOffset + 8);
const additionalHeaderSize = buf.readUInt32LE(iframeOffset + 12);
const microseconds = buf.readUInt32LE(iframeOffset + 16);
const unknown = buf.readUInt32LE(iframeOffset + 20);

console.log('IFrame header at offset 0x20:');
console.log('  magic:', magic);
console.log('  videoType:', videoType);
console.log('  payloadSize:', payloadSize, '(0x' + payloadSize.toString(16) + ')');
console.log('  additionalHeaderSize:', additionalHeaderSize);
console.log('  microseconds:', microseconds);
console.log('  unknown:', unknown);

const dataOffset = iframeOffset + 24 + additionalHeaderSize;
console.log('  data offset:', dataOffset, '(0x' + dataOffset.toString(16) + ')');
console.log('  data first 32:', buf.subarray(dataOffset, dataOffset + 32).toString('hex'));
