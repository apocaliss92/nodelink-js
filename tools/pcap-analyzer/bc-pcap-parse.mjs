#!/usr/bin/env node
/**
 * bc-pcap-parse.mjs - Parse Baichuan frames from PCAP file
 * 
 * Extracts all Baichuan protocol frames from a PCAP/PCAPNG file,
 * reassembling TCP streams and identifying individual packets.
 * 
 * Usage:
 *   node bc-pcap-parse.mjs <pcap-file> [options]
 * 
 * Options:
 *   --json         Output as JSON
 *   --verbose      Show detailed packet info
 *   --output FILE  Write output to file
 */

import fs from 'fs';
import path from 'path';
import { BC_MAGIC, BC_MAGIC_BYTES, parseHeader, formatHeader, getHeaderSize } from './bc-protocol.mjs';

// Simple PCAP parser (pcap format, not pcapng)
function parsePcapGlobal(buf) {
    const magic = buf.readUInt32LE(0);
    const isPcap = magic === 0xa1b2c3d4 || magic === 0xd4c3b2a1;
    const isPcapNg = buf.readUInt32LE(0) === 0x0a0d0d0a;

    if (!isPcap && !isPcapNg) {
        throw new Error('Not a valid PCAP or PCAPNG file');
    }

    return { isPcap, isPcapNg, magic };
}

// TCP stream reassembly structure
class TcpStream {
    constructor(key) {
        this.key = key;
        this.buffer = Buffer.alloc(0);
        this.frames = [];
    }

    addData(data) {
        this.buffer = Buffer.concat([this.buffer, data]);
        this.extractFrames();
    }

    extractFrames() {
        while (this.buffer.length >= 20) {
            // Look for magic
            const magicIdx = this.buffer.indexOf(BC_MAGIC_BYTES);
            if (magicIdx === -1) {
                // No magic found, keep last 3 bytes (partial magic possible)
                if (this.buffer.length > 3) {
                    this.buffer = this.buffer.subarray(this.buffer.length - 3);
                }
                break;
            }

            // Discard data before magic
            if (magicIdx > 0) {
                this.buffer = this.buffer.subarray(magicIdx);
            }

            // Try to parse header
            const header = parseHeader(this.buffer);
            if (!header) break;

            const totalLen = header.headerSize + header.bodyLen;
            if (this.buffer.length < totalLen) {
                // Need more data
                break;
            }

            // Extract complete frame
            const frameData = this.buffer.subarray(0, totalLen);
            const body = this.buffer.subarray(header.headerSize, totalLen);

            this.frames.push({
                header,
                headerBytes: frameData.subarray(0, header.headerSize),
                body,
                totalLen,
            });

            this.buffer = this.buffer.subarray(totalLen);
        }
    }
}

// Parse raw PCAP (not pcapng) - simplified
function parsePcapPackets(buf) {
    const packets = [];
    let offset = 24; // Skip global header

    while (offset + 16 <= buf.length) {
        // Packet header: ts_sec(4), ts_usec(4), incl_len(4), orig_len(4)
        const inclLen = buf.readUInt32LE(offset + 8);
        offset += 16;

        if (offset + inclLen > buf.length) break;

        const packetData = buf.subarray(offset, offset + inclLen);
        packets.push(packetData);
        offset += inclLen;
    }

    return packets;
}

// Extract TCP payload from Ethernet frame
function extractTcpPayload(packet) {
    if (packet.length < 54) return null; // Min Ethernet + IP + TCP

    // Ethernet header: 14 bytes
    const etherType = packet.readUInt16BE(12);
    if (etherType !== 0x0800) return null; // Not IPv4

    // IP header
    const ipHeaderLen = (packet[14] & 0x0f) * 4;
    const protocol = packet[23];
    if (protocol !== 6) return null; // Not TCP

    const ipStart = 14;
    const srcIp = `${packet[ipStart + 12]}.${packet[ipStart + 13]}.${packet[ipStart + 14]}.${packet[ipStart + 15]}`;
    const dstIp = `${packet[ipStart + 16]}.${packet[ipStart + 17]}.${packet[ipStart + 18]}.${packet[ipStart + 19]}`;

    // TCP header
    const tcpStart = 14 + ipHeaderLen;
    const srcPort = packet.readUInt16BE(tcpStart);
    const dstPort = packet.readUInt16BE(tcpStart + 2);
    const tcpHeaderLen = ((packet[tcpStart + 12] >> 4) & 0x0f) * 4;

    const payloadStart = tcpStart + tcpHeaderLen;
    if (payloadStart >= packet.length) return null;

    const payload = packet.subarray(payloadStart);
    if (payload.length === 0) return null;

    return {
        srcIp,
        srcPort,
        dstIp,
        dstPort,
        payload,
        key: `${srcIp}:${srcPort}-${dstIp}:${dstPort}`,
    };
}

// Main parsing function
export async function parsePcap(filePath, options = {}) {
    const buf = fs.readFileSync(filePath);
    const { isPcapNg } = parsePcapGlobal(buf);

    if (isPcapNg) {
        console.error('Note: PCAPNG format detected. For best results, convert to PCAP format:');
        console.error('  editcap -F pcap input.pcapng output.pcap');
        console.error('Attempting basic parsing anyway...\n');
    }

    const packets = parsePcapPackets(buf);
    const streams = new Map();
    const allFrames = [];

    for (const packet of packets) {
        const tcp = extractTcpPayload(packet);
        if (!tcp) continue;

        // Only process port 9000 traffic
        if (tcp.srcPort !== 9000 && tcp.dstPort !== 9000) continue;

        if (!streams.has(tcp.key)) {
            streams.set(tcp.key, new TcpStream(tcp.key));
        }

        const stream = streams.get(tcp.key);
        stream.addData(tcp.payload);
    }

    // Collect all frames from all streams
    for (const [key, stream] of streams) {
        const [src, dst] = key.split('-');
        const isRequest = dst.endsWith(':9000');

        for (const frame of stream.frames) {
            allFrames.push({
                ...frame,
                streamKey: key,
                direction: isRequest ? 'request' : 'response',
                client: isRequest ? src : dst,
                server: isRequest ? dst : src,
            });
        }
    }

    return {
        file: path.basename(filePath),
        packetCount: packets.length,
        streamCount: streams.size,
        frameCount: allFrames.length,
        frames: allFrames,
    };
}

// CLI
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help')) {
        console.log(`Usage: node bc-pcap-parse.mjs <pcap-file> [options]

Options:
  --json         Output as JSON
  --verbose      Show detailed packet info
  --output FILE  Write output to file
  --help         Show this help`);
        process.exit(0);
    }

    const pcapFile = args.find(a => !a.startsWith('--'));
    const jsonOutput = args.includes('--json');
    const verbose = args.includes('--verbose');
    const outputIdx = args.indexOf('--output');
    const outputFile = outputIdx >= 0 ? args[outputIdx + 1] : null;

    if (!pcapFile || !fs.existsSync(pcapFile)) {
        console.error(`Error: PCAP file not found: ${pcapFile}`);
        process.exit(1);
    }

    try {
        const result = await parsePcap(pcapFile, { verbose });

        if (jsonOutput) {
            // Convert buffers to hex for JSON
            const jsonResult = {
                ...result,
                frames: result.frames.map(f => ({
                    header: f.header,
                    headerHex: f.headerBytes.toString('hex'),
                    bodyHex: f.body.toString('hex').slice(0, 200) + (f.body.length > 100 ? '...' : ''),
                    bodyLen: f.body.length,
                    direction: f.direction,
                    client: f.client,
                    server: f.server,
                })),
            };
            const output = JSON.stringify(jsonResult, null, 2);
            if (outputFile) {
                fs.writeFileSync(outputFile, output);
                console.log(`Output written to ${outputFile}`);
            } else {
                console.log(output);
            }
        } else {
            console.log(`PCAP Analysis: ${result.file}`);
            console.log(`  Raw packets: ${result.packetCount}`);
            console.log(`  TCP streams: ${result.streamCount}`);
            console.log(`  BC frames:   ${result.frameCount}`);
            console.log('');

            for (const frame of result.frames) {
                const dir = frame.direction === 'request' ? '>>>' : '<<<';
                console.log(`${dir} ${formatHeader(frame.header)}`);
                if (verbose && frame.body.length > 0 && frame.body.length < 500) {
                    console.log(`    Body (${frame.body.length} bytes): ${frame.body.toString('hex').slice(0, 100)}...`);
                }
            }
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

// Run if executed directly
if (process.argv[1]?.includes('bc-pcap-parse')) {
    main();
}
