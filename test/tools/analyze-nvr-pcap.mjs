#!/usr/bin/env node
/**
 * Analyze NVR pcap to extract exact replay parameters
 */

import { execSync } from 'child_process';
import { createDecipheriv } from 'crypto';

const PCAP_FILE = 'pcap/192.168.1.161 events+cover+download.pcapng';

// Extract TCP data from pcap
const rawData = execSync(
    `tshark -r "${PCAP_FILE}" -Y "tcp.port==9000" -T fields -e data -e tcp.srcport -e tcp.dstport -e frame.number 2>/dev/null`
).toString();

const lines = rawData.trim().split('\n').filter(l => l.trim());
console.log('Total packets:', lines.length);

// Parse Baichuan header
function parseHeader(hex) {
    if (!hex || hex.length < 40) return null;
    if (hex.slice(0, 8) !== 'f0debc0a') return null;

    return {
        cmdId: parseInt(hex.slice(10, 12) + hex.slice(8, 10), 16),
        encOffset: parseInt(hex.slice(14, 16) + hex.slice(12, 14), 16),
        bodyLen: parseInt(hex.slice(22, 24) + hex.slice(20, 22) + hex.slice(18, 20) + hex.slice(16, 18), 16),
        msgNum: parseInt(hex.slice(26, 28) + hex.slice(24, 26), 16),
        channelId: parseInt(hex.slice(32, 34), 16),
        streamType: parseInt(hex.slice(34, 36), 16),
        msgClass: parseInt(hex.slice(38, 40) + hex.slice(36, 38), 16),
        body: hex.slice(40)
    };
}

// AES decrypt (Baichuan uses AES-128-CFB with nonce from login)
let encKey = null;

function tryDecrypt(bodyHex, encOffset) {
    if (!encKey || encOffset === 0) {
        return Buffer.from(bodyHex, 'hex').toString('utf8');
    }
    try {
        const encrypted = Buffer.from(bodyHex, 'hex');
        const iv = Buffer.alloc(16, 0);
        const decipher = createDecipheriv('aes-128-cfb', encKey, iv);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return decrypted.toString('utf8');
    } catch {
        return Buffer.from(bodyHex, 'hex').toString('utf8');
    }
}

// Find cmdId=5 frames
console.log('\n=== Analyzing cmdId=5 (Replay) frames ===\n');

let cmdId5Request = null;
let cmdId5Response = null;

for (const line of lines) {
    const [hex, srcport, dstport, frameNum] = line.split('\t');
    const hdr = parseHeader(hex);
    if (!hdr) continue;

    const dir = srcport === '9000' ? 'RX' : 'TX';

    // Look for cmdId=5
    if (hdr.cmdId === 5) {
        console.log(`Frame ${frameNum}: ${dir} cmdId=${hdr.cmdId} bodyLen=${hdr.bodyLen} msgNum=${hdr.msgNum} channelId=${hdr.channelId} streamType=${hdr.streamType} msgClass=0x${hdr.msgClass.toString(16)} encOffset=${hdr.encOffset}`);

        // TX is the request from client
        if (dir === 'TX' && !cmdId5Request) {
            cmdId5Request = { ...hdr, frameNum, bodyHex: hdr.body };
        }
        // First RX is the response
        if (dir === 'RX' && !cmdId5Response && cmdId5Request) {
            cmdId5Response = { ...hdr, frameNum, bodyHex: hdr.body };
            // After finding request and response, break
            break;
        }
    }

    // Look for login (cmdId=1) to extract nonce
    if (hdr.cmdId === 1 && dir === 'RX' && hdr.bodyLen > 0 && hdr.bodyLen < 500) {
        const body = tryDecrypt(hdr.body.slice(0, hdr.bodyLen * 2), 0);
        if (body.includes('nonce')) {
            const nonceMatch = body.match(/<nonce>([^<]+)<\/nonce>/);
            if (nonceMatch) {
                console.log('Found nonce:', nonceMatch[1]);
            }
        }
    }
}

if (cmdId5Request) {
    console.log('\n=== cmdId=5 REQUEST (from client to NVR) ===');
    console.log('Header:');
    console.log('  cmdId:', cmdId5Request.cmdId);
    console.log('  bodyLen:', cmdId5Request.bodyLen);
    console.log('  msgNum:', cmdId5Request.msgNum);
    console.log('  channelId:', cmdId5Request.channelId);
    console.log('  streamType:', cmdId5Request.streamType);
    console.log('  msgClass: 0x' + cmdId5Request.msgClass.toString(16), `(${cmdId5Request.msgClass})`);
    console.log('  encOffset:', cmdId5Request.encOffset);

    // Try to show body (may be encrypted)
    if (cmdId5Request.bodyLen < 1000) {
        const bodyHex = cmdId5Request.bodyHex.slice(0, cmdId5Request.bodyLen * 2);
        console.log('\nBody hex (first 200 chars):', bodyHex.slice(0, 200));

        // Try plain decode
        const plain = Buffer.from(bodyHex, 'hex').toString('utf8');
        if (plain.includes('<?xml') || plain.includes('<body>') || plain.includes('<FileInfo')) {
            console.log('\nDecoded XML:');
            console.log(plain);
        } else {
            console.log('\nBody appears to be encrypted');
        }
    }
}

if (cmdId5Response) {
    console.log('\n=== cmdId=5 RESPONSE (from NVR to client) ===');
    console.log('Header:');
    console.log('  cmdId:', cmdId5Response.cmdId);
    console.log('  bodyLen:', cmdId5Response.bodyLen);
    console.log('  msgNum:', cmdId5Response.msgNum);
    console.log('  channelId:', cmdId5Response.channelId);
    console.log('  streamType:', cmdId5Response.streamType);
    console.log('  msgClass: 0x' + cmdId5Response.msgClass.toString(16), `(${cmdId5Response.msgClass})`);
}
