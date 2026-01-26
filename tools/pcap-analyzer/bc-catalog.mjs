#!/usr/bin/env node
/**
 * bc-catalog.mjs - Catalog PCAP packets by cmdId with statistics
 * 
 * Generates a summary of all command IDs found in the PCAP,
 * with counts, directions, and response codes.
 * 
 * Usage:
 *   node bc-catalog.mjs <pcap-file> [options]
 * 
 * Options:
 *   --camera IP    Filter by camera IP
 *   --json         Output as JSON
 *   --detailed     Show each packet, not just summary
 */

import fs from 'fs';
import { parsePcap } from './bc-pcap-parse.mjs';
import { getCmdName, formatHeader } from './bc-protocol.mjs';

/**
 * Catalog frames by cmdId
 */
export async function catalogPcap(pcapFile, options = {}) {
    const { camera, detailed } = options;
    const result = await parsePcap(pcapFile);

    const catalog = {};
    const sessions = new Map();
    const packets = [];

    for (const frame of result.frames) {
        // Filter by camera
        if (camera && !frame.server.includes(camera)) continue;

        const cmdId = frame.header.cmdId;
        const cmdName = getCmdName(cmdId);

        // Track sessions
        const sessionKey = `${frame.client}-${frame.server}`;
        if (!sessions.has(sessionKey)) {
            sessions.set(sessionKey, {
                client: frame.client,
                server: frame.server,
                requestCount: 0,
                responseCount: 0,
            });
        }
        const session = sessions.get(sessionKey);
        if (frame.direction === 'request') {
            session.requestCount++;
        } else {
            session.responseCount++;
        }

        // Catalog by cmdId
        if (!catalog[cmdId]) {
            catalog[cmdId] = {
                cmdId,
                cmdName,
                requestCount: 0,
                responseCount: 0,
                successCount: 0,
                errorCount: 0,
                responseCodes: {},
                minBodyLen: Infinity,
                maxBodyLen: 0,
                totalBodyLen: 0,
            };
        }

        const entry = catalog[cmdId];
        if (frame.direction === 'request') {
            entry.requestCount++;
        } else {
            entry.responseCount++;
            const rc = frame.header.responseCode;
            entry.responseCodes[rc] = (entry.responseCodes[rc] || 0) + 1;
            if (rc === 0 || rc === 200) {
                entry.successCount++;
            } else {
                entry.errorCount++;
            }
        }

        entry.minBodyLen = Math.min(entry.minBodyLen, frame.header.bodyLen);
        entry.maxBodyLen = Math.max(entry.maxBodyLen, frame.header.bodyLen);
        entry.totalBodyLen += frame.header.bodyLen;

        if (detailed) {
            packets.push({
                direction: frame.direction,
                cmdId,
                cmdName,
                msgNum: frame.header.msgNum,
                channelId: frame.header.channelId,
                responseCode: frame.header.responseCode,
                bodyLen: frame.header.bodyLen,
                payloadOffset: frame.header.payloadOffset,
                client: frame.client,
                server: frame.server,
            });
        }
    }

    // Clean up infinity
    for (const entry of Object.values(catalog)) {
        if (entry.minBodyLen === Infinity) entry.minBodyLen = 0;
    }

    return {
        file: pcapFile,
        totalFrames: result.frameCount,
        uniqueCmdIds: Object.keys(catalog).length,
        sessions: Array.from(sessions.values()),
        catalog: Object.values(catalog).sort((a, b) => a.cmdId - b.cmdId),
        packets: detailed ? packets : undefined,
    };
}

// CLI
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help')) {
        console.log(`Usage: node bc-catalog.mjs <pcap-file> [options]

Options:
  --camera IP    Filter by camera IP
  --json         Output as JSON
  --detailed     Show each packet, not just summary
  --help         Show this help

Example:
  node bc-catalog.mjs capture.pcap --camera 192.168.1.170`);
        process.exit(0);
    }

    const pcapFile = args.find(a => !a.startsWith('--'));
    const jsonOutput = args.includes('--json');
    const detailed = args.includes('--detailed');

    const cameraIdx = args.indexOf('--camera');
    const camera = cameraIdx >= 0 ? args[cameraIdx + 1] : null;

    if (!pcapFile || !fs.existsSync(pcapFile)) {
        console.error(`Error: PCAP file not found: ${pcapFile}`);
        process.exit(1);
    }

    try {
        const result = await catalogPcap(pcapFile, { camera, detailed });

        if (jsonOutput) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log(`PCAP Catalog: ${result.file}`);
            console.log(`Total frames: ${result.totalFrames}`);
            console.log(`Unique cmdIds: ${result.uniqueCmdIds}`);
            console.log('');

            console.log('Sessions:');
            for (const session of result.sessions) {
                console.log(`  ${session.client} <-> ${session.server}`);
                console.log(`    Requests: ${session.requestCount}, Responses: ${session.responseCount}`);
            }
            console.log('');

            console.log('Command ID Catalog:');
            console.log('-'.repeat(90));
            console.log(`${'cmdId'.padEnd(8)} ${'Name'.padEnd(25)} ${'Req'.padEnd(6)} ${'Rsp'.padEnd(6)} ${'OK'.padEnd(6)} ${'Err'.padEnd(6)} ${'BodyLen'.padEnd(15)}`);
            console.log('-'.repeat(90));

            for (const entry of result.catalog) {
                const bodyRange = entry.minBodyLen === entry.maxBodyLen
                    ? entry.minBodyLen.toString()
                    : `${entry.minBodyLen}-${entry.maxBodyLen}`;
                console.log(
                    `${entry.cmdId.toString().padEnd(8)} ` +
                    `${entry.cmdName.slice(0, 24).padEnd(25)} ` +
                    `${entry.requestCount.toString().padEnd(6)} ` +
                    `${entry.responseCount.toString().padEnd(6)} ` +
                    `${entry.successCount.toString().padEnd(6)} ` +
                    `${entry.errorCount.toString().padEnd(6)} ` +
                    `${bodyRange.padEnd(15)}`
                );
            }

            if (detailed && result.packets) {
                console.log('\n' + '='.repeat(90));
                console.log('Detailed Packet List:');
                console.log('-'.repeat(90));
                for (const pkt of result.packets) {
                    const dir = pkt.direction === 'request' ? '>>>' : '<<<';
                    console.log(`${dir} cmdId=${pkt.cmdId} (${pkt.cmdName}) msgNum=${pkt.msgNum} rc=${pkt.responseCode} bodyLen=${pkt.bodyLen}`);
                }
            }
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

if (process.argv[1].includes('bc-catalog')) {
    main();
}
