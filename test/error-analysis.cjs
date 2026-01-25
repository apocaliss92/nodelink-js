const fs = require('fs');
const path = require('path');

const v = fs.readFileSync(path.join(__dirname, 'video-payload-raw.bin'));

// Error at bytestream 14251, but this is relative to the IDR NAL data
// IDR starts at offset 28 (after SPS+PPS)
const idrStart = 28;
const errorOffset = idrStart + 14251;

console.log('=== Error Location Analysis ===\n');
console.log('IDR NAL starts at:', idrStart);
console.log('Error at bytestream:', 14251);
console.log('Absolute offset:', errorOffset);
console.log('File size:', v.length);
console.log('');

// Wait - bytestream 14251 in ffmpeg is likely from the START of the IDR slice data
// The IDR NAL is: 00 00 00 01 65 [slice header] [slice data]
// So offset 14251 is 14251 bytes into the slice data (after NAL header)

const idrSliceDataStart = 24 + 4 + 1; // after 00 00 00 01 65
console.log('IDR slice data starts at:', idrSliceDataStart);
console.log('Error absolute offset:', idrSliceDataStart + 14251, '(if counting from slice data)');

// But wait - we only have 15699 - 29 = 15670 bytes of slice data
// And error is at 14251, meaning only 3 rows out of 23 decoded?
// That means 3/23 = 13% of the data decoded OK, but error at ~14251/15670 = 91% through the data

// This is INCONSISTENT! If only 3 rows decoded, we should have seen error much earlier
// Unless... the slice data is corrupted EARLY but the error only manifests at row 3

console.log('\n=== Frame Structure ===');
console.log('Resolution: 640x360');
console.log('Macroblocks: 40 wide x 23 tall (640/16 x ceil(360/16))');
console.log('Error at MB 0,3 = top-left of row 3');
console.log('This means first 3 rows (40*3=120 MBs) might have been OK');
console.log('Or error propagated from earlier corruption');

console.log('\n=== Data Analysis ===');
// Check if the file might be truncated or have padding
const last100 = v.slice(-100);
console.log('Last 20 bytes:');
let hex = '';
for (let i = 0; i < 20; i++) {
    hex += last100[100 - 20 + i].toString(16).padStart(2, '0') + ' ';
}
console.log(hex);

// Count trailing zeros (could indicate padding)
let trailingZeros = 0;
for (let i = v.length - 1; i >= 0; i--) {
    if (v[i] === 0) trailingZeros++;
    else break;
}
console.log('Trailing zeros:', trailingZeros);

// Check for RBSP trailing bits
// In valid H.264, slice data ends with 1 bit followed by zeros to byte-align
const lastByte = v[v.length - 1];
console.log('Last byte:', lastByte.toString(16), '=', lastByte.toString(2).padStart(8, '0'));

// The CABAC termination should have a specific pattern
// After CABAC data, there should be end_of_slice_segment marker

console.log('\n=== Hypothesis ===');
console.log('The error at MB 0,3 with bytestream 14251 is strange');
console.log('14251 bytes = 91% through the 15670 byte IDR slice');
console.log('But error at row 3 = 13% through the frame');
console.log('');
console.log('CABAC is a sequential decoder - earlier bits affect later bits');
console.log('A corruption early in the stream can cascade to errors later');
console.log('OR: The bytestream position is where ffmpeg is reading when');
console.log('    it detects the decode error (not necessarily where corruption is)');
