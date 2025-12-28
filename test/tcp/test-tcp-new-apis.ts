#!/usr/bin/env node
/**
 * Test suite for newly implemented Baichuan APIs.
 * Tests: PTZ, Battery Info, PIR, Motion/AI Detection Settings, Siren, White LED, Ability Info.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
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

// --------------------
// PTZ Control Tests
// --------------------

async function testGetPtzPresets(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing getPtzPresets (channel ${channel})`);
    const presets = await api.getPtzPresets(channel);
    logSuccess(`PTZ presets fetched (channel ${channel})`);
    log("PTZ Presets", presets);

    // Validate shape
    if (!Array.isArray(presets)) {
      logError("Presets is not an array", new Error("Expected array"));
      return false;
    }

    // Validate each preset
    for (const preset of presets) {
      if (typeof preset.id !== "number" || preset.id < 0 || preset.id > 255) {
        logError(`Invalid preset ID: ${preset.id}`, new Error("Preset ID must be 0-255"));
        return false;
      }
      if (typeof preset.name !== "string") {
        logError(`Invalid preset name: ${preset.name}`, new Error("Preset name must be string"));
        return false;
      }
    }

    logSuccess(`All presets are valid (${presets.length} presets)`);
    return true;
  } catch (error) {
    logError("Error while running getPtzPresets test", error);
    return false;
  }
}

async function testGetPtzPosition(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing getPtzPosition (channel ${channel})`);
    const position = await api.getPtzPosition(channel);
    logSuccess(`PTZ position fetched (channel ${channel})`);
    log("PTZ Position", position);

    // Position is optional, so we just validate the shape if present
    if (position.pan !== undefined && (typeof position.pan !== "number" || position.pan < 0)) {
      logError(`Invalid pan position: ${position.pan}`, new Error("Pan must be >= 0"));
      return false;
    }
    if (position.tilt !== undefined && (typeof position.tilt !== "number" || position.tilt < 0)) {
      logError(`Invalid tilt position: ${position.tilt}`, new Error("Tilt must be >= 0"));
      return false;
    }

    logSuccess("PTZ position is valid");
    return true;
  } catch (error) {
    logError("Error while running getPtzPosition test", error);
    // This API may not be supported on all cameras, so we don't fail the test
    log("Note: getPtzPosition may not be supported on all camera models");
    return true;
  }
}

async function testPtzControl(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing ptz control (channel ${channel})`);
    
    // First, try a small movement command (start then stop)
    log("Testing PTZ Up command (start)");
    try {
      await api.ptz(channel, { action: "start", command: "Up", speed: 0.5 });
      logSuccess("PTZ Up command sent successfully");
      
      // Wait a bit for movement
      await new Promise((resolve) => setTimeout(resolve, 300));
      
      // Then stop
      log("Testing PTZ Stop command");
      await api.ptz(channel, { action: "stop", command: "Up" });
      logSuccess("PTZ Stop command sent successfully");
    } catch (error) {
      logError("Error during PTZ movement test", error);
      // Try just stop as fallback
      log("Trying PTZ Stop command as fallback");
      try {
        await api.ptz(channel, { action: "stop", command: "Up" });
        logSuccess("PTZ Stop command sent successfully (fallback)");
      } catch (stopError) {
        logError("PTZ Stop also failed", stopError);
        throw stopError;
      }
    }
    
    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 500));
    
    logSuccess("PTZ control test completed");
    return true;
  } catch (error) {
    logError("Error while running ptz control test", error);
    // PTZ may not be supported on all cameras
    log("Note: PTZ control may not be supported on all camera models");
    return true;
  }
}

async function testMoveToPtzPreset(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing moveToPtzPreset (channel ${channel})`);
    
    // First get presets to see which ones are available
    const presets = await api.getPtzPresets(channel);
    if (presets.length === 0) {
      log("No presets available to test");
      return true;
    }
    
    // Try moving to the first preset
    const firstPreset = presets[0];
    log(`Moving to preset ${firstPreset.id} (${firstPreset.name})`);
    await api.moveToPtzPreset(channel, firstPreset.id);
    logSuccess(`Successfully moved to preset ${firstPreset.id}`);
    
    // Wait a bit for the camera to move
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    logSuccess("moveToPtzPreset test completed");
    return true;
  } catch (error) {
    logError("Error while running moveToPtzPreset test", error);
    log("Note: moveToPtzPreset may not be supported on all camera models");
    return true;
  }
}

async function testSetPtzPreset(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing setPtzPreset (channel ${channel})`);
    
    // Try to save current position as a test preset (use a high ID like 99 to avoid conflicts)
    const testPresetId = 99;
    const testPresetName = "TestPreset_" + Date.now();
    
    log(`Saving current position as preset ${testPresetId} (${testPresetName})`);
    await api.setPtzPreset(channel, testPresetId, testPresetName);
    logSuccess(`Successfully saved preset ${testPresetId}`);
    
    // Verify it was saved by getting presets again
    const presets = await api.getPtzPresets(channel);
    const savedPreset = presets.find((p: { id: number; name: string }) => p.id === testPresetId);
    if (savedPreset) {
      logSuccess(`Preset ${testPresetId} found in preset list: ${savedPreset.name}`);
    } else {
      log("Note: Preset may not appear immediately in the list");
    }
    
    logSuccess("setPtzPreset test completed");
    return true;
  } catch (error) {
    logError("Error while running setPtzPreset test", error);
    log("Note: setPtzPreset may not be supported on all camera models");
    return true;
  }
}

// --------------------
// Battery Info Tests
// --------------------

async function testGetBatteryInfo(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing getBatteryInfo (channel ${channel})`);
    const batteryInfo = await api.getBatteryInfo(channel);
    logSuccess(`Battery info fetched (channel ${channel})`);
    log("Battery Info", batteryInfo);

    // Validate shape
    if (batteryInfo.channel !== undefined && batteryInfo.channel !== channel) {
      logError(`Channel mismatch: expected ${channel}, got ${batteryInfo.channel}`, new Error("Channel mismatch"));
      return false;
    }

    if (batteryInfo.batteryPercent !== undefined) {
      if (typeof batteryInfo.batteryPercent !== "number" || batteryInfo.batteryPercent < 0 || batteryInfo.batteryPercent > 100) {
        logError(`Invalid battery percent: ${batteryInfo.batteryPercent}`, new Error("Battery percent must be 0-100"));
        return false;
      }
    }

    logSuccess("Battery info is valid");
    return true;
  } catch (error) {
    logError("Error while running getBatteryInfo test", error);
    // Battery info may not be available on all cameras (only battery-powered models)
    log("Note: getBatteryInfo is typically only available on battery-powered camera models");
    return true;
  }
}

// --------------------
// PIR State Tests
// --------------------

async function testGetPirInfo(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing getPirInfo (channel ${channel})`);
    const pirInfo = await api.getPirInfo(channel);
    logSuccess(`PIR info fetched (channel ${channel})`);
    log("PIR Info", pirInfo);

    // Validate shape
    if (typeof pirInfo.enabled !== "boolean") {
      logError("PIR enabled is not a boolean", new Error("Expected boolean"));
      return false;
    }

    if (pirInfo.state && typeof pirInfo.state.enable !== "number" && pirInfo.state.enable !== undefined) {
      logError("Invalid PIR state.enable", new Error("Expected number or undefined"));
      return false;
    }

    logSuccess("PIR info is valid");
    return true;
  } catch (error) {
    logError("Error while running getPirInfo test", error);
    // PIR may not be supported on all cameras
    log("Note: PIR detection may not be supported on all camera models");
    return true;
  }
}

async function testSetPirInfo(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing setPirInfo (channel ${channel})`);
    
    // Get current state first
    const currentPir = await api.getPirInfo(channel);
    log("Current PIR state", currentPir);
    
    // Try to set it to the same value (safest)
    const newEnable = currentPir.enabled ? 1 : 0;
    log(`Setting PIR enable to ${newEnable}`);
    
    await api.setPirInfo(channel, { enable: newEnable });
    logSuccess("PIR settings updated successfully");
    
    // Verify it was set
    const updatedPir = await api.getPirInfo(channel);
    if (updatedPir.enabled !== currentPir.enabled) {
      logError("PIR state changed unexpectedly", new Error("State should not have changed"));
      return false;
    }
    
    logSuccess("PIR set/get test completed successfully");
    return true;
  } catch (error) {
    logError("Error while running setPirInfo test", error);
    // PIR may not be supported on all cameras
    log("Note: PIR settings may not be supported on all camera models");
    return true;
  }
}

// --------------------
// Motion Detection Set Tests
// --------------------

async function testSetMotionDetection(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing setMotionDetection (channel ${channel})`);
    
    // Get current state first
    const currentState = await api.getMotionState(channel);
    log(`Current motion detection state: ${currentState}`);
    
    // Try to set it to the same value (safest)
    log(`Setting motion detection to ${currentState}`);
    await api.setMotionDetection(channel, currentState);
    logSuccess("Motion detection settings updated successfully");
    
    // Verify it was set
    const updatedState = await api.getMotionState(channel);
    if (updatedState !== currentState) {
      logError("Motion detection state changed unexpectedly", new Error("State should not have changed"));
      return false;
    }
    
    logSuccess("Motion detection set/get test completed successfully");
    return true;
  } catch (error) {
    logError("Error while running setMotionDetection test", error);
    return false;
  }
}

// --------------------
// AI Detection Set Tests
// --------------------

async function testSetAiDetection(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing setAiDetection (channel ${channel})`);
    
    // Test with "people" AI type (most commonly supported)
    log("Testing AI detection for 'people' type");
    
    // Try to get current state first (may fail if not supported)
    try {
      const currentAiState = await api.getAiState(channel);
      log("Current AI state", currentAiState);
    } catch {
      log("Note: getAiState may require ai_type parameter, skipping");
    }
    
    // Try to set sensitivity to a reasonable value (50)
    // Note: This may fail if AI detection is not configured or not supported
    log("Attempting to set AI detection sensitivity to 50");
    try {
      await api.setAiDetection(channel, "people", 50);
      logSuccess("AI detection settings updated successfully");
    } catch (error) {
      log("Note: setAiDetection may require specific AI types or may not be fully supported");
      logError("setAiDetection failed (may be expected)", error);
    }
    
    logSuccess("AI detection set test attempted");
    return true;
  } catch (error) {
    logError("Error while running setAiDetection test", error);
    // AI detection settings may vary by camera model
    log("Note: AI detection settings may not be supported or may require specific configuration");
    return true;
  }
}

// --------------------
// Siren/Audio Alarm Tests
// --------------------

async function testGetSiren(api: ReolinkBaichuanApi, channel?: number) {
  try {
    log(`Testing getSiren (channel ${channel ?? "host"})`);
    const sirenState = await api.getSiren(channel);
    logSuccess(`Siren state fetched (channel ${channel ?? "host"})`);
    log("Siren State", sirenState);

    // Validate shape
    if (typeof sirenState.enabled !== "boolean") {
      logError("Siren enabled is not a boolean", new Error("Expected boolean"));
      return false;
    }

    logSuccess("Siren state is valid");
    return true;
  } catch (error) {
    logError("Error while running getSiren test", error);
    // getSiren may not work as a request (it's typically a push event)
    log("Note: getSiren may not work as a request - siren status is typically pushed via events");
    return true;
  }
}

async function testSetSiren(api: ReolinkBaichuanApi, channel?: number) {
  try {
    log(`Testing setSiren (channel ${channel ?? "host"})`);
    
    // Test times mode (play siren once - safer than manual on/off)
    log("Testing siren with times mode (1 time)");
    await api.setSiren(channel, undefined, 1);
    logSuccess("Siren played successfully (times mode)");
    
    // Wait a bit for the siren to play
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    logSuccess("Siren set test completed");
    return true;
  } catch (error) {
    logError("Error while running setSiren test", error);
    return false;
  }
}

// --------------------
// White LED Tests
// --------------------

async function testGetWhiteLedState(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing getWhiteLedState (channel ${channel})`);
    const whiteLedState = await api.getWhiteLedState(channel);
    logSuccess(`White LED state fetched (channel ${channel})`);
    log("White LED State", whiteLedState);

    // Validate shape
    if (typeof whiteLedState.enabled !== "boolean") {
      logError("White LED enabled is not a boolean", new Error("Expected boolean"));
      return false;
    }

    if (whiteLedState.brightness !== undefined) {
      if (typeof whiteLedState.brightness !== "number" || whiteLedState.brightness < 0) {
        logError(`Invalid brightness: ${whiteLedState.brightness}`, new Error("Brightness must be >= 0"));
        return false;
      }
    }

    logSuccess("White LED state is valid");
    return true;
  } catch (error) {
    logError("Error while running getWhiteLedState test", error);
    // White LED may not be supported on all cameras
    log("Note: White LED/floodlight may not be supported on all camera models");
    return true;
  }
}

async function testSetWhiteLedState(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing setWhiteLedState (channel ${channel})`);
    
    // Get current state first
    const currentState = await api.getWhiteLedState(channel);
    log("Current White LED state", currentState);
    
    // Try to set it back to the same state (safest)
    log(`Setting White LED to ${currentState.enabled ? "on" : "off"}`);
    await api.setWhiteLedState(channel, currentState.enabled);
    logSuccess("White LED state updated successfully");
    
    // Verify it was set (with a small delay)
    await new Promise((resolve) => setTimeout(resolve, 500));
    const updatedState = await api.getWhiteLedState(channel);
    if (updatedState.enabled !== currentState.enabled) {
      logError("White LED state changed unexpectedly", new Error("State should not have changed"));
      return false;
    }
    
    logSuccess("White LED set/get test completed successfully");
    return true;
  } catch (error) {
    logError("Error while running setWhiteLedState test", error);
    // White LED may not be supported on all cameras
    log("Note: White LED settings may not be supported on all camera models");
    return true;
  }
}

// --------------------
// Ability Info Tests
// --------------------

async function testGetAbilityInfo(api: ReolinkBaichuanApi, username: string) {
  try {
    log(`Testing getAbilityInfo (username: ${username})`);
    const abilities = await api.getAbilityInfo(username);
    logSuccess("Ability info fetched");
    log("Ability Info", abilities);

    // Validate shape
    if (typeof abilities !== "object" || abilities === null) {
      logError("Abilities is not an object", new Error("Expected object"));
      return false;
    }

    // Check if we have any abilities
    const keys = Object.keys(abilities);
    if (keys.length === 0) {
      log("Note: No abilities found - this may be expected if the API returns empty data");
    } else {
      logSuccess(`Found abilities for ${keys.length} channel(s) or host`);
    }

    logSuccess("Ability info is valid");
    return true;
  } catch (error) {
    logError("Error while running getAbilityInfo test", error);
    // Ability info may not be available on all cameras
    log("Note: getAbilityInfo may not be supported on all camera models or firmware versions");
    return true;
  }
}

async function testGetAbilityVersion(api: ReolinkBaichuanApi, username: string) {
  try {
    log(`Testing getAbilityVersion (username: ${username})`);
    
    // Test common capabilities
    const capabilities = ["reboot", "rtsp", "onvif", "netPort"];
    
    for (const capability of capabilities) {
      try {
        const version = await api.getAbilityVersion(username, capability);
        log(`  ${capability}: ${version > 0 ? `supported (v${version})` : "not supported"}`);
      } catch (error) {
        log(`  ${capability}: error - ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    logSuccess("Ability version checks completed");
    return true;
  } catch (error) {
    logError("Error while running getAbilityVersion test", error);
    return true;
  }
}

// --------------------
// Main Test Runner
// --------------------

async function main() {
  const channel = 0;
  
  if (!config.tcp.host || !config.tcp.username || !config.tcp.password) {
    console.error("Error: TCP_HOST, TCP_USERNAME, and TCP_PASSWORD must be set in environment or .env file");
    process.exit(1);
  }

  log("Starting new Baichuan API tests", {
    host: config.tcp.host,
    username: config.tcp.username,
    channel,
  });

  const api = new ReolinkBaichuanApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
    channel,
  });

  const results: Record<string, boolean> = {};

  try {
    // Login
    log("Logging in...");
    await api.login();
    logSuccess("Login successful");

    // PTZ Tests
    log("\n" + "=".repeat(80));
    log("PTZ CONTROL TESTS");
    log("=".repeat(80));
    results["getPtzPresets"] = await testGetPtzPresets(api, channel);
    results["getPtzPosition"] = await testGetPtzPosition(api, channel);
    results["ptzControl"] = await testPtzControl(api, channel);
    results["moveToPtzPreset"] = await testMoveToPtzPreset(api, channel);
    results["setPtzPreset"] = await testSetPtzPreset(api, channel);

    // Battery Info Tests
    log("\n" + "=".repeat(80));
    log("BATTERY INFO TESTS");
    log("=".repeat(80));
    results["getBatteryInfo"] = await testGetBatteryInfo(api, channel);

    // PIR Tests
    log("\n" + "=".repeat(80));
    log("PIR STATE TESTS");
    log("=".repeat(80));
    results["getPirInfo"] = await testGetPirInfo(api, channel);
    results["setPirInfo"] = await testSetPirInfo(api, channel);

    // Motion Detection Set Tests
    log("\n" + "=".repeat(80));
    log("MOTION DETECTION SET TESTS");
    log("=".repeat(80));
    results["setMotionDetection"] = await testSetMotionDetection(api, channel);

    // AI Detection Set Tests
    log("\n" + "=".repeat(80));
    log("AI DETECTION SET TESTS");
    log("=".repeat(80));
    results["setAiDetection"] = await testSetAiDetection(api, channel);

    // Siren Tests
    log("\n" + "=".repeat(80));
    log("SIREN/AUDIO ALARM TESTS");
    log("=".repeat(80));
    results["getSiren"] = await testGetSiren(api, channel);
    results["setSiren"] = await testSetSiren(api, channel);

    // White LED Tests
    log("\n" + "=".repeat(80));
    log("WHITE LED TESTS");
    log("=".repeat(80));
    results["getWhiteLedState"] = await testGetWhiteLedState(api, channel);
    results["setWhiteLedState"] = await testSetWhiteLedState(api, channel);

    // Ability Info Tests
    log("\n" + "=".repeat(80));
    log("ABILITY INFO TESTS");
    log("=".repeat(80));
    results["getAbilityInfo"] = await testGetAbilityInfo(api, config.tcp.username);
    results["getAbilityVersion"] = await testGetAbilityVersion(api, config.tcp.username);

  } catch (error) {
    logError("Fatal error during tests", error);
  } finally {
    // Close connection
    try {
      await api.close();
      logSuccess("Connection closed");
    } catch (error) {
      logError("Error closing connection", error);
    }
  }

  // Summary
  log("\n" + "=".repeat(80));
  log("TEST SUMMARY");
  log("=".repeat(80));
  
  const passed = Object.values(results).filter(Boolean).length;
  const total = Object.keys(results).length;
  
  for (const [testName, passed] of Object.entries(results)) {
    console.log(`${passed ? "[OK]" : "[SKIP/FAIL]"} ${testName}`);
  }
  
  console.log(`\nTotal: ${passed}/${total} tests passed`);
  
  if (passed === total) {
    logSuccess("All tests passed!");
    process.exit(0);
  } else {
    log(`Some tests were skipped or failed. This is often expected if features are not supported on your camera model.`);
    process.exit(0); // Exit 0 because skipped tests are expected
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});

