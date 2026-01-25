const data = Buffer.from('88800200004740d5b6354cf845ad47d68c07e92f5e3cd20b82ff1a09106f039b', 'hex');

let bytePos = 0;
let bitPos = 0;

function readBit() {
    const bit = (data[bytePos] >> (7 - bitPos)) & 1;
    bitPos++;
    if (bitPos === 8) { bitPos = 0; bytePos++; }
    return bit;
}

function readExpGolomb() {
    let leadingZeros = 0;
    while (readBit() === 0 && leadingZeros < 32) leadingZeros++;
    if (leadingZeros === 0) return 0;
    let value = 1;
    for (let i = 0; i < leadingZeros; i++) {
        value = (value << 1) | readBit();
    }
    return value - 1;
}

console.log('First 8 bytes:', data.subarray(0, 8).toString('hex'));
console.log('Binary: ', data.subarray(0, 4).toString('hex').split('').map((c, i) => i % 2 === 0 ? parseInt(data[i / 2].toString(16), 16).toString(2).padStart(8, '0') : '').filter(x => x).join(' '));

const first_mb = readExpGolomb();
const slice_type = readExpGolomb();
const pps_id = readExpGolomb();

console.log('\nDecoded:');
console.log('first_mb_in_slice:', first_mb, '(expect 0)');
console.log('slice_type:', slice_type, '(expect 2 or 7 for I)');
console.log('pps_id:', pps_id, '(expect 0)');

// Expected for I-slice starting at MB 0:
// first_mb = 0 -> exp-golomb: 1
// slice_type = 7 (I all) -> exp-golomb: 00001000
// pps_id = 0 -> exp-golomb: 1
// Combined: 1 00001000 1 = 0x84 0x40 ...
console.log('\nExpected bits for valid I-slice: 1 00001000 1 = 84 4x or similar');
console.log('Actual:', data[0].toString(16), data[1].toString(16));
