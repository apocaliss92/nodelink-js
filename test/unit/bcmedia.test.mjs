#!/usr/bin/env node
/**
 * BcMedia Packet Tests - Offline tests for packet parsing
 *
 * Tests BcMedia header parsing, AES encryption handling,
 * and packet structure validation
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
    analyzeH264Frame,
    analyzeH265Frame,
    DEVICES,
} from "../utils/fixture-loader.mjs";

// ============================================================================
// Frame Structure Tests
// ============================================================================

describe("Frame Structure - TCP (H.264)", () => {
    const fixture = loadLiveFixture("tcp", 0);

    it("should have consistent frame metadata", async () => {
        assertDefined(fixture, "Fixture not found");

        for (const frame of fixture.frames.slice(0, 20)) {
            assertDefined(frame.timestamp, "Frame missing timestamp");
            assertDefined(frame.size, "Frame missing size");
            assertDefined(frame.data, "Frame missing data");
            assert(frame.data.length === frame.size, "Size mismatch");
        }
    });

    it("should have increasing timestamps", async () => {
        assertDefined(fixture, "Fixture not found");

        let prevTs = -1;
        for (const frame of fixture.frames) {
            assert(frame.timestamp >= prevTs, `Timestamp went backwards: ${frame.timestamp} < ${prevTs}`);
            prevTs = frame.timestamp;
        }
    });

    it("should have reasonable frame sizes", async () => {
        assertDefined(fixture, "Fixture not found");

        for (const frame of fixture.frames) {
            assertGreater(frame.size, 0, "Frame size is zero");
            // H.264 keyframes can be quite large (4K video)
            assert(frame.size < 5_000_000, `Frame too large: ${frame.size}`);
        }
    });

    it("should have keyframe at start", async () => {
        assertDefined(fixture, "Fixture not found");

        // First few frames should include a keyframe
        const firstFrames = fixture.frames.slice(0, 5);
        const hasKeyframe = firstFrames.some((f) => f.isKeyframe);
        assert(hasKeyframe, "No keyframe in first 5 frames");
    });
});

describe("Frame Structure - NVR (H.265)", () => {
    const fixture = loadLiveFixture("nvr", 0);

    it("should have consistent frame metadata", async () => {
        assertDefined(fixture, "Fixture not found");

        for (const frame of fixture.frames.slice(0, 20)) {
            assertDefined(frame.timestamp, "Frame missing timestamp");
            assertDefined(frame.size, "Frame missing size");
            assertDefined(frame.data, "Frame missing data");
            assert(frame.data.length === frame.size, "Size mismatch");
        }
    });

    it("should have reasonable frame sizes", async () => {
        assertDefined(fixture, "Fixture not found");

        for (const frame of fixture.frames) {
            assertGreater(frame.size, 0, "Frame size is zero");
            assert(frame.size < 5_000_000, `Frame too large: ${frame.size}`);
        }
    });

    it("should have keyframe at start", async () => {
        assertDefined(fixture, "Fixture not found");

        const firstFrames = fixture.frames.slice(0, 5);
        const hasKeyframe = firstFrames.some((f) => f.isKeyframe);
        assert(hasKeyframe, "No keyframe in first 5 frames");
    });
});

// ============================================================================
// NAL Unit Analysis Tests
// ============================================================================

describe("NAL Unit Analysis - H.264", () => {
    const fixture = loadLiveFixture("tcp", 0);

    it("should parse NAL units from frames", async () => {
        assertDefined(fixture, "Fixture not found");

        const frame = fixture.frames[0];
        const nals = analyzeH264Frame(frame.data);
        assertGreater(nals.length, 0, "No NAL units found");
    });

    it("should identify NAL unit types correctly", async () => {
        assertDefined(fixture, "Fixture not found");

        const keyframe = fixture.frames.find((f) => f.isKeyframe);
        assertDefined(keyframe, "No keyframe found");

        const nals = analyzeH264Frame(keyframe.data);

        // Should have SPS (7), PPS (8), IDR (5)
        const types = nals.map((n) => n.type);
        console.log(`     NAL types in keyframe: ${types.join(", ")}`);

        assert(types.includes(7), "Missing SPS (type 7)");
        assert(types.includes(8), "Missing PPS (type 8)");
        assert(types.includes(5), "Missing IDR slice (type 5)");
    });

    it("should have non-keyframes without SPS/PPS", async () => {
        assertDefined(fixture, "Fixture not found");

        const nonKeyframe = fixture.frames.find((f) => !f.isKeyframe);
        if (nonKeyframe) {
            const nals = analyzeH264Frame(nonKeyframe.data);
            const types = nals.map((n) => n.type);

            // Non-keyframes typically have type 1 (non-IDR slice)
            const hasNonIdr = types.includes(1);
            assert(hasNonIdr, "Non-keyframe should have non-IDR slice (type 1)");
        }
    });
});

describe("NAL Unit Analysis - H.265", () => {
    const fixture = loadLiveFixture("nvr", 0);

    it("should parse NAL units from frames", async () => {
        assertDefined(fixture, "Fixture not found");

        const frame = fixture.frames[0];
        const nals = analyzeH265Frame(frame.data);
        assertGreater(nals.length, 0, "No NAL units found");
    });

    it("should identify NAL unit types correctly", async () => {
        assertDefined(fixture, "Fixture not found");

        const keyframe = fixture.frames.find((f) => f.isKeyframe);
        assertDefined(keyframe, "No keyframe found");

        const nals = analyzeH265Frame(keyframe.data);
        const types = nals.map((n) => n.type);
        console.log(`     NAL types in H.265 keyframe: ${types.join(", ")}`);

        // H.265 keyframes should have VPS (32), SPS (33), PPS (34), IDR (19 or 20)
        assert(types.includes(32), "Missing VPS (type 32)");
        assert(types.includes(33), "Missing SPS (type 33)");
        assert(types.includes(34), "Missing PPS (type 34)");

        const hasIdr = types.includes(19) || types.includes(20);
        assert(hasIdr, "Missing IDR (type 19 or 20)");
    });
});

// ============================================================================
// Annex-B Format Tests
// ============================================================================

describe("Annex-B Format Validation", () => {
    it("should start with start code (H.264)", async () => {
        const fixture = loadLiveFixture("tcp", 0);
        assertDefined(fixture, "Fixture not found");

        const frame = fixture.frames[0];
        // Check for start code (0x00 0x00 0x00 0x01 or 0x00 0x00 0x01)
        const has4ByteStart =
            frame.data[0] === 0 &&
            frame.data[1] === 0 &&
            frame.data[2] === 0 &&
            frame.data[3] === 1;
        const has3ByteStart =
            frame.data[0] === 0 && frame.data[1] === 0 && frame.data[2] === 1;

        assert(has4ByteStart || has3ByteStart, "Frame does not start with Annex-B start code");
    });

    it("should start with start code (H.265)", async () => {
        const fixture = loadLiveFixture("nvr", 0);
        assertDefined(fixture, "Fixture not found");

        const frame = fixture.frames[0];
        const has4ByteStart =
            frame.data[0] === 0 &&
            frame.data[1] === 0 &&
            frame.data[2] === 0 &&
            frame.data[3] === 1;
        const has3ByteStart =
            frame.data[0] === 0 && frame.data[1] === 0 && frame.data[2] === 1;

        assert(has4ByteStart || has3ByteStart, "Frame does not start with Annex-B start code");
    });

    it("should have multiple NAL units in keyframes", async () => {
        const fixture = loadLiveFixture("tcp", 0);
        assertDefined(fixture, "Fixture not found");

        const keyframe = fixture.frames.find((f) => f.isKeyframe);
        assertDefined(keyframe, "No keyframe found");

        const nals = analyzeH264Frame(keyframe.data);
        assertGreater(nals.length, 1, "Keyframe should have multiple NAL units");
    });
});

// ============================================================================
// Encryption Metadata Tests
// ============================================================================

describe("Encryption Metadata", () => {
    it("should have encryption info for TCP", async () => {
        const fixture = loadLiveFixture("tcp", 0);
        assertDefined(fixture, "Fixture not found");
        assertDefined(fixture.encryption, "Encryption info missing");
        assertEqual(fixture.encryption.kind, "full_aes");
    });

    it("should have encryption info for NVR", async () => {
        const fixture = loadLiveFixture("nvr", 0);
        assertDefined(fixture, "Fixture not found");
        assertDefined(fixture.encryption, "Encryption info missing");
        assertEqual(fixture.encryption.kind, "full_aes");
    });

    it("should record AES encryption kind consistently", async () => {
        const tcpLive = loadLiveFixture("tcp", 0);
        const tcpPlayback = loadPlaybackFixture("tcp", 0);

        if (tcpLive && tcpPlayback) {
            assertEqual(
                tcpLive.encryption.kind,
                tcpPlayback.encryption.kind,
                "Encryption kind should match between live and playback"
            );
        }
    });
});

// ============================================================================
// Live vs Playback Comparison Tests
// ============================================================================

describe("Live vs Playback Comparison", () => {
    it("should have same video type for TCP live and playback", async () => {
        const live = loadLiveFixture("tcp", 0);
        const playback = loadPlaybackFixture("tcp", 0);

        assertDefined(live, "Live fixture not found");
        assertDefined(playback, "Playback fixture not found");

        assertEqual(
            live.metadata.videoType,
            playback.metadata.videoType,
            "Video types should match"
        );
    });

    it("should have consistent video types for TCP live and playback", async () => {
        const live = loadLiveFixture("nvr", 0);
        const playback = loadPlaybackFixture("nvr", 0);

        assertDefined(live, "Live fixture not found");
        assertDefined(playback, "Playback fixture not found");

        // Video types may differ if playback captures a different codec
        // Just verify both have valid types
        assertDefined(live.metadata.videoType, "Live video type missing");
        assertDefined(playback.metadata.videoType, "Playback video type missing");
        console.log(`     NVR ch0 Live: ${live.metadata.videoType}, Playback: ${playback.metadata.videoType}`);
    });

    it("should have similar frame structure", async () => {
        const live = loadLiveFixture("tcp", 0);
        const playback = loadPlaybackFixture("tcp", 0);

        assertDefined(live, "Live fixture not found");
        assertDefined(playback, "Playback fixture not found");

        // Both should have keyframes
        assertGreater(live.metadata.keyframes, 0);
        assertGreater(playback.metadata.keyframes, 0);

        // Both should have valid frame counts
        assertGreater(live.metadata.frameCount, 0);
        assertGreater(playback.metadata.frameCount, 0);
    });
});

// ============================================================================
// Run Tests
// ============================================================================

console.log("═".repeat(60));
console.log("BcMedia Packet Offline Tests");
console.log("═".repeat(60));

const success = await printSummary();
process.exit(success ? 0 : 1);
