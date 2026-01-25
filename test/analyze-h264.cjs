#!/usr/bin/env node
const fs = require('fs');
const data = fs.readFileSync('test-raw.h264');

// The first keyframe ends around 451291 (based on NAL analysis)
console.log('=== Bytes around keyframe end (451280) ===');
const slice1 = data.subarray(451280, 451350);
console.log(slice1.toString('hex'));

// Find start codes after offset 451000
let offset = 451000;
let found = [];
while (offset < data.length - 4 && found.length < 10) {
  if (data[offset] === 0 && data[offset+1] === 0 && data[offset+2] === 0 && data[offset+3] === 1) {
    const nalByte = data[offset + 4];
    const nalType = nalByte & 0x1f;
    found.push({ offset, nalByte: nalByte.toString(16), nalType });
  }
  offset++;
}

console.log('\n=== Start codes after offset 451000 ===');
found.forEach(f => {
  const context = data.subarray(f.offset, f.offset + 32);
  console.log('At ' + f.offset + ': NAL type ' + f.nalType + ' (0x' + f.nalByte + ')');
  console.log('  Context: ' + context.toString('hex'));
});

// Now let's check if frames are being properly separated
// Each videoAccessUnit should be a complete access unit
console.log('\n=== Frame size analysis ===');

// Based on test output, we had 249 frames total
// First frame (keyframe) should be ~451KB
// Let's see what happens at the boundary

// The issue: after the keyframe at ~451KB, we see NAL type 7 (0x47)
// But 0x47 means: forbidden_zero_bit=0, nal_ref_idc=2, nal_unit_type=7 (SPS)
// However, the data after it doesn't look like an SPS

// Let's analyze the first few NAL units more carefully
console.log('\n=== First 5 NAL units detailed ===');
let pos = 0;
let nalCount = 0;
while (pos < data.length - 4 && nalCount < 5) {
  // Find start code
  let scLen = 0;
  if (data[pos] === 0 && data[pos+1] === 0 && data[pos+2] === 0 && data[pos+3] === 1) {
    scLen = 4;
  } else if (data[pos] === 0 && data[pos+1] === 0 && data[pos+2] === 1) {
    scLen = 3;
  }
  
  if (scLen > 0) {
    const nalStart = pos + scLen;
    const nalByte = data[nalStart];
    const nalType = nalByte & 0x1f;
    
    // Find next start code
    let nalEnd = data.length;
    for (let j = nalStart; j < data.length - 3; j++) {
      if ((data[j] === 0 && data[j+1] === 0 && data[j+2] === 0 && data[j+3] === 1) ||
          (data[j] === 0 && data[j+1] === 0 && data[j+2] === 1)) {
        nalEnd = j;
        break;
      }
    }
    
    const nalLen = nalEnd - nalStart;
    console.log(`NAL ${nalCount + 1}: type ${nalType}, offset ${pos}, len ${nalLen}`);
    console.log(`  First 32 bytes: ${data.subarray(nalStart, nalStart + Math.min(32, nalLen)).toString('hex')}`);
    
    nalCount++;
    pos = nalEnd;
  } else {
    pos++;
  }
}
