/**
 * Fixture Loader - Utilities for loading test fixtures
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "raw");

/**
 * Available devices in fixtures
 */
export const DEVICES = {
    tcp: {
        id: "tcp",
        name: "TrackMix PoE",
        host: "192.168.50.226",
        encryption: "full_aes",
        codec: "H264",
        channels: [0],
    },
    tcp265: {
        id: "tcp265",
        name: "E1 Outdoor PoE",
        host: "192.168.1.170",
        encryption: "full_aes",
        codec: "H265",
        channels: [0],
    },
    nvr: {
        id: "nvr",
        name: "NVR RLN8-410",
        host: "192.168.1.161",
        encryption: "full_aes",
        codec: "mixed",
        channels: [0, 1, 2],
    },
};

/**
 * Load device metadata
 */
export function loadDeviceInfo(deviceId) {
    const filePath = path.join(FIXTURES_DIR, deviceId, "device.json");
    if (!fs.existsSync(filePath)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/**
 * Load live stream fixture for a device/channel
 */
export function loadLiveFixture(deviceId, channel = 0) {
    const filePath = path.join(FIXTURES_DIR, deviceId, `ch${channel}_live.json`);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
        metadata: data.metadata,
        encryption: data.encryption,
        frames: data.frames.map((f) => ({
            ...f,
            data: Buffer.from(f.data, "base64"),
        })),
    };
}

/**
 * Load playback fixture for a device/channel
 */
export function loadPlaybackFixture(deviceId, channel = 0) {
    const filePath = path.join(
        FIXTURES_DIR,
        deviceId,
        `ch${channel}_playback.json`
    );
    if (!fs.existsSync(filePath)) {
        return null;
    }
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
        metadata: data.metadata,
        encryption: data.encryption,
        frames: data.frames.map((f) => ({
            ...f,
            data: Buffer.from(f.data, "base64"),
        })),
    };
}

/**
 * Get all available fixtures
 */
export function listAvailableFixtures() {
    const fixtures = [];

    for (const [deviceId, config] of Object.entries(DEVICES)) {
        const deviceDir = path.join(FIXTURES_DIR, deviceId);
        if (!fs.existsSync(deviceDir)) continue;

        const files = fs.readdirSync(deviceDir);
        for (const file of files) {
            if (file.endsWith("_live.json")) {
                const channel = parseInt(file.match(/ch(\d+)/)?.[1] || "0", 10);
                fixtures.push({ deviceId, type: "live", channel, file });
            } else if (file.endsWith("_playback.json")) {
                const channel = parseInt(file.match(/ch(\d+)/)?.[1] || "0", 10);
                fixtures.push({ deviceId, type: "playback", channel, file });
            }
        }
    }

    return fixtures;
}

/**
 * Load capture summary
 */
export function loadCaptureSummary() {
    const filePath = path.join(FIXTURES_DIR, "capture-summary.json");
    if (!fs.existsSync(filePath)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/**
 * Helper to analyze H.264 NAL units in a frame
 */
export function analyzeH264Frame(frameData) {
    const nalTypes = [];
    let i = 0;

    while (i < frameData.length - 4) {
        // Look for start code (00 00 00 01 or 00 00 01)
        if (frameData[i] === 0 && frameData[i + 1] === 0) {
            let nalStart = -1;
            if (frameData[i + 2] === 0 && frameData[i + 3] === 1) {
                nalStart = i + 4;
            } else if (frameData[i + 2] === 1) {
                nalStart = i + 3;
            }

            if (nalStart >= 0 && nalStart < frameData.length) {
                const nalByte = frameData[nalStart];
                if (nalByte !== undefined) {
                    const nalType = nalByte & 0x1f;
                    nalTypes.push({
                        type: nalType,
                        name: getH264NalTypeName(nalType),
                        offset: nalStart,
                    });
                    i = nalStart;
                    continue;
                }
            }
        }
        i++;
    }

    return nalTypes;
}

/**
 * Helper to analyze H.265 NAL units in a frame
 */
export function analyzeH265Frame(frameData) {
    const nalTypes = [];
    let i = 0;

    while (i < frameData.length - 4) {
        if (frameData[i] === 0 && frameData[i + 1] === 0) {
            let nalStart = -1;
            if (frameData[i + 2] === 0 && frameData[i + 3] === 1) {
                nalStart = i + 4;
            } else if (frameData[i + 2] === 1) {
                nalStart = i + 3;
            }

            if (nalStart >= 0 && nalStart < frameData.length) {
                const nalByte = frameData[nalStart];
                if (nalByte !== undefined) {
                    const nalType = (nalByte >> 1) & 0x3f;
                    nalTypes.push({
                        type: nalType,
                        name: getH265NalTypeName(nalType),
                        offset: nalStart,
                    });
                    i = nalStart;
                    continue;
                }
            }
        }
        i++;
    }

    return nalTypes;
}

function getH264NalTypeName(type) {
    const names = {
        1: "Non-IDR Slice",
        5: "IDR Slice",
        6: "SEI",
        7: "SPS",
        8: "PPS",
        9: "AUD",
    };
    return names[type] || `Unknown(${type})`;
}

function getH265NalTypeName(type) {
    const names = {
        0: "TRAIL_N",
        1: "TRAIL_R",
        19: "IDR_W_RADL",
        20: "IDR_N_LP",
        32: "VPS",
        33: "SPS",
        34: "PPS",
        35: "AUD",
        39: "SEI_PREFIX",
        40: "SEI_SUFFIX",
    };
    return names[type] || `Unknown(${type})`;
}

/**
 * Verify a frame has valid H.264 structure
 */
export function isValidH264Frame(frameData, isKeyframe) {
    const nals = analyzeH264Frame(frameData);

    if (nals.length === 0) return false;

    // Keyframes should have SPS (7), PPS (8), and IDR slice (5)
    if (isKeyframe) {
        const hasSps = nals.some((n) => n.type === 7);
        const hasPps = nals.some((n) => n.type === 8);
        const hasIdr = nals.some((n) => n.type === 5);
        return hasSps && hasPps && hasIdr;
    }

    // P-frames should have non-IDR slice (1)
    return nals.some((n) => n.type === 1 || n.type === 5);
}

/**
 * Verify a frame has valid H.265 structure
 */
export function isValidH265Frame(frameData, isKeyframe) {
    const nals = analyzeH265Frame(frameData);

    if (nals.length === 0) return false;

    // Keyframes should have VPS (32), SPS (33), PPS (34), and IDR slice (19 or 20)
    if (isKeyframe) {
        const hasVps = nals.some((n) => n.type === 32);
        const hasSps = nals.some((n) => n.type === 33);
        const hasPps = nals.some((n) => n.type === 34);
        const hasIdr = nals.some((n) => n.type === 19 || n.type === 20);
        return hasVps && hasSps && hasPps && hasIdr;
    }

    // P-frames should have trail slice
    return nals.some((n) => n.type <= 9);
}
