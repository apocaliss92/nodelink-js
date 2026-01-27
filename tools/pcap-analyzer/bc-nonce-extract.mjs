#!/usr/bin/env node
/**
 * bc-nonce-extract.mjs - Extract login nonce from PCAP
 * 
 * Finds login (cmdId=1) response packets and extracts the nonce
 * needed for AES key derivation.
 * 
 * Usage:
 *   node bc-nonce-extract.mjs <pcap-file> [options]
 * 
 * Options:
 *   --camera IP    Filter by camera IP
 *   --all          Show all nonces (not just first)
 *   --json         Output as JSON
 */

import fs from 'fs';
import { parsePcap } from './bc-pcap-parse.mjs';
import { bcXor, extractNonceFromXml, determineEncryptionType, tryParseXml } from './bc-protocol.mjs';

/**
 * Extract nonce from login response frame
 */
function extractNonceFromFrame(frame) {
    if (frame.header.cmdId !== 1) return null;
    if (frame.direction !== 'response') return null;
    // Login success codes: 200, 0, or Reolink-specific 56594 (0xDD12), 56338 (0xDC12)
    const validCodes = [0, 200, 56594, 56338];
    if (!validCodes.includes(frame.header.responseCode)) return null;
    if (frame.body.length === 0) return null;

    // Login response body is BC-XOR encrypted
    const channelId = frame.header.channelId;
    const decrypted = bcXor(frame.body, channelId);

    // For login response, the entire body is XML (no extension).
    // payloadOffset may be garbage if header is 20 bytes, so try full body first.
    let payloadXml = tryParseXml(decrypted);

    // If that fails and payloadOffset looks valid, try using it
    if (!payloadXml) {
        const payloadOffset = frame.header.payloadOffset;
        if (payloadOffset > 0 && payloadOffset < decrypted.length) {
            const payload = decrypted.subarray(payloadOffset);
            payloadXml = tryParseXml(payload);
        }
    }

    if (!payloadXml) return null;

    const nonce = extractNonceFromXml(payloadXml);
    if (!nonce) return null;

    const encryptionType = determineEncryptionType(payloadXml);

    return {
        nonce,
        encryptionType,
        channelId,
        xml: payloadXml,
    };
}

/**
 * Find all nonces in PCAP
 */
export async function findNonces(pcapFile, options = {}) {
    const result = await parsePcap(pcapFile);
    const nonces = [];

    for (const frame of result.frames) {
        // Filter by camera if specified
        if (options.camera) {
            if (!frame.server.includes(options.camera)) continue;
        }

        const nonceInfo = extractNonceFromFrame(frame);
        if (nonceInfo) {
            nonces.push({
                ...nonceInfo,
                client: frame.client,
                server: frame.server,
            });

            // Only first nonce unless --all
            if (!options.all) break;
        }
    }

    return nonces;
}

// CLI
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help')) {
        console.log(`Usage: node bc-nonce-extract.mjs <pcap-file> [options]

Options:
  --camera IP    Filter by camera IP
  --all          Show all nonces (not just first)
  --json         Output as JSON
  --help         Show this help

Example:
  node bc-nonce-extract.mjs capture.pcap --camera 192.168.1.170`);
        process.exit(0);
    }

    const pcapFile = args.find(a => !a.startsWith('--'));
    const jsonOutput = args.includes('--json');
    const all = args.includes('--all');
    const cameraIdx = args.indexOf('--camera');
    const camera = cameraIdx >= 0 ? args[cameraIdx + 1] : null;

    if (!pcapFile || !fs.existsSync(pcapFile)) {
        console.error(`Error: PCAP file not found: ${pcapFile}`);
        process.exit(1);
    }

    try {
        const nonces = await findNonces(pcapFile, { camera, all });

        if (nonces.length === 0) {
            console.error('No login nonces found in PCAP');
            process.exit(1);
        }

        if (jsonOutput) {
            console.log(JSON.stringify(nonces, null, 2));
        } else {
            for (const n of nonces) {
                console.log('='.repeat(60));
                console.log(`Session: ${n.client} -> ${n.server}`);
                console.log(`Nonce: ${n.nonce}`);
                console.log(`Encryption: ${n.encryptionType}`);
                console.log(`ChannelId: ${n.channelId}`);
                if (args.includes('--verbose')) {
                    console.log('\nLogin Response XML:');
                    console.log(n.xml);
                }
            }
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

if (process.argv[1].includes('bc-nonce-extract')) {
    main();
}
