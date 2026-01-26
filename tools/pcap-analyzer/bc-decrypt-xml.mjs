#!/usr/bin/env node
/**
 * bc-decrypt-xml.mjs - Decrypt XML payloads from PCAP frames
 * 
 * Given a nonce and password, derives the AES key and decrypts
 * all XML payloads in the PCAP file.
 * 
 * Usage:
 *   node bc-decrypt-xml.mjs <pcap-file> --password <pwd> [options]
 * 
 * Options:
 *   --password PWD  Password for AES key derivation (required)
 *   --nonce NONCE   Use specific nonce (otherwise auto-extracted)
 *   --camera IP     Filter by camera IP
 *   --cmdId ID      Filter by command ID
 *   --json          Output as JSON
 */

import fs from 'fs';
import crypto from 'crypto';
import { parsePcap } from './bc-pcap-parse.mjs';
import { findNonces } from './bc-nonce-extract.mjs';
import {
    bcXor,
    BC_AES_IV,
    tryParseXml,
    looksLikeXml,
    getCmdName
} from './bc-protocol.mjs';

/**
 * Derive AES key from nonce and password
 */
function deriveAesKey(nonce, password) {
    const combined = `${nonce}-${password}`;
    const md5 = crypto.createHash('md5').update(combined, 'utf8').digest('hex').toUpperCase();
    return Buffer.from(md5.slice(0, 16), 'utf8');
}

/**
 * AES decrypt
 */
function aesDecrypt(buf, key) {
    if (buf.length === 0) return Buffer.alloc(0);
    const decipher = crypto.createDecipheriv('aes-128-cfb', key, BC_AES_IV);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(buf), decipher.final()]);
}

/**
 * Try to decrypt frame body and extract XML
 */
function decryptFrame(frame, aesKey, encType) {
    if (frame.body.length === 0) return null;

    const channelId = frame.header.channelId;
    const payloadOffset = frame.header.payloadOffset;

    let decrypted;

    // cmdId=1 is always BC-XOR encrypted
    if (frame.header.cmdId === 1) {
        decrypted = bcXor(frame.body, channelId);
    } else if (encType === 'full_aes' && aesKey) {
        decrypted = aesDecrypt(frame.body, aesKey);
    } else if (encType === 'bc') {
        decrypted = bcXor(frame.body, channelId);
    } else {
        // Try both
        decrypted = frame.body;
        if (!looksLikeXml(decrypted) && aesKey) {
            decrypted = aesDecrypt(frame.body, aesKey);
        }
        if (!looksLikeXml(decrypted)) {
            decrypted = bcXor(frame.body, channelId);
        }
    }

    // Split extension and payload
    const extension = decrypted.subarray(0, payloadOffset);
    const payload = decrypted.subarray(payloadOffset);

    const extXml = tryParseXml(extension);
    const payloadXml = tryParseXml(payload);

    // Check if payload is binary
    const isBinary = !payloadXml && payload.length > 0;

    return {
        extensionXml: extXml,
        payloadXml: payloadXml,
        isBinary,
        binaryLen: isBinary ? payload.length : 0,
        rawExtension: extension,
        rawPayload: payload,
    };
}

/**
 * Decrypt all frames in PCAP
 */
export async function decryptPcap(pcapFile, options = {}) {
    const { password, nonce: providedNonce, camera, cmdId } = options;

    if (!password) {
        throw new Error('Password is required for decryption');
    }

    // Get nonce
    let nonce = providedNonce;
    let encType = 'full_aes';

    if (!nonce) {
        const nonces = await findNonces(pcapFile, { camera });
        if (nonces.length > 0) {
            nonce = nonces[0].nonce;
            encType = nonces[0].encryptionType;
        }
    }

    if (!nonce) {
        throw new Error('Could not find nonce in PCAP. Use --nonce to specify manually.');
    }

    const aesKey = deriveAesKey(nonce, password);

    // Parse PCAP
    const pcapResult = await parsePcap(pcapFile);
    const decryptedFrames = [];

    for (const frame of pcapResult.frames) {
        // Filter by camera
        if (camera && !frame.server.includes(camera)) continue;

        // Filter by cmdId
        if (cmdId !== undefined && frame.header.cmdId !== parseInt(cmdId)) continue;

        const decrypted = decryptFrame(frame, aesKey, encType);

        decryptedFrames.push({
            direction: frame.direction,
            client: frame.client,
            server: frame.server,
            cmdId: frame.header.cmdId,
            cmdName: getCmdName(frame.header.cmdId),
            msgNum: frame.header.msgNum,
            channelId: frame.header.channelId,
            responseCode: frame.header.responseCode,
            bodyLen: frame.header.bodyLen,
            payloadOffset: frame.header.payloadOffset,
            ...decrypted,
        });
    }

    return {
        file: pcapFile,
        nonce,
        aesKeyHex: aesKey.toString('hex'),
        encryptionType: encType,
        frameCount: decryptedFrames.length,
        frames: decryptedFrames,
    };
}

// CLI
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help')) {
        console.log(`Usage: node bc-decrypt-xml.mjs <pcap-file> --password <pwd> [options]

Options:
  --password PWD  Password for AES key derivation (required)
  --nonce NONCE   Use specific nonce (otherwise auto-extracted)
  --camera IP     Filter by camera IP
  --cmdId ID      Filter by command ID
  --json          Output as JSON
  --help          Show this help

Example:
  node bc-decrypt-xml.mjs capture.pcap --password MyPass123 --cmdId 5`);
        process.exit(0);
    }

    const pcapFile = args.find(a => !a.startsWith('--'));
    const jsonOutput = args.includes('--json');

    const pwdIdx = args.indexOf('--password');
    const password = pwdIdx >= 0 ? args[pwdIdx + 1] : null;

    const nonceIdx = args.indexOf('--nonce');
    const nonce = nonceIdx >= 0 ? args[nonceIdx + 1] : null;

    const cameraIdx = args.indexOf('--camera');
    const camera = cameraIdx >= 0 ? args[cameraIdx + 1] : null;

    const cmdIdIdx = args.indexOf('--cmdId');
    const cmdId = cmdIdIdx >= 0 ? args[cmdIdIdx + 1] : undefined;

    if (!pcapFile || !fs.existsSync(pcapFile)) {
        console.error(`Error: PCAP file not found: ${pcapFile}`);
        process.exit(1);
    }

    if (!password) {
        console.error('Error: --password is required');
        process.exit(1);
    }

    try {
        const result = await decryptPcap(pcapFile, { password, nonce, camera, cmdId });

        if (jsonOutput) {
            // Convert buffers to hex for JSON
            const jsonResult = {
                ...result,
                frames: result.frames.map(f => ({
                    ...f,
                    rawExtension: undefined,
                    rawPayload: undefined,
                })),
            };
            console.log(JSON.stringify(jsonResult, null, 2));
        } else {
            console.log(`PCAP: ${result.file}`);
            console.log(`Nonce: ${result.nonce}`);
            console.log(`AES Key: ${result.aesKeyHex}`);
            console.log(`Encryption: ${result.encryptionType}`);
            console.log(`Frames: ${result.frameCount}`);
            console.log('');

            for (const frame of result.frames) {
                const dir = frame.direction === 'request' ? '>>>' : '<<<';
                console.log('='.repeat(70));
                console.log(`${dir} cmdId=${frame.cmdId} (${frame.cmdName}) msgNum=${frame.msgNum} responseCode=${frame.responseCode}`);
                console.log(`    ${frame.client} -> ${frame.server}`);

                if (frame.extensionXml) {
                    console.log('\n  Extension XML:');
                    console.log('  ' + frame.extensionXml.split('\n').join('\n  '));
                }

                if (frame.payloadXml) {
                    console.log('\n  Payload XML:');
                    console.log('  ' + frame.payloadXml.split('\n').join('\n  '));
                }

                if (frame.isBinary) {
                    console.log(`\n  Binary payload: ${frame.binaryLen} bytes`);
                }
            }
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

if (process.argv[1].includes('bc-decrypt-xml')) {
    main();
}
