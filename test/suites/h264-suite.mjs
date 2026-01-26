#!/usr/bin/env node
/**
 * H264 Camera Test Suite
 * 
 * Comprehensive tests for H264 cameras (e.g., 192.168.50.226)
 * Tests: Login, Info, Replay, Thumbnail, Download
 * 
 * Usage:
 *   node test/suites/h264-suite.mjs [options]
 * 
 * Options:
 *   --host IP        Camera IP (default: 192.168.50.226)
 *   --user USER      Username (default: admin)
 *   --password PWD   Password (env: REOLINK_PASSWORD)
 *   --channel NUM    Channel number (default: 0)
 *   --verbose        Verbose output
 *   --only TEST      Run only specific test
 *   --skip TEST      Skip specific test
 *   --list           List available tests
 * 
 * Environment:
 *   REOLINK_PASSWORD  Camera password
 *   H264_HOST         Camera IP override
 */

import { BaichuanClient } from '../../dist/index.js';

// ============================================================================
// Configuration
// ============================================================================

const args = process.argv.slice(2);

function getArg(name, defaultValue) {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1) return defaultValue;
    return args[idx + 1] || defaultValue;
}

const config = {
    host: getArg('host', process.env.H264_HOST || '192.168.50.226'),
    port: parseInt(getArg('port', '9000'), 10),
    user: getArg('user', 'admin'),
    password: getArg('password', process.env.REOLINK_PASSWORD),
    channel: parseInt(getArg('channel', '0'), 10),
    verbose: args.includes('--verbose') || args.includes('-v'),
    only: getArg('only', null),
    skip: getArg('skip', '').split(',').filter(Boolean),
};

if (!config.password) {
    console.error('Error: Password required (--password or REOLINK_PASSWORD env)');
    process.exit(1);
}

// ============================================================================
// Test Framework
// ============================================================================

const results = {
    passed: [],
    failed: [],
    skipped: [],
};

function log(...args) {
    console.log(...args);
}

function verbose(...args) {
    if (config.verbose) {
        console.log('  [verbose]', ...args);
    }
}

async function runTest(name, fn) {
    if (config.only && config.only !== name) {
        results.skipped.push({ name, reason: 'not selected' });
        return;
    }
    if (config.skip.includes(name)) {
        results.skipped.push({ name, reason: 'skipped by user' });
        log(`⏭️  ${name} - SKIPPED`);
        return;
    }

    const startTime = Date.now();
    try {
        await fn();
        const duration = Date.now() - startTime;
        results.passed.push({ name, duration });
        log(`✅ ${name} - PASSED (${duration}ms)`);
    } catch (error) {
        const duration = Date.now() - startTime;
        results.failed.push({ name, error: error.message, duration });
        log(`❌ ${name} - FAILED (${duration}ms)`);
        log(`   Error: ${error.message}`);
        if (config.verbose) {
            console.error(error.stack);
        }
    }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message || 'Assertion failed');
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(
            message || `Expected ${expected}, got ${actual}`
        );
    }
}

function assertIncludes(arr, value, message) {
    if (!arr.includes(value)) {
        throw new Error(
            message || `Expected array to include ${value}`
        );
    }
}

// ============================================================================
// Test Definitions
// ============================================================================

const tests = [
    // ---------------------------------------------------------------------------
    // Basic Connectivity
    // ---------------------------------------------------------------------------
    {
        name: 'connect',
        description: 'Connect to camera and authenticate',
        fn: async (client) => {
            await client.connect();
            assert(client.isConnected(), 'Should be connected');
            verbose('Connected and authenticated');
        },
    },

    // ---------------------------------------------------------------------------
    // Device Info
    // ---------------------------------------------------------------------------
    {
        name: 'getDeviceInfo',
        description: 'Get device information',
        fn: async (client) => {
            const info = await client.getDeviceInfo();
            verbose('Device info:', JSON.stringify(info, null, 2));

            assert(info, 'Should return device info');
            assert(info.DevInfo || info.devInfo, 'Should have DevInfo');

            const devInfo = info.DevInfo || info.devInfo;
            verbose('Model:', devInfo.model || devInfo.Model);
            verbose('Firmware:', devInfo.firmVer || devInfo.FirmVer);
        },
    },

    // ---------------------------------------------------------------------------
    // Abilities
    // ---------------------------------------------------------------------------
    {
        name: 'getAbilities',
        description: 'Get camera abilities/capabilities',
        fn: async (client) => {
            const abilities = await client.getAbilities();
            verbose('Abilities:', JSON.stringify(abilities, null, 2).slice(0, 500));

            assert(abilities, 'Should return abilities');
        },
    },

    // ---------------------------------------------------------------------------
    // Recording Search
    // ---------------------------------------------------------------------------
    {
        name: 'searchRecordings',
        description: 'Search for recordings in last 7 days',
        fn: async (client) => {
            const now = new Date();
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

            const recordings = await client.searchRecordings({
                channel: config.channel,
                startTime: weekAgo,
                endTime: now,
            });

            verbose('Recordings found:', recordings?.length || 0);

            if (recordings && recordings.length > 0) {
                verbose('First recording:', JSON.stringify(recordings[0], null, 2));

                // Store for later tests
                client._testRecording = recordings[0];
            }
        },
    },

    // ---------------------------------------------------------------------------
    // Replay (H264-specific)
    // ---------------------------------------------------------------------------
    {
        name: 'replayRecording',
        description: 'Start replay of a recording',
        fn: async (client) => {
            // Get a recording to replay
            const now = new Date();
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

            const recordings = await client.searchRecordings({
                channel: config.channel,
                startTime: weekAgo,
                endTime: now,
            });

            if (!recordings || recordings.length === 0) {
                throw new Error('No recordings found for replay test');
            }

            const recording = recordings[0];
            verbose('Replaying:', recording.filename || recording.name);

            // Start replay - collect some frames
            let frameCount = 0;
            let totalBytes = 0;
            const timeout = 10000;

            const replayPromise = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    resolve({ frameCount, totalBytes });
                }, timeout);

                client.startReplay({
                    channel: config.channel,
                    filename: recording.filename || recording.name,
                    startTime: recording.startTime || recording.begin,
                    endTime: recording.endTime || recording.end,
                    onFrame: (frame) => {
                        frameCount++;
                        totalBytes += frame.length;
                        verbose(`Frame ${frameCount}: ${frame.length} bytes`);

                        // Stop after a few frames
                        if (frameCount >= 10) {
                            clearTimeout(timer);
                            resolve({ frameCount, totalBytes });
                        }
                    },
                    onError: (err) => {
                        clearTimeout(timer);
                        reject(err);
                    },
                }).catch(reject);
            });

            const result = await replayPromise;
            verbose('Replay result:', result);

            assert(result.frameCount > 0, 'Should receive at least one frame');
            verbose(`Received ${result.frameCount} frames, ${result.totalBytes} bytes`);
        },
    },

    // ---------------------------------------------------------------------------
    // Thumbnail
    // ---------------------------------------------------------------------------
    {
        name: 'getThumbnail',
        description: 'Get recording thumbnail',
        fn: async (client) => {
            const now = new Date();
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

            const recordings = await client.searchRecordings({
                channel: config.channel,
                startTime: weekAgo,
                endTime: now,
            });

            if (!recordings || recordings.length === 0) {
                throw new Error('No recordings found for thumbnail test');
            }

            const recording = recordings[0];
            verbose('Getting thumbnail for:', recording.filename || recording.name);

            const thumbnail = await client.getThumbnail({
                channel: config.channel,
                filename: recording.filename || recording.name,
                time: recording.startTime || recording.begin,
            });

            assert(thumbnail, 'Should return thumbnail data');
            assert(thumbnail.length > 1000, 'Thumbnail should be larger than 1KB');
            verbose(`Thumbnail size: ${thumbnail.length} bytes`);

            // Check JPEG magic
            if (thumbnail[0] === 0xFF && thumbnail[1] === 0xD8) {
                verbose('Valid JPEG thumbnail');
            }
        },
    },

    // ---------------------------------------------------------------------------
    // Live Preview
    // ---------------------------------------------------------------------------
    {
        name: 'livePreview',
        description: 'Start live preview stream',
        fn: async (client) => {
            let frameCount = 0;
            let totalBytes = 0;
            const timeout = 5000;

            const previewPromise = new Promise((resolve) => {
                const timer = setTimeout(() => {
                    resolve({ frameCount, totalBytes });
                }, timeout);

                client.startPreview({
                    channel: config.channel,
                    stream: 'main',
                    onFrame: (frame) => {
                        frameCount++;
                        totalBytes += frame.length;

                        if (frameCount >= 5) {
                            clearTimeout(timer);
                            resolve({ frameCount, totalBytes });
                        }
                    },
                });
            });

            const result = await previewPromise;
            verbose('Preview result:', result);

            assert(result.frameCount > 0, 'Should receive preview frames');
            verbose(`Received ${result.frameCount} frames, ${result.totalBytes} bytes`);
        },
    },

    // ---------------------------------------------------------------------------
    // Snapshot
    // ---------------------------------------------------------------------------
    {
        name: 'getSnapshot',
        description: 'Get live snapshot',
        fn: async (client) => {
            const snapshot = await client.getSnapshot({
                channel: config.channel,
            });

            assert(snapshot, 'Should return snapshot data');
            assert(snapshot.length > 5000, 'Snapshot should be larger than 5KB');
            verbose(`Snapshot size: ${snapshot.length} bytes`);

            // Check JPEG magic
            if (snapshot[0] === 0xFF && snapshot[1] === 0xD8) {
                verbose('Valid JPEG snapshot');
            }
        },
    },

    // ---------------------------------------------------------------------------
    // PTZ (if supported)
    // ---------------------------------------------------------------------------
    {
        name: 'ptzCapabilities',
        description: 'Check PTZ capabilities',
        fn: async (client) => {
            try {
                const abilities = await client.getAbilities();
                const ptz = abilities?.Ability?.abilityChn?.[config.channel]?.ptzCtrl;

                if (ptz) {
                    verbose('PTZ supported:', JSON.stringify(ptz, null, 2));
                } else {
                    verbose('PTZ not supported on this camera');
                }
            } catch (e) {
                verbose('PTZ check failed:', e.message);
            }
        },
    },

    // ---------------------------------------------------------------------------
    // Disconnect
    // ---------------------------------------------------------------------------
    {
        name: 'disconnect',
        description: 'Gracefully disconnect',
        fn: async (client) => {
            await client.disconnect();
            assert(!client.isConnected(), 'Should be disconnected');
            verbose('Disconnected');
        },
    },
];

// ============================================================================
// Main
// ============================================================================

async function main() {
    if (args.includes('--list')) {
        log('Available tests:');
        for (const t of tests) {
            log(`  ${t.name}: ${t.description}`);
        }
        process.exit(0);
    }

    log('═'.repeat(60));
    log('H264 Camera Test Suite');
    log('═'.repeat(60));
    log(`Host: ${config.host}:${config.port}`);
    log(`User: ${config.user}`);
    log(`Channel: ${config.channel}`);
    log('─'.repeat(60));

    const client = new BaichuanClient({
        host: config.host,
        port: config.port,
        username: config.user,
        password: config.password,
    });

    const startTime = Date.now();

    // Run tests
    for (const test of tests) {
        await runTest(test.name, () => test.fn(client));
    }

    // Ensure disconnected
    try {
        if (client.isConnected()) {
            await client.disconnect();
        }
    } catch (e) {
        // ignore
    }

    const totalTime = Date.now() - startTime;

    // Summary
    log('─'.repeat(60));
    log('SUMMARY');
    log('─'.repeat(60));
    log(`Total:   ${tests.length}`);
    log(`Passed:  ${results.passed.length}`);
    log(`Failed:  ${results.failed.length}`);
    log(`Skipped: ${results.skipped.length}`);
    log(`Time:    ${totalTime}ms`);
    log('═'.repeat(60));

    if (results.failed.length > 0) {
        log('\nFailed tests:');
        for (const f of results.failed) {
            log(`  - ${f.name}: ${f.error}`);
        }
        process.exit(1);
    }

    process.exit(0);
}

main().catch((err) => {
    console.error('Suite error:', err);
    process.exit(1);
});
