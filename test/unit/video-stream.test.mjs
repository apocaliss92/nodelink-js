#!/usr/bin/env node
/**
 * Video Stream Tests - Offline tests using captured fixtures
 *
 * Tests video access unit structure, keyframe detection, and codec identification
 */

import {
    describe,
    it,
    assert,
    assertEqual,
    assertGreater,
    assertArrayLength,
    assertDefined,
    printSummary,
} from "../utils/test-runner.mjs";
import {
    loadLiveFixture,
    loadPlaybackFixture,
    loadDeviceInfo,
    listAvailableFixtures,
    analyzeH264Frame,
    analyzeH265Frame,
    isValidH264Frame,
    isValidH265Frame,
    DEVICES,
} from "../utils/fixture-loader.mjs";

// ============================================================================
// TCP (TrackMix PoE) - H.264 full_aes Tests
// ============================================================================

describe("TCP Live Stream (H.264 full_aes)", () => {
    const fixture = loadLiveFixture("tcp", 0);

    it("should have captured frames", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.frames.length, 0, "No frames captured");
    });

    it("should detect correct video type", async () => {
        assertDefined(fixture, "Fixture not found");
        assertEqual(fixture.metadata.videoType, "H264");
    });

    it("should have keyframes", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.metadata.keyframes, 0, "No keyframes detected");
    });

    it("should have valid encryption info", async () => {
        assertDefined(fixture, "Fixture not found");
        assertDefined(fixture.encryption, "Encryption info missing");
        assertEqual(fixture.encryption.kind, "full_aes");
    });

    it("should have valid H.264 structure in keyframes", async () => {
        assertDefined(fixture, "Fixture not found");
        const keyframes = fixture.frames.filter((f) => f.isKeyframe);
        assertGreater(keyframes.length, 0, "No keyframes found");

        for (const kf of keyframes.slice(0, 3)) {
            const valid = isValidH264Frame(kf.data, true);
            assert(valid, `Keyframe at ${kf.timestamp}ms has invalid H.264 structure`);
        }
    });

    it("should have SPS/PPS in keyframes", async () => {
        assertDefined(fixture, "Fixture not found");
        const keyframe = fixture.frames.find((f) => f.isKeyframe);
        assertDefined(keyframe, "No keyframe found");

        const nals = analyzeH264Frame(keyframe.data);
        const hasSps = nals.some((n) => n.type === 7);
        const hasPps = nals.some((n) => n.type === 8);
        assert(hasSps, "Keyframe missing SPS");
        assert(hasPps, "Keyframe missing PPS");
    });
});

describe("TCP Playback Stream (H.264 full_aes)", () => {
    const fixture = loadPlaybackFixture("tcp", 0);

    it("should have captured frames", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.frames.length, 0, "No frames captured");
    });

    it("should detect correct video type", async () => {
        assertDefined(fixture, "Fixture not found");
        assertEqual(fixture.metadata.videoType, "H264");
    });

    it("should have keyframes", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.metadata.keyframes, 0, "No keyframes detected");
    });

    it("should have reasonable frame timing", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.metadata.durationMs, 1000, "Duration too short");
    });

    it("should have valid H.264 structure in keyframes", async () => {
        assertDefined(fixture, "Fixture not found");
        // Check keyframes only (non-keyframes may start mid-stream)
        const keyframes = fixture.frames.filter((f) => f.isKeyframe);
        assertGreater(keyframes.length, 0, "No keyframes found");
        for (const kf of keyframes.slice(0, 3)) {
            const valid = isValidH264Frame(kf.data, true);
            assert(
                valid,
                `Keyframe at ${kf.timestamp}ms has invalid H.264 structure`
            );
        }
    });
});

// ============================================================================
// NVR Channel 0 - H.265 Tests
// ============================================================================

describe("NVR Channel 0 Live Stream (H.265)", () => {
    const fixture = loadLiveFixture("nvr", 0);

    it("should have captured frames", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.frames.length, 0, "No frames captured");
    });

    it("should detect correct video type", async () => {
        assertDefined(fixture, "Fixture not found");
        assertEqual(fixture.metadata.videoType, "H265");
    });

    it("should have keyframes", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.metadata.keyframes, 0, "No keyframes detected");
    });

    it("should have valid H.265 structure in keyframes", async () => {
        assertDefined(fixture, "Fixture not found");
        const keyframes = fixture.frames.filter((f) => f.isKeyframe);
        assertGreater(keyframes.length, 0, "No keyframes found");

        for (const kf of keyframes.slice(0, 2)) {
            const valid = isValidH265Frame(kf.data, true);
            assert(valid, `Keyframe at ${kf.timestamp}ms has invalid H.265 structure`);
        }
    });

    it("should have VPS/SPS/PPS in keyframes", async () => {
        assertDefined(fixture, "Fixture not found");
        const keyframe = fixture.frames.find((f) => f.isKeyframe);
        assertDefined(keyframe, "No keyframe found");

        const nals = analyzeH265Frame(keyframe.data);
        const hasVps = nals.some((n) => n.type === 32);
        const hasSps = nals.some((n) => n.type === 33);
        const hasPps = nals.some((n) => n.type === 34);
        assert(hasVps, "Keyframe missing VPS");
        assert(hasSps, "Keyframe missing SPS");
        assert(hasPps, "Keyframe missing PPS");
    });
});

describe("NVR Channel 0 Playback Stream", () => {
    const fixture = loadPlaybackFixture("nvr", 0);

    it("should have captured frames", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.frames.length, 0, "No frames captured");
    });

    it("should have reasonable frame count", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.metadata.frameCount, 50, "Too few frames");
    });
});

// ============================================================================
// NVR Channel 1 Tests
// ============================================================================

describe("NVR Channel 1 Live Stream", () => {
    const fixture = loadLiveFixture("nvr", 1);

    it("should have captured frames", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.frames.length, 0, "No frames captured");
    });

    it("should have keyframes", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.metadata.keyframes, 0, "No keyframes detected");
    });
});

describe("NVR Channel 1 Playback Stream", () => {
    const fixture = loadPlaybackFixture("nvr", 1);

    it("should have captured frames", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.frames.length, 0, "No frames captured");
    });
});

// ============================================================================
// NVR Channel 2 Tests
// ============================================================================

describe("NVR Channel 2 Live Stream", () => {
    const fixture = loadLiveFixture("nvr", 2);

    it("should have captured frames", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.frames.length, 0, "No frames captured");
    });

    it("should have keyframes", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.metadata.keyframes, 0, "No keyframes detected");
    });
});

describe("NVR Channel 2 Playback Stream", () => {
    const fixture = loadPlaybackFixture("nvr", 2);

    it("should have captured frames", async () => {
        assertDefined(fixture, "Fixture not found");
        assertGreater(fixture.frames.length, 0, "No frames captured");
    });
});

// ============================================================================
// Fixture Integrity Tests
// ============================================================================

describe("Fixture Integrity", () => {
    it("should list all available fixtures", async () => {
        const fixtures = listAvailableFixtures();
        assertGreater(fixtures.length, 0, "No fixtures found");
        console.log(`     Found ${fixtures.length} fixtures`);
    });

    it("should have device info for TCP", async () => {
        const info = loadDeviceInfo("tcp");
        assertDefined(info, "TCP device info not found");
        assertDefined(info.deviceInfo, "Device info missing");
        assertDefined(info.deviceInfo.firmwareVersion, "Firmware version missing");
    });

    it("should have device info for NVR", async () => {
        const info = loadDeviceInfo("nvr");
        assertDefined(info, "NVR device info not found");
        assertDefined(info.deviceInfo, "Device info missing");
    });
});

// ============================================================================
// Run Tests
// ============================================================================

console.log("═".repeat(60));
console.log("Video Stream Offline Tests");
console.log("═".repeat(60));

const success = await printSummary();
process.exit(success ? 0 : 1);
