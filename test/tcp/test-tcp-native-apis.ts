#!/usr/bin/env node
/**
 * Test suite for the newer native Baichuan APIs.
 * Tests: events, stream metadata, OSD, AI, motion, 2-way audio.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, type ReolinkEvent } from "../../index.js";
import { config } from "../env.js";

// Helper functions
function log(message: string, data?: unknown) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[INFO] ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
  console.log("=".repeat(60));
}

function logSuccess(message: string) {
  console.log(`\n[OK] ${message}`);
}

function logError(message: string, error: unknown) {
  console.error(`\n[ERROR] ${message}`);
  if (error instanceof Error) {
    console.error(`   Message: ${error.message}`);
    if (error.stack) {
      console.error(`   Stack: ${error.stack.split("\n").slice(0, 3).join("\n")}`);
    }
  } else {
    console.error(`   Details: ${error}`);
  }
}

async function testStreamMetadata(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing getStreamMetadata (channel ${channel})`);
    const metadata = await api.getStreamMetadata(channel);
    logSuccess(`Stream metadata fetched (channel ${channel})`);
    log("Stream Metadata", metadata);

    // Validate shape
    if (!metadata.streams || metadata.streams.length === 0) {
      logError("No streams found", new Error("metadata.streams is empty"));
      return false;
    }

    // Validate each stream
    for (const stream of metadata.streams) {
      if (!stream.profile || !["main", "sub", "ext"].includes(stream.profile)) {
        logError(`Invalid stream profile: ${stream.profile}`, new Error("Profile must be main, sub or ext"));
        return false;
      }
      if (stream.width <= 0 || stream.height <= 0) {
        logError(`Invalid resolution: ${stream.width}x${stream.height}`, new Error("Resolution must be > 0"));
        return false;
      }
      if (stream.frameRate < 0) {
        logError(`Invalid frame rate: ${stream.frameRate}`, new Error("Frame rate must be >= 0"));
        return false;
      }
    }

    logSuccess(`All streams are valid (${metadata.streams.length} streams)`);
    return true;
  } catch (error) {
    logError("Error while running getStreamMetadata test", error);
    return false;
  }
}

async function testOsd(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing getOsd (channel ${channel})`);
    const osd = await api.getOsd(channel);
    logSuccess(`OSD fetched (channel ${channel})`);
    log("OSD Config", osd);

    // Validate shape
    if (osd.channel !== channel) {
      logError(`Channel mismatch: expected ${channel}, got ${osd.channel}`, new Error("Channel mismatch"));
      return false;
    }

    logSuccess("OSD config is valid");
    return true;
  } catch (error) {
    logError("Error while running getOsd test", error);
    return false;
  }
}

async function testSetOsd(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing setOsd (channel ${channel})`);
    
    // Get current configuration
    const currentOsd = await api.getOsd(channel);
    log("Current OSD", currentOsd);

    // Create a new configuration (keep existing values)
    const newOsd = {
      channel,
      osdChannel: {
        enable: currentOsd.osdChannel.enable,
        name: currentOsd.osdChannel.name || "Test Channel",
        pos: currentOsd.osdChannel.pos || "TopLeft",
      },
      osdTime: {
        enable: currentOsd.osdTime.enable,
        pos: currentOsd.osdTime.pos || "TopRight",
      },
      watermark: currentOsd.watermark || 0,
    };

    await api.setOsd(channel, newOsd);
    logSuccess(`OSD set (channel ${channel})`);

    // Verify it was saved
    const verifyOsd = await api.getOsd(channel);
    if (verifyOsd.osdChannel.name !== newOsd.osdChannel.name) {
      logError("OSD was not saved correctly", new Error("Name mismatch"));
      return false;
    }

    logSuccess("OSD config saved and verified");
    return true;
  } catch (error) {
    logError("Error while running setOsd test", error);
    return false;
  }
}

async function testAiState(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing getAiState (channel ${channel})`);
    const aiState = await api.getAiState(channel);
    logSuccess(`AI State fetched (channel ${channel})`);
    log("AI State", aiState);

    // Validate shape
    if (aiState.channel !== channel) {
      logError(`Channel mismatch: expected ${channel}, got ${aiState.channel}`, new Error("Channel mismatch"));
      return false;
    }

    logSuccess("AI State is valid");
    return true;
  } catch (error) {
    logError("Error while running getAiState test", error);
    return false;
  }
}

async function testMotionState(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing getMotionState (channel ${channel})`);
    const motionState = await api.getMotionState(channel);
    logSuccess(`Motion State fetched (channel ${channel})`);
    log("Motion State", { enabled: motionState });

    // Validate type
    if (typeof motionState !== "boolean") {
      logError(`Motion state must be boolean, got ${typeof motionState}`, new Error("Type mismatch"));
      return false;
    }

    logSuccess("Motion State is valid");
    return true;
  } catch (error) {
    logError("Error while running getMotionState test", error);
    return false;
  }
}

async function testEvents(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing getEvents (channel ${channel})`);
    const events = await api.getEvents(channel);
    logSuccess(`Events fetched (channel ${channel})`);
    log("Events", events);

    // Basic validation
    if (events.channel !== undefined && events.channel !== channel) {
      logError(`Channel mismatch: expected ${channel}, got ${events.channel}`, new Error("Channel mismatch"));
      return false;
    }

    logSuccess("Events are valid");
    return true;
  } catch (error) {
    logError("Error while running getEvents test", error);
    return false;
  }
}

async function testSubscribeEvents(api: ReolinkBaichuanApi) {
  try {
    log("Testing subscribeEvents");
    
    let eventReceived = false;
    const eventTimeout = setTimeout(() => {
      if (!eventReceived) {
        log("No events received within 10 seconds (normal if there is no motion)");
      }
    }, 10000);

    // Subscribe to events
    await api.subscribeEvents();
    logSuccess("Event subscription enabled");

    // Event listener
    api.client.on("event", (event: ReolinkEvent) => {
      eventReceived = true;
      clearTimeout(eventTimeout);
      log("Event received", event);
    });

    // Wait a bit for events
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Unsubscribe
    await api.unsubscribeEvents();
    logSuccess("Event subscription disabled");

    clearTimeout(eventTimeout);
    return true;
  } catch (error) {
    logError("Error while running subscribeEvents test", error);
    return false;
  }
}

async function testTwoWayAudioConfig(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing getTwoWayAudioConfig (channel ${channel})`);
    const config = await api.getTwoWayAudioConfig(channel);
    logSuccess(`Two-way audio config fetched (channel ${channel})`);
    log("Two-Way Audio Config", config);

    // Validate shape
    if (config.channel !== channel) {
      logError(`Channel mismatch: expected ${channel}, got ${config.channel}`, new Error("Channel mismatch"));
      return false;
    }

    if (typeof config.enabled !== "boolean") {
      logError(`enabled must be boolean, got ${typeof config.enabled}`, new Error("Type mismatch"));
      return false;
    }

    logSuccess("Two-way audio config is valid");
    if (config.enabled) {
      logSuccess("Two-way audio is supported on this device");
    } else {
      log("Two-way audio is not supported on this device");
    }
    return true;
  } catch (error) {
    logError("Error while running getTwoWayAudioConfig test", error);
    return false;
  }
}

async function testTwoWayAudio(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing startTwoWayAudio (channel ${channel})`);

    // First check if supported
    const config = await api.getTwoWayAudioConfig(channel);
    if (!config.enabled) {
      log("Two-way audio not supported, skipping test");
      return true; // Not an error
    }

    // Start two-way audio
    await api.startTwoWayAudio(channel);
    logSuccess("Two-way audio started");

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Test sending audio (test data - PCM silence)
    const testAudioData = Buffer.alloc(160); // 160 bytes = 10ms at 8kHz, 16-bit
    try {
      await api.sendAudioData(testAudioData, channel);
      logSuccess("Audio data sent (silence test)");
    } catch (error) {
      logError("Error while sending audio data", error);
      // Do not fail the whole test; could be device/firmware-specific.
    }

    // Stop two-way audio
    await api.stopTwoWayAudio(channel);
    logSuccess("Two-way audio stopped");

    return true;
  } catch (error) {
    logError("Error while running two-way audio test", error);
    return false;
  }
}

async function runNativeApiTests() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║      NATIVE API TEST SUITE - REOLINK BAICHUAN             ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfiguration:`);
  console.log(`  Host: ${config.tcp.host}`);
  console.log(`  Username: ${config.tcp.username}\n`);

  if (!config.tcp.host || !config.tcp.password) {
    console.error("[ERROR] TCP configuration is incomplete in the .env file");
    console.error("Set TCP_HOST and TCP_PASSWORD");
    process.exit(1);
  }

  const api = new ReolinkBaichuanApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
    transport: "tcp",
    debug: false,
  });

  const channel = 0;
  const results: Record<string, boolean> = {};

  try {
    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completed");

    // Test Stream Metadata
    results.streamMetadata = await testStreamMetadata(api, channel);

    // Test OSD
    results.getOsd = await testOsd(api, channel);
    results.setOsd = await testSetOsd(api, channel);

    // Test AI State
    results.aiState = await testAiState(api, channel);

    // Test Motion State
    results.motionState = await testMotionState(api, channel);

    // Test Events
    results.getEvents = await testEvents(api, channel);

    // Test Subscribe Events
    results.subscribeEvents = await testSubscribeEvents(api);

    // Test Two-Way Audio Config
    results.twoWayAudioConfig = await testTwoWayAudioConfig(api, channel);

    // Test Two-Way Audio
    results.twoWayAudio = await testTwoWayAudio(api, channel);

    // Summary
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    TEST SUMMARY                           ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log("\n");

    const passed = Object.values(results).filter((r) => r).length;
    const total = Object.keys(results).length;

    for (const [testName, result] of Object.entries(results)) {
      console.log(`${testName}: ${result ? "OK" : "FAILED"}`);
    }

    console.log(`\nResults: ${passed}/${total} tests passed\n`);

    if (passed === total) {
      console.log("All tests passed");
    } else {
      console.log(`[WARN] ${total - passed} tests failed`);
    }
  } catch (error) {
    logError("Fatal error during test", error);
    process.exit(1);
  } finally {
    try {
      await api.close();
      logSuccess("Connection closed");
    } catch (error) {
      logError("Error while closing connection", error);
    }
  }
}

// Run tests
runNativeApiTests().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

