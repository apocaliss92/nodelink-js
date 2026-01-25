#!/usr/bin/env node
/**
 * Analyze NVR PCAP to find channel ID mapping
 * 
 * Looking for:
 * 1. UID mappings in login or device info responses
 * 2. Channel registration messages
 * 3. Any message that maps logical channel (0,1,2) to header channelId
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PCAP_DIR = join(__dirname, '../../pcap');

// Baichuan command IDs
const CMD_IDS = {
    1: 'LOGIN',
    3: 'DEVICE_INFO',
    5: 'FILE_INFO_LIST_REPLAY',
    6: 'FILE_INFO_LIST_STOP',
    7: 'FILE_INFO_LIST_DL',
    8: 'FILE_INFO_LIST_DL_VIDEO',
    78: 'ABILITY_INFO',
    79: 'CHANNEL_INFO',
    80: 'CHANNEL_STATUS',
    93: 'ABILITY_SUPPORT',
    114: 'PUSH_EVENT',
    115: 'STREAM_INFO',
    145: 'RECORD_INFO',
    150: 'CAMERA_LIST', // Potrebbe contenere mapping
};

function parseHeader(hex) {
    if (!hex || hex.length < 40) return null;
    if (hex.slice(0, 8) !== 'f0debc0a') return null;

    const u16le = (offset) => parseInt(hex.slice(offset * 2 + 2, offset * 2 + 4) + hex.slice(offset * 2, offset * 2 + 2), 16);
    const u32le = (offset) => parseInt(
        hex.slice(offset * 2 + 6, offset * 2 + 8) +
        hex.slice(offset * 2 + 4, offset * 2 + 6) +
        hex.slice(offset * 2 + 2, offset * 2 + 4) +
        hex.slice(offset * 2, offset * 2 + 2), 16
    );
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
        bodyHex: hex.slice(40)
    };
}

function analyzePcap(pcapFile) {
    console.log(`\n=== Analyzing: ${pcapFile} ===\n`);

    const fullPath = join(PCAP_DIR, pcapFile);
    if (!existsSync(fullPath)) {
        console.log(`File not found: ${fullPath}`);
        return;
    }

    // Extract packets
    let rawData;
    try {
        rawData = execSync(
            `tshark -r "${fullPath}" -Y "tcp.port==9000 && tcp.len > 20" -T fields -e frame.number -e tcp.srcport -e tcp.dstport -e data 2>/dev/null | head -500`
        ).toString();
    } catch (e) {
        console.log('tshark failed:', e.message);
        return;
    }

    const lines = rawData.trim().split('\n').filter(l => l.trim());
    console.log(`Total packets (first 500): ${lines.length}`);

    // Track unique cmdIds and channelIds
    const cmdIdStats = {};
    const channelIdUsage = {};
    const interestingMessages = [];

    for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length < 4) continue;

        const [frameNum, srcPort, dstPort, hex] = parts;
        const hdr = parseHeader(hex);
        if (!hdr) continue;

        const dir = srcPort === '9000' ? 'RX' : 'TX';
        const cmdName = CMD_IDS[hdr.cmdId] || `CMD_${hdr.cmdId}`;

        // Track stats
        cmdIdStats[cmdName] = (cmdIdStats[cmdName] || 0) + 1;

        const key = `${dir}_ch${hdr.channelId}`;
        channelIdUsage[key] = (channelIdUsage[key] || 0) + 1;

        // Look for channel mapping commands
        if ([3, 78, 79, 80, 93, 115, 145, 150].includes(hdr.cmdId) && hdr.bodyLen > 0 && hdr.bodyLen < 2000) {
            // Try to decode body (might be encrypted)
            const bodyHex = hdr.bodyHex.slice(0, Math.min(hdr.bodyLen * 2, 400));
            const bodyText = Buffer.from(bodyHex, 'hex').toString('utf8');

            // Look for channel-related content
            if (bodyText.includes('channel') || bodyText.includes('Channel') ||
                bodyText.includes('uid') || bodyText.includes('UID') ||
                bodyText.includes('Camera') || bodyText.includes('camera')) {
                interestingMessages.push({
                    frame: frameNum,
                    dir,
                    cmdId: hdr.cmdId,
                    cmdName,
                    channelId: hdr.channelId,
                    bodyLen: hdr.bodyLen,
                    preview: bodyText.slice(0, 200).replace(/[^\x20-\x7E]/g, '.')
                });
            }
        }

        // Also log cmdId=5 requests
        if (hdr.cmdId === 5 && dir === 'TX') {
            console.log(`\nReplay Request (frame ${frameNum}):`);
            console.log(`  Header channelId: ${hdr.channelId}`);
            console.log(`  msgNum: ${hdr.msgNum}`);
            console.log(`  bodyLen: ${hdr.bodyLen}`);
        }
    }

    console.log('\n--- Command ID Statistics ---');
    for (const [cmd, count] of Object.entries(cmdIdStats).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${cmd}: ${count}`);
    }

    console.log('\n--- Channel ID Usage ---');
    for (const [key, count] of Object.entries(channelIdUsage).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${key}: ${count}`);
    }

    if (interestingMessages.length > 0) {
        console.log('\n--- Interesting Messages (channel/uid related) ---');
        for (const msg of interestingMessages) {
            console.log(`\nFrame ${msg.frame} [${msg.dir}] ${msg.cmdName} (channelId=${msg.channelId}, bodyLen=${msg.bodyLen}):`);
            console.log(`  ${msg.preview}`);
        }
    }
}

// Analyze NVR pcaps
const nvrPcaps = [
    '192.168.1.161 events+cover+download.pcapng',
    '192.168.1.161 channel 0 settings.pcapng',
];

for (const pcap of nvrPcaps) {
    analyzePcap(pcap);
}
