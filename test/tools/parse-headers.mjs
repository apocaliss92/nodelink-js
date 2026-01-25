#!/usr/bin/env node
/**
 * Parse Baichuan header from hex
 */

// Header format: 20 bytes
// 0-3: magic (f0debc0a)
// 4-5: cmdId (LE)
// 6-7: encOffset (LE)
// 8-11: bodyLen (LE)
// 12-13: msgNum (LE)
// 14: reserved
// 15: responseCode
// 16: channelId
// 17: streamType
// 18-19: msgClass (LE)

function parseHeader(hexString) {
    const hex = hexString.toLowerCase().replace(/\s/g, '');

    // Read LE 16-bit
    const u16le = (offset) => parseInt(hex.slice(offset * 2 + 2, offset * 2 + 4) + hex.slice(offset * 2, offset * 2 + 2), 16);
    // Read LE 32-bit
    const u32le = (offset) => parseInt(
        hex.slice(offset * 2 + 6, offset * 2 + 8) +
        hex.slice(offset * 2 + 4, offset * 2 + 6) +
        hex.slice(offset * 2 + 2, offset * 2 + 4) +
        hex.slice(offset * 2, offset * 2 + 2), 16
    );
    // Read 8-bit
    const u8 = (offset) => parseInt(hex.slice(offset * 2, offset * 2 + 2), 16);

    return {
        magic: hex.slice(0, 8),
        cmdId: u16le(4),
        encOffset: u16le(6),
        bodyLen: u32le(8),
        msgNum: u16le(12),
        reserved: u8(14),
        responseCode: u8(15),
        channelId: u8(16),
        streamType: u8(17),
        msgClass: u16le(18),
        msgClassHex: '0x' + u16le(18).toString(16),
        bodyHex: hex.slice(40)
    };
}

// ==== STANDALONE 192.168.1.170 ====
console.log('=== STANDALONE 192.168.1.170 - cmdId=5 TX (client -> camera) ===');
// From pcap: f0debc0a050000004d0100002200000000001464...
const standalone_tx = 'f0debc0a050000004d0100002200000000001464';
const st = parseHeader(standalone_tx);
console.log('cmdId:', st.cmdId);
console.log('bodyLen:', st.bodyLen, '(0x' + st.bodyLen.toString(16) + ')');
console.log('msgNum:', st.msgNum, '(0x' + st.msgNum.toString(16) + ')');
console.log('channelId:', st.channelId);
console.log('streamType:', st.streamType);
console.log('msgClass:', st.msgClass, st.msgClassHex);
console.log('encOffset:', st.encOffset);

console.log('\n=== STANDALONE 192.168.1.170 - cmdId=5 RX ACK (camera -> client) ===');
// From pcap: f0debc0a050000008a0000002200000c80000006a000000
const standalone_rx = 'f0debc0a050000008a00000022000000c80000006a000000';
const sr = parseHeader(standalone_rx);
console.log('cmdId:', sr.cmdId);
console.log('bodyLen:', sr.bodyLen, '(0x' + sr.bodyLen.toString(16) + ')');
console.log('msgNum:', sr.msgNum, '(0x' + sr.msgNum.toString(16) + ')');
console.log('responseCode:', sr.responseCode);
console.log('channelId:', sr.channelId);
console.log('streamType:', sr.streamType);
console.log('msgClass:', sr.msgClass, sr.msgClassHex);

console.log('\n=== STANDALONE 192.168.1.170 - cmdId=5 RX DATA (camera -> client) ===');
// From pcap: f0debc0a05000000c89a00002200000033ef6f69880000
const standalone_data = 'f0debc0a05000000c89a00002200000033ef6f69880000';
const sd = parseHeader(standalone_data);
console.log('cmdId:', sd.cmdId);
console.log('bodyLen:', sd.bodyLen, '(0x' + sd.bodyLen.toString(16) + ')');
console.log('msgNum:', sd.msgNum, '(0x' + sd.msgNum.toString(16) + ')');
console.log('channelId:', sd.channelId);
console.log('streamType:', sd.streamType);
console.log('msgClass:', sd.msgClass, sr.msgClassHex);

// ==== NVR 192.168.1.161 ====
console.log('\n\n=== NVR 192.168.1.161 - cmdId=5 TX (client -> NVR) ===');
// From pcap: f0debc0a050000009a0100005200000000001464
const nvr_tx = 'f0debc0a050000009a0100005200000000001464';
const nt = parseHeader(nvr_tx);
console.log('cmdId:', nt.cmdId);
console.log('bodyLen:', nt.bodyLen, '(0x' + nt.bodyLen.toString(16) + ')');
console.log('msgNum:', nt.msgNum, '(0x' + nt.msgNum.toString(16) + ')');
console.log('channelId:', nt.channelId);
console.log('streamType:', nt.streamType);
console.log('msgClass:', nt.msgClass, nt.msgClassHex);
console.log('encOffset:', nt.encOffset);

console.log('\n=== NVR 192.168.1.161 - cmdId=5 RX ACK (NVR -> client) ===');
// From pcap: f0debc0a050000008a00000052000000c80000006a000000
const nvr_rx = 'f0debc0a050000008a00000052000000c80000006a000000';
const nr = parseHeader(nvr_rx);
console.log('cmdId:', nr.cmdId);
console.log('bodyLen:', nr.bodyLen, '(0x' + nr.bodyLen.toString(16) + ')');
console.log('msgNum:', nr.msgNum, '(0x' + nr.msgNum.toString(16) + ')');
console.log('responseCode:', nr.responseCode);
console.log('channelId:', nr.channelId);
console.log('streamType:', nr.streamType);
console.log('msgClass:', nr.msgClass, nr.msgClassHex);

console.log('\n=== NVR 192.168.1.161 - cmdId=5 RX DATA (NVR -> client) ===');
// From pcap: f0debc0a05000000c0600000520000009ea746988800000
const nvr_data = 'f0debc0a05000000c06000005200000094ea746988000000';
const nd = parseHeader(nvr_data);
console.log('cmdId:', nd.cmdId);
console.log('bodyLen:', nd.bodyLen, '(0x' + nd.bodyLen.toString(16) + ')');
console.log('msgNum:', nd.msgNum, '(0x' + nd.msgNum.toString(16) + ')');
console.log('channelId:', nd.channelId);
console.log('streamType:', nd.streamType);
console.log('msgClass:', nd.msgClass, nd.msgClassHex);

console.log('\n\n=== CONFRONTO TX STANDALONE vs NVR ===');
console.log('                   | STANDALONE 170 | NVR 161');
console.log('-------------------|----------------|--------');
console.log(`channelId          | ${st.channelId.toString().padStart(14)} | ${nt.channelId}`);
console.log(`msgClass           | ${st.msgClassHex.padStart(14)} | ${nt.msgClassHex}`);
console.log(`streamType         | ${st.streamType.toString().padStart(14)} | ${nt.streamType}`);
console.log(`bodyLen            | ${st.bodyLen.toString().padStart(14)} | ${nt.bodyLen}`);
console.log(`msgNum             | ${st.msgNum.toString().padStart(14)} | ${nt.msgNum}`);

console.log('\n=== CONCLUSIONE ===');
console.log('Entrambi usano:');
console.log('  - channelId = 0 nel HEADER');
console.log('  - msgClass = 0x6414 (BC_CLASS_MODERN_24)');
console.log('  - streamType = 0');
console.log('\nL\'unica differenza è msgNum che è diverso per ogni sessione');
console.log('Il channelId nel HEADER è 0 per entrambi!');
