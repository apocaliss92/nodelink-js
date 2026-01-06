#!/usr/bin/env node
/**
 * Test suite for audio APIs (2-way audio).
 * Tests: getTwoWayAudioConfig, startTwoWayAudio, sendAudioData, stopTwoWayAudio.
 * Includes G.711 encode/decode tests.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, Intercom } from "../../index";
import { config } from "../env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Modern G.711 A-law library (CommonJS, use default import)
import alawmulaw from "alawmulaw";
const { alaw, mulaw } = alawmulaw;

// Helper functions
function log(message: string, data?: unknown) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[INFO] ${message}`);
  if (data !== undefined) {
    if (data instanceof Buffer) {
      console.log(`   Buffer: ${data.length} bytes`);
      console.log(`   Hex preview: ${data.subarray(0, Math.min(32, data.length)).toString("hex")}`);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
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

async function testG711Encoding() {
  try {
    log("Test encoding/decoding G.711");

    // Create test PCM data (silence - all zeros).
    // 160 bytes = 10ms at 8kHz, 16-bit (80 samples).
    const pcmData = Buffer.alloc(160);
    log("PCM Input", pcmData);

    // Convert Buffer to Int16Array for alawmulaw
    const pcmInt16 = new Int16Array(pcmData.length / 2);
    for (let i = 0; i < pcmInt16.length; i++) {
      pcmInt16[i] = pcmData.readInt16LE(i * 2);
    }

    // Test G.711 A-law encoding
    const g711aEncoded = Buffer.from(alaw.encode(pcmInt16));
    log("G.711 A-law Encoded", g711aEncoded);

    // Test G.711 A-law decoding
    const g711aDecodedInt16 = alaw.decode(new Uint8Array(g711aEncoded));
    const g711aDecoded = Buffer.alloc(g711aDecodedInt16.length * 2);
    for (let i = 0; i < g711aDecodedInt16.length; i++) {
      g711aDecoded.writeInt16LE(g711aDecodedInt16[i] ?? 0, i * 2);
    }
    log("G.711 A-law Decoded", g711aDecoded);

    // Verify decode output shape (can have small quantization differences).
    if (g711aDecoded.length !== pcmData.length) {
      logError("Length mismatch after decode", new Error(`Expected ${pcmData.length}, got ${g711aDecoded.length}`));
      return false;
    }

    logSuccess("G.711 encoding/decoding looks correct");
    return true;
  } catch (error) {
    logError("Error while running G.711 encode/decode test", error);
    return false;
  }
}

async function testTwoWayAudioConfig(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing getTwoWayAudioConfig (channel ${channel})`);
    const audioConfig = await api.getTwoWayAudioConfig(channel);
    logSuccess(`Two-way audio config fetched (channel ${channel})`);
    log("Two-Way Audio Config", audioConfig);

    // Validate shape
    if (audioConfig.channel !== channel) {
      logError(`Channel mismatch: expected ${channel}, got ${audioConfig.channel}`, new Error("Channel mismatch"));
      return false;
    }

    if (typeof audioConfig.enabled !== "boolean") {
      logError(`enabled must be boolean, got ${typeof audioConfig.enabled}`, new Error("Type mismatch"));
      return false;
    }

    logSuccess("Two-way audio config is valid");
    if (audioConfig.enabled) {
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

async function testStartStopTwoWayAudio(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing startTwoWayAudio / stopTwoWayAudio (channel ${channel})`);

    // Check if supported
    const config = await api.getTwoWayAudioConfig(channel);
    if (!config.enabled) {
      log("Two-way audio not supported, skipping test");
      return true; // Not an error
    }

    // Start two-way audio
    await api.startTwoWayAudio(channel);
    logSuccess("Two-way audio started");

    // Give it some time to stabilize
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Stop two-way audio
    await api.stopTwoWayAudio(channel);
    logSuccess("Two-way audio stopped");

    return true;
  } catch (error) {
    logError("Error while running start/stop two-way audio test", error);
    return false;
  }
}

/**
 * Extracts PCM data from a WAV file (test helper).
 * In production, audio should already arrive as PCM from ffmpeg.
 */
function extractPCMFromWav(wavBuffer: Buffer): { pcmData: Buffer; sampleRate: number } {
  // Standard WAV header is 44 bytes; locate the "data" chunk.
  const dataOffset = wavBuffer.indexOf(Buffer.from("data"));
  if (dataOffset === -1) {
    throw new Error("Invalid WAV file: 'data' chunk not found");
  }
  
  // Sample rate is at offset 24
  const sampleRate = wavBuffer.readUInt32LE(24);
  
  // Offset: "data" (4) + size (4) = 8 bytes after "data"
  const pcmStart = dataOffset + 8;
  const pcmData = wavBuffer.subarray(pcmStart);
  
  return { pcmData, sampleRate };
}

async function testSendAudioData(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing sendAudioData (channel ${channel})`);

    // Check if supported
    const audioConfig = await api.getTwoWayAudioConfig(channel);
    if (!audioConfig.enabled) {
      log("Two-way audio not supported, skipping test");
      return true; // Not an error
    }

    // Start two-way audio
    await api.startTwoWayAudio(channel);
    logSuccess("Two-way audio started");

    // Load test audio file (WAV PCM).
    // In production, PCM comes from ffmpeg, so only G.711 encoding is needed.
    const audioSamplePath = join(process.cwd(), "test", "audio-samples", "test-tone.wav");
    let pcmData: Buffer;
    
    try {
      const wavData = readFileSync(audioSamplePath);
      log(`Audio file loaded: ${audioSamplePath}`);
      
      // Extract PCM from WAV (test only)
      const extracted = extractPCMFromWav(wavData);
      pcmData = extracted.pcmData;
      
      log(`PCM Audio Data: ${pcmData.length} bytes (${(pcmData.length / 2 / extracted.sampleRate).toFixed(2)}s a ${extracted.sampleRate}Hz)`);
      
      // Warn if sample rate is not 8kHz
      if (extracted.sampleRate !== 8000) {
        log(`Sample rate is ${extracted.sampleRate}Hz (not 8kHz). In production, configure ffmpeg to output 8kHz.`);
      }
    } catch (error) {
      logError("Error while loading audio file", error);
      log("Could not load audio file; using test data (silence)");
      // Fallback: usa silenzio
      pcmData = Buffer.alloc(1600); // 100ms silence
    }

    // Send audio in chunks (160 bytes = 10ms per chunk)
    const chunkSize = 160; // 10ms a 8kHz, 16-bit
    const numChunks = Math.ceil(pcmData.length / chunkSize);
    
    log(`Sending audio in ${numChunks} chunks of ${chunkSize} bytes (10ms each)`);

    for (let i = 0; i < numChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, pcmData.length);
      const chunk = pcmData.subarray(start, end);
      
      // Encode to G.711 A-law.
      const pcmInt16 = new Int16Array(chunk.length / 2);
      for (let i = 0; i < pcmInt16.length; i++) {
        pcmInt16[i] = chunk.readInt16LE(i * 2);
      }
      const g711Chunk = Buffer.from(alaw.encode(pcmInt16));
      
      // Send chunk
      await api.sendAudioData(g711Chunk, channel);
      
      // Wait 10ms between chunks (simulate realtime)
      await new Promise((resolve) => setTimeout(resolve, 10));
      
      if ((i + 1) % 10 === 0) {
        log(`   Sent ${i + 1}/${numChunks} chunks`);
      }
    }

    logSuccess(`Audio data sent (${pcmData.length} bytes PCM = ${(pcmData.length / 2 / 8000).toFixed(2)}s)`);

    // Give it time to flush
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Stop two-way audio
    await api.stopTwoWayAudio(channel);
    logSuccess("Two-way audio stopped");

    return true;
  } catch (error) {
    logError("Error while running sendAudioData test", error);
    return false;
  }
}

async function testIntercom(api: ReolinkBaichuanApi, channel: number = 0) {
  try {
    log(`Testing Intercom (channel ${channel})`);

    // Check if supported
    const audioConfig = await api.getTwoWayAudioConfig(channel);
    if (!audioConfig.enabled) {
      log("Two-way audio not supported, skipping test");
      return true; // Not an error
    }

    let audioReceived = false;
    let audioChunksReceived = 0;
    const audioCallback = (data: Buffer) => {
      audioReceived = true;
      audioChunksReceived++;
      if (audioChunksReceived <= 3) {
        log(`Audio received from camera (chunk ${audioChunksReceived})`, data);
      }
    };

    // Create intercom
    const intercom = new Intercom({
      channel,
      api,
    });

    // Start intercom
    await intercom.start();
    logSuccess("Intercom started");

    // Load test audio file (WAV PCM)
    const audioSamplePath = join(process.cwd(), "test", "audio-samples", "test-tone.wav");
    let pcmData: Buffer;
    
    try {
      const audioFileData = readFileSync(audioSamplePath);
      log(`Audio file loaded for Intercom: ${audioSamplePath}`);
      
      // Extract PCM from WAV (test only)
      const extracted = extractPCMFromWav(audioFileData);
      pcmData = extracted.pcmData;
      
      log(`PCM Audio Data: ${pcmData.length} bytes (${extracted.sampleRate}Hz)`);
      
      if (extracted.sampleRate !== 8000) {
        log(`Sample rate is ${extracted.sampleRate}Hz (not 8kHz). In production, configure ffmpeg to output 8kHz.`);
      }
    } catch (error) {
      logError("Error while decoding audio", error);
      log("Could not load/decode audio file; using test data");
      pcmData = Buffer.alloc(1600); // 100ms silence
    }

    // Send audio via Intercom
    await intercom.sendAudio(pcmData);
    logSuccess(`Audio sent via Intercom (${pcmData.length} bytes PCM)`);

    // Wait a bit for any audio coming back
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (!audioReceived) {
      log("No audio received (normal if the camera is not sending audio)");
    } else {
      logSuccess(`Received ${audioChunksReceived} audio chunks from camera`);
    }

    // Stop intercom
    await intercom.stop();
    logSuccess("Intercom stopped");

    return true;
  } catch (error) {
    logError("Error while running Intercom test", error);
    return false;
  }
}

async function runAudioTests() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║         AUDIO TEST SUITE - REOLINK BAICHUAN               ║");
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

    // Test G.711 encoding/decoding (offline)
    results.g711Encoding = await testG711Encoding();

    // Test Two-Way Audio Config
    results.twoWayAudioConfig = await testTwoWayAudioConfig(api, channel);

    // Test Start/Stop Two-Way Audio
    results.startStopAudio = await testStartStopTwoWayAudio(api, channel);

    // Test Send Audio Data
    results.sendAudioData = await testSendAudioData(api, channel);

    // Test Intercom
    results.intercom = await testIntercom(api, channel);

    // Summary
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    AUDIO TEST SUMMARY                     ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log("\n");

    const passed = Object.values(results).filter((r) => r).length;
    const total = Object.keys(results).length;

    for (const [testName, result] of Object.entries(results)) {
      console.log(`${testName}: ${result ? "OK" : "FAILED"}`);
    }

    console.log(`\nResults: ${passed}/${total} tests passed\n`);

    if (passed === total) {
      console.log("All audio tests passed");
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
runAudioTests().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

