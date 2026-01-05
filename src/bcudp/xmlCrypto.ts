// Reolink BCUDP XML crypto (used for discovery/heartbeat XML payloads).

const XML_KEY_U32 = Uint32Array.from([
  0x1f2d3c4b, 0x5a6c7f8d, 0x38172e4b, 0x8271635a, 0x863f1a2b, 0xa5c6f7d8, 0x8371e1b4, 0x17f2d3a5,
]);

function* keystream(offset: number): Generator<number, void, void> {
  let idx = 0;
  while (true) {
    const word = (XML_KEY_U32[idx % XML_KEY_U32.length]! + (offset >>> 0)) >>> 0;
    // little-endian bytes
    yield word & 0xff;
    yield (word >>> 8) & 0xff;
    yield (word >>> 16) & 0xff;
    yield (word >>> 24) & 0xff;
    idx++;
  }
}

export function bcudpXmlEncrypt(tid: number, plain: Buffer): Buffer {
  const out = Buffer.allocUnsafe(plain.length);
  const ks = keystream(tid >>> 0);
  for (let i = 0; i < plain.length; i++) {
    out[i] = plain[i]! ^ (ks.next().value as number);
  }
  return out;
}

export function bcudpXmlDecrypt(tid: number, enc: Buffer): Buffer {
  // XOR symmetric
  return bcudpXmlEncrypt(tid, enc);
}

