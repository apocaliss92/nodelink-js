// CRC32 used by BCUDP discovery packets.
// Ported to match `neolink` `bcudp/crc.rs` effective behavior:
// CRC-32/ISO-HDLC table, but with init=0x00000000 and xorout=0x00000000.

let table: Uint32Array | undefined;

function getTable(): Uint32Array {
  if (table) return table;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  table = t;
  return t;
}

export function bcudpCrc32(buf: Buffer): number {
  const t = getTable();
  let crc = 0x00000000;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    crc = (t[(crc ^ b) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return crc >>> 0;
}

