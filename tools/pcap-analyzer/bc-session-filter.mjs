#!/usr/bin/env node
/**
 * bc-session-filter.mjs - Filter PCAP by session (IP/port pair)
 * 
 * Extracts packets from a specific session/connection in the PCAP.
 * 
 * Usage:
 *   node bc-session-filter.mjs <pcap-file> [options]
 * 
 * Options:
 *   --camera IP    Filter by camera IP (server IP)
 *   --client IP    Filter by client IP
 *   --list         List all sessions in the PCAP
 *   --json         Output as JSON
 */

import fs from 'fs';
import { parsePcap } from './bc-pcap-parse.mjs';
import { formatHeader, getCmdName } from './bc-protocol.mjs';

/**
 * List all sessions in PCAP
 */
export async function listSessions(pcapFile) {
    const result = await parsePcap(pcapFile);
    const sessions = new Map();

    for (const frame of result.frames) {
        const key = `${frame.client}-${frame.server}`;
        if (!sessions.has(key)) {
            sessions.set(key, {
                client: frame.client,
                server: frame.server,
                frameCount: 0,
                cmdIds: new Set(),
                firstFrame: frame,
            });
        }
        const session = sessions.get(key);
        session.frameCount++;
        session.cmdIds.add(frame.header.cmdId);
    }

    return Array.from(sessions.values()).map(s => ({
        client: s.client,
        server: s.server,
        frameCount: s.frameCount,
        cmdIds: Array.from(s.cmdIds).sort((a, b) => a - b),
    }));
}

/**
 * Filter frames by session
 */
export async function filterSession(pcapFile, options = {}) {
    const { camera, client } = options;
    const result = await parsePcap(pcapFile);

    const filteredFrames = result.frames.filter(frame => {
        if (camera && !frame.server.includes(camera)) return false;
        if (client && !frame.client.includes(client)) return false;
        return true;
    });

    return {
        file: pcapFile,
        totalFrames: result.frameCount,
        filteredFrames: filteredFrames.length,
        camera,
        client,
        frames: filteredFrames.map(f => ({
            direction: f.direction,
            cmdId: f.header.cmdId,
            cmdName: getCmdName(f.header.cmdId),
            msgNum: f.header.msgNum,
            channelId: f.header.channelId,
            responseCode: f.header.responseCode,
            bodyLen: f.header.bodyLen,
            payloadOffset: f.header.payloadOffset,
            messageClass: f.header.messageClass,
            streamType: f.header.streamType,
            client: f.client,
            server: f.server,
            headerHex: f.headerBytes.toString('hex'),
            bodyPreview: f.body.length > 0 ? f.body.subarray(0, 50).toString('hex') : '',
        })),
    };
}

// CLI
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help')) {
        console.log(`Usage: node bc-session-filter.mjs <pcap-file> [options]

Options:
  --camera IP    Filter by camera IP (server IP)
  --client IP    Filter by client IP
  --list         List all sessions in the PCAP
  --json         Output as JSON
  --help         Show this help

Examples:
  node bc-session-filter.mjs capture.pcap --list
  node bc-session-filter.mjs capture.pcap --camera 192.168.1.170`);
        process.exit(0);
    }

    const pcapFile = args.find(a => !a.startsWith('--'));
    const jsonOutput = args.includes('--json');
    const listMode = args.includes('--list');

    const cameraIdx = args.indexOf('--camera');
    const camera = cameraIdx >= 0 ? args[cameraIdx + 1] : null;

    const clientIdx = args.indexOf('--client');
    const client = clientIdx >= 0 ? args[clientIdx + 1] : null;

    if (!pcapFile || !fs.existsSync(pcapFile)) {
        console.error(`Error: PCAP file not found: ${pcapFile}`);
        process.exit(1);
    }

    try {
        if (listMode) {
            const sessions = await listSessions(pcapFile);

            if (jsonOutput) {
                console.log(JSON.stringify(sessions, null, 2));
            } else {
                console.log(`Sessions in ${pcapFile}:`);
                console.log('-'.repeat(80));
                for (const s of sessions) {
                    console.log(`  ${s.client} <-> ${s.server}`);
                    console.log(`    Frames: ${s.frameCount}`);
                    console.log(`    CmdIds: ${s.cmdIds.map(id => `${id}(${getCmdName(id)})`).join(', ')}`);
                    console.log('');
                }
            }
        } else {
            const result = await filterSession(pcapFile, { camera, client });

            if (jsonOutput) {
                console.log(JSON.stringify(result, null, 2));
            } else {
                console.log(`Session Filter: ${result.file}`);
                console.log(`Total frames: ${result.totalFrames}`);
                console.log(`Filtered frames: ${result.filteredFrames}`);
                if (camera) console.log(`Camera: ${camera}`);
                if (client) console.log(`Client: ${client}`);
                console.log('');
                console.log('-'.repeat(80));

                for (const frame of result.frames) {
                    const dir = frame.direction === 'request' ? '>>>' : '<<<';
                    console.log(`${dir} cmdId=${frame.cmdId} (${frame.cmdName})`);
                    console.log(`    msgNum=${frame.msgNum} channelId=${frame.channelId} rc=${frame.responseCode}`);
                    console.log(`    bodyLen=${frame.bodyLen} payloadOffset=${frame.payloadOffset}`);
                    console.log(`    Header: ${frame.headerHex}`);
                    if (frame.bodyPreview) {
                        console.log(`    Body preview: ${frame.bodyPreview}...`);
                    }
                    console.log('');
                }
            }
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

if (process.argv[1].includes('bc-session-filter')) {
    main();
}
