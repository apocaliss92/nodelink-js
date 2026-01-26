#!/usr/bin/env node
/**
 * bc-report.mjs - Generate comprehensive PCAP analysis report
 * 
 * Combines all analysis tools to generate a full report including:
 * - Session identification
 * - Nonce extraction
 * - Command catalog
 * - Decrypted XML payloads
 * 
 * Usage:
 *   node bc-report.mjs <pcap-file> --password <pwd> [options]
 * 
 * Options:
 *   --password PWD  Password for AES decryption
 *   --camera IP     Filter by camera IP
 *   --output FILE   Write report to file
 *   --json          Output as JSON
 */

import fs from 'fs';
import path from 'path';
import { parsePcap } from './bc-pcap-parse.mjs';
import { findNonces } from './bc-nonce-extract.mjs';
import { decryptPcap } from './bc-decrypt-xml.mjs';
import { catalogPcap } from './bc-catalog.mjs';
import { listSessions } from './bc-session-filter.mjs';
import { getCmdName } from './bc-protocol.mjs';

/**
 * Generate full report
 */
export async function generateReport(pcapFile, options = {}) {
    const { password, camera } = options;

    const report = {
        file: path.basename(pcapFile),
        generatedAt: new Date().toISOString(),
        options: { camera },
    };

    // 1. Sessions
    console.error('Analyzing sessions...');
    report.sessions = await listSessions(pcapFile);
    if (camera) {
        report.sessions = report.sessions.filter(s => s.server.includes(camera));
    }

    // 2. Nonces
    console.error('Extracting nonces...');
    try {
        report.nonces = await findNonces(pcapFile, { camera, all: true });
    } catch (err) {
        report.nonces = [];
        report.nonceError = err.message;
    }

    // 3. Catalog
    console.error('Cataloging commands...');
    const catalog = await catalogPcap(pcapFile, { camera });
    report.catalog = catalog.catalog;
    report.totalFrames = catalog.totalFrames;

    // 4. Decrypted frames (if password provided)
    if (password && report.nonces.length > 0) {
        console.error('Decrypting payloads...');
        try {
            const decrypted = await decryptPcap(pcapFile, {
                password,
                camera,
                nonce: report.nonces[0].nonce,
            });
            report.aesKey = decrypted.aesKeyHex;
            report.encryptionType = decrypted.encryptionType;
            report.decryptedFrames = decrypted.frames;
        } catch (err) {
            report.decryptionError = err.message;
        }
    } else if (!password) {
        report.note = 'Decryption skipped - no password provided';
    }

    return report;
}

/**
 * Format report for text output
 */
function formatReportText(report) {
    const lines = [];

    lines.push('='.repeat(80));
    lines.push(`BAICHUAN PCAP ANALYSIS REPORT`);
    lines.push(`File: ${report.file}`);
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Total Frames: ${report.totalFrames}`);
    lines.push('='.repeat(80));

    // Sessions
    lines.push('\n## SESSIONS\n');
    for (const session of report.sessions) {
        lines.push(`  ${session.client} <-> ${session.server}`);
        lines.push(`    Frames: ${session.frameCount}`);
        lines.push(`    Commands: ${session.cmdIds.map(id => getCmdName(id)).join(', ')}`);
    }

    // Nonces
    lines.push('\n## NONCES\n');
    if (report.nonces.length === 0) {
        lines.push('  No nonces found');
    } else {
        for (const n of report.nonces) {
            lines.push(`  Session: ${n.client} -> ${n.server}`);
            lines.push(`  Nonce: ${n.nonce}`);
            lines.push(`  Encryption: ${n.encryptionType}`);
            lines.push('');
        }
    }

    if (report.aesKey) {
        lines.push(`  Derived AES Key: ${report.aesKey}`);
    }

    // Catalog
    lines.push('\n## COMMAND CATALOG\n');
    lines.push(`${'cmdId'.padEnd(8)} ${'Name'.padEnd(25)} ${'Req'.padEnd(6)} ${'Rsp'.padEnd(6)} ${'OK'.padEnd(6)} ${'Err'.padEnd(6)}`);
    lines.push('-'.repeat(60));
    for (const entry of report.catalog) {
        lines.push(
            `${entry.cmdId.toString().padEnd(8)} ` +
            `${entry.cmdName.slice(0, 24).padEnd(25)} ` +
            `${entry.requestCount.toString().padEnd(6)} ` +
            `${entry.responseCount.toString().padEnd(6)} ` +
            `${entry.successCount.toString().padEnd(6)} ` +
            `${entry.errorCount.toString().padEnd(6)}`
        );
    }

    // Decrypted frames
    if (report.decryptedFrames) {
        lines.push('\n## DECRYPTED FRAMES\n');
        for (const frame of report.decryptedFrames) {
            const dir = frame.direction === 'request' ? '>>>' : '<<<';
            lines.push('-'.repeat(70));
            lines.push(`${dir} cmdId=${frame.cmdId} (${frame.cmdName}) msgNum=${frame.msgNum} rc=${frame.responseCode}`);

            if (frame.extensionXml) {
                lines.push('\n  Extension:');
                lines.push('  ' + frame.extensionXml.split('\n').join('\n  '));
            }

            if (frame.payloadXml) {
                lines.push('\n  Payload:');
                lines.push('  ' + frame.payloadXml.split('\n').join('\n  '));
            }

            if (frame.isBinary) {
                lines.push(`\n  Binary data: ${frame.binaryLen} bytes`);
            }
        }
    }

    if (report.note) {
        lines.push(`\nNote: ${report.note}`);
    }

    if (report.decryptionError) {
        lines.push(`\nDecryption Error: ${report.decryptionError}`);
    }

    return lines.join('\n');
}

// CLI
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help')) {
        console.log(`Usage: node bc-report.mjs <pcap-file> [options]

Options:
  --password PWD  Password for AES decryption
  --camera IP     Filter by camera IP
  --output FILE   Write report to file
  --json          Output as JSON
  --help          Show this help

Example:
  node bc-report.mjs capture.pcap --password MyPass123 --output report.txt`);
        process.exit(0);
    }

    const pcapFile = args.find(a => !a.startsWith('--'));
    const jsonOutput = args.includes('--json');

    const pwdIdx = args.indexOf('--password');
    const password = pwdIdx >= 0 ? args[pwdIdx + 1] : null;

    const cameraIdx = args.indexOf('--camera');
    const camera = cameraIdx >= 0 ? args[cameraIdx + 1] : null;

    const outputIdx = args.indexOf('--output');
    const outputFile = outputIdx >= 0 ? args[outputIdx + 1] : null;

    if (!pcapFile || !fs.existsSync(pcapFile)) {
        console.error(`Error: PCAP file not found: ${pcapFile}`);
        process.exit(1);
    }

    try {
        const report = await generateReport(pcapFile, { password, camera });

        let output;
        if (jsonOutput) {
            output = JSON.stringify(report, null, 2);
        } else {
            output = formatReportText(report);
        }

        if (outputFile) {
            fs.writeFileSync(outputFile, output);
            console.error(`Report written to: ${outputFile}`);
        } else {
            console.log(output);
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
        if (args.includes('--verbose')) {
            console.error(err.stack);
        }
        process.exit(1);
    }
}

if (process.argv[1].includes('bc-report')) {
    main();
}
