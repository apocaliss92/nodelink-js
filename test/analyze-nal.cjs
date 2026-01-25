const fs = require('fs');
const buf = fs.readFileSync('video-payload-raw.bin');

// Parse NAL units
let pos = 0;
const nals = [];
while (pos < buf.length - 4) {
    if (buf[pos] === 0 && buf[pos + 1] === 0 && buf[pos + 2] === 0 && buf[pos + 3] === 1) {
        if (nals.length > 0) {
            nals[nals.length - 1].end = pos;
            nals[nals.length - 1].size = pos - nals[nals.length - 1].start;
        }
        nals.push({ start: pos, type: buf[pos + 4] & 0x1f });
        pos += 4;
    } else {
        pos++;
    }
}
if (nals.length > 0) {
    nals[nals.length - 1].end = buf.length;
    nals[nals.length - 1].size = buf.length - nals[nals.length - 1].start;
}

const names = { 7: 'SPS', 8: 'PPS', 5: 'IDR', 6: 'SEI', 1: 'non-IDR' };
nals.forEach((n, i) => {
    const dataStart = n.start + 4;
    const nalSize = n.size - 4;
    console.log('NAL', i, 'type', n.type, '(' + (names[n.type] || '?') + ')', 'offset', n.start, 'size', nalSize);
    if (n.type === 7) {
        console.log('  SPS header:', buf.subarray(dataStart, dataStart + 16).toString('hex'));
    } else if (n.type === 5) {
        console.log('  IDR header:', buf.subarray(dataStart, dataStart + 32).toString('hex'));
        console.log('  IDR size:', nalSize, 'bytes');
    }
});
console.log('\nTotal NAL units:', nals.length);
