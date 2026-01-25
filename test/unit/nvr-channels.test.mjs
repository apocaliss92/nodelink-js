#!/usr/bin/env node
/**
 * Multi-Channel NVR Tests - Offline tests for NVR with multiple channels
 *
 * Validates that all NVR channels work correctly and consistently
 */

import {
    describe,
    it,
    assert,
    assertEqual,
    assertGreater,
    assertDefined,
    printSummary,
} from "../utils/test-runner.mjs";
import {
    loadLiveFixture,
    loadPlaybackFixture,
    loadDeviceInfo,
    analyzeH265Frame,
    isValidH265Frame,
} from "../utils/fixture-loader.mjs";

const NVR_CHANNELS = [0, 1, 2];

// ============================================================================
// Channel Availability Tests
// ============================================================================

describe("NVR Channel Availability", () => {
    it("should have device info", async () => {
        const info = loadDeviceInfo("nvr");
        assertDefined(info, "NVR device info not found");
    });

    for (const ch of NVR_CHANNELS) {
        it(`should have live fixture for channel ${ch}`, async () => {
            const fixture = loadLiveFixture("nvr", ch);
            assertDefined(fixture, `Channel ${ch} live fixture not found`);
        });

        it(`should have playback fixture for channel ${ch}`, async () => {
            const fixture = loadPlaybackFixture("nvr", ch);
            assertDefined(fixture, `Channel ${ch} playback fixture not found`);
        });
    }
});

// ============================================================================
// Cross-Channel Consistency Tests
// ============================================================================

describe("NVR Cross-Channel Consistency", () => {
    it("should have same encryption type across channels", async () => {
        const fixtures = NVR_CHANNELS.map((ch) => loadLiveFixture("nvr", ch)).filter(
            Boolean
        );

        if (fixtures.length > 1) {
            const firstKind = fixtures[0].encryption?.kind;
            for (let i = 1; i < fixtures.length; i++) {
                assertEqual(
                    fixtures[i].encryption?.kind,
                    firstKind,
                    `Channel ${i} has different encryption type`
                );
            }
        }
    });

    it("should have H.265 on all channels", async () => {
        for (const ch of NVR_CHANNELS) {
            const fixture = loadLiveFixture("nvr", ch);
            if (fixture) {
                assertEqual(
                    fixture.metadata.videoType,
                    "H265",
                    `Channel ${ch} should be H.265`
                );
            }
        }
    });

    it("should have keyframes on all channels", async () => {
        for (const ch of NVR_CHANNELS) {
            const fixture = loadLiveFixture("nvr", ch);
            if (fixture) {
                assertGreater(
                    fixture.metadata.keyframes,
                    0,
                    `Channel ${ch} has no keyframes`
                );
            }
        }
    });
});

// ============================================================================
// Per-Channel Detailed Tests
// ============================================================================

for (const ch of NVR_CHANNELS) {
    describe(`NVR Channel ${ch} Live Stream`, () => {
        const fixture = loadLiveFixture("nvr", ch);

        it("should have frames captured", async () => {
            assertDefined(fixture, "Fixture not found");
            assertGreater(fixture.frames.length, 0, "No frames captured");
        });

        it("should have valid H.265 keyframes", async () => {
            assertDefined(fixture, "Fixture not found");

            const keyframes = fixture.frames.filter((f) => f.isKeyframe);
            for (const kf of keyframes.slice(0, 2)) {
                const valid = isValidH265Frame(kf.data, true);
                assert(valid, `Invalid H.265 keyframe at ${kf.timestamp}ms`);
            }
        });

        it("should have VPS/SPS/PPS in keyframes", async () => {
            assertDefined(fixture, "Fixture not found");

            const keyframe = fixture.frames.find((f) => f.isKeyframe);
            if (keyframe) {
                const nals = analyzeH265Frame(keyframe.data);
                const types = nals.map((n) => n.type);
                assert(types.includes(32), `Channel ${ch}: Missing VPS`);
                assert(types.includes(33), `Channel ${ch}: Missing SPS`);
                assert(types.includes(34), `Channel ${ch}: Missing PPS`);
            }
        });
    });

    describe(`NVR Channel ${ch} Playback Stream`, () => {
        const fixture = loadPlaybackFixture("nvr", ch);

        it("should have frames captured", async () => {
            assertDefined(fixture, "Fixture not found");
            assertGreater(fixture.frames.length, 0, "No frames captured");
        });

        it("should have reasonable duration", async () => {
            assertDefined(fixture, "Fixture not found");
            assertGreater(fixture.metadata.durationMs, 1000, "Duration too short");
        });

        it("should have consistent frame data", async () => {
            assertDefined(fixture, "Fixture not found");
            // Verify frames have valid metadata
            for (const frame of fixture.frames.slice(0, 10)) {
                assertDefined(frame.timestamp, "Frame missing timestamp");
                assertDefined(frame.size, "Frame missing size");
                assertGreater(frame.size, 0, "Frame size is zero");
            }
        });
    });
}

// ============================================================================
// Channel Statistics Comparison
// ============================================================================

describe("NVR Channel Statistics", () => {
    it("should log frame counts for all channels", async () => {
        console.log("\n     Channel Statistics:");
        for (const ch of NVR_CHANNELS) {
            const live = loadLiveFixture("nvr", ch);
            const playback = loadPlaybackFixture("nvr", ch);
            if (live && playback) {
                console.log(
                    `     Ch${ch}: Live ${live.metadata.frameCount} frames (${live.metadata.keyframes} KF), ` +
                    `Playback ${playback.metadata.frameCount} frames (${playback.metadata.keyframes} KF)`
                );
            }
        }
        assert(true);
    });

    it("should have similar keyframe ratio across channels", async () => {
        const ratios = [];
        for (const ch of NVR_CHANNELS) {
            const fixture = loadLiveFixture("nvr", ch);
            if (fixture && fixture.metadata.frameCount > 0) {
                const ratio =
                    fixture.metadata.keyframes / fixture.metadata.frameCount;
                ratios.push(ratio);
            }
        }

        if (ratios.length > 1) {
            const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
            for (const ratio of ratios) {
                // Allow 50% deviation from average
                const deviation = Math.abs(ratio - avgRatio) / avgRatio;
                assert(
                    deviation < 0.5,
                    `Keyframe ratio varies too much: ${ratios.join(", ")}`
                );
            }
        }
    });
});

// ============================================================================
// Run Tests
// ============================================================================

console.log("═".repeat(60));
console.log("NVR Multi-Channel Offline Tests");
console.log("═".repeat(60));

const success = await printSummary();
process.exit(success ? 0 : 1);
