#!/usr/bin/env node
/**
 * Run All Camera Test Suites
 * 
 * Usage:
 *   node test/suites/run-all.mjs [options]
 * 
 * Options:
 *   --h264-only     Run only H264 suite
 *   --h265-only     Run only H265 suite
 *   --h264-host IP  H264 camera IP (default: 192.168.50.226)
 *   --h265-host IP  H265 camera IP (default: 192.168.1.170)
 *   --verbose       Verbose output
 *   --password PWD  Password (env: REOLINK_PASSWORD)
 * 
 * Environment:
 *   REOLINK_PASSWORD  Camera password
 *   H264_HOST         H264 camera IP
 *   H265_HOST         H265 camera IP
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function getArg(name, defaultValue) {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1) return defaultValue;
    return args[idx + 1] || defaultValue;
}

const config = {
    h264Only: args.includes('--h264-only'),
    h265Only: args.includes('--h265-only'),
    h264Host: getArg('h264-host', process.env.H264_HOST || '192.168.50.226'),
    h265Host: getArg('h265-host', process.env.H265_HOST || '192.168.1.170'),
    password: getArg('password', process.env.REOLINK_PASSWORD),
    verbose: args.includes('--verbose') || args.includes('-v'),
};

if (!config.password) {
    console.error('Error: Password required (--password or REOLINK_PASSWORD env)');
    process.exit(1);
}

function runSuite(name, scriptPath, host) {
    return new Promise((resolve) => {
        console.log('\n' + '═'.repeat(60));
        console.log(`Running: ${name}`);
        console.log('═'.repeat(60) + '\n');

        const suiteArgs = [
            scriptPath,
            '--host', host,
            '--password', config.password,
        ];

        if (config.verbose) {
            suiteArgs.push('--verbose');
        }

        const proc = spawn('node', suiteArgs, {
            stdio: 'inherit',
            cwd: process.cwd(),
        });

        proc.on('close', (code) => {
            resolve({ name, code });
        });

        proc.on('error', (err) => {
            console.error(`Failed to start ${name}:`, err.message);
            resolve({ name, code: 1, error: err.message });
        });
    });
}

async function main() {
    console.log('═'.repeat(60));
    console.log('Camera Test Suite Runner');
    console.log('═'.repeat(60));
    console.log(`H264 Host: ${config.h264Host}`);
    console.log(`H265 Host: ${config.h265Host}`);
    console.log(`Verbose: ${config.verbose}`);

    const results = [];

    if (!config.h265Only) {
        const h264Result = await runSuite(
            'H264 Suite',
            join(__dirname, 'h264-suite.mjs'),
            config.h264Host
        );
        results.push(h264Result);
    }

    if (!config.h264Only) {
        const h265Result = await runSuite(
            'H265 Suite',
            join(__dirname, 'h265-suite.mjs'),
            config.h265Host
        );
        results.push(h265Result);
    }

    // Final summary
    console.log('\n' + '═'.repeat(60));
    console.log('OVERALL RESULTS');
    console.log('═'.repeat(60));

    let allPassed = true;
    for (const r of results) {
        const status = r.code === 0 ? '✅ PASSED' : '❌ FAILED';
        console.log(`${r.name}: ${status}`);
        if (r.code !== 0) allPassed = false;
    }

    console.log('═'.repeat(60));

    process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
    console.error('Runner error:', err);
    process.exit(1);
});
