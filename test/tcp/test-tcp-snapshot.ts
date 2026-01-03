#!/usr/bin/env node
/**
 * Test suite for the Baichuan TCP snapshot functionality.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  } else {
    console.error(`   Details: ${error}`);
  }
}

async function runSnapshotTest() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║      TCP SNAPSHOT TEST SUITE - REOLINK BAICHUAN           ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfiguration:`);
  console.log(`  Host: ${config.tcp.host}`);
  console.log(`  Username: ${config.tcp.username}\n`);

  const api = new ReolinkBaichuanApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
    transport: "tcp",
    debugOptions: { general: true },
  });

  // Handle errors
  api.client.on("error", (err: any) => {
    console.error("Client error:", err);
  });

  try {
    // ========== TEST 1: LOGIN ==========
    log("Test 1: Login TCP");
    await api.login();
    logSuccess("TCP login succeeded");

    // ========== TEST 2: SNAPSHOT ==========
    log("Test 2: GetSnapshot");
    
    // Try channel 0 first
    const channel = 0;
    log(`Requesting snapshot for channel ${channel}...`);
    
    const snapshotBuffer = await api.getSnapshot(channel);
    
    log(`Snapshot received. Size: ${snapshotBuffer.length} bytes`);
    
    if (snapshotBuffer.length > 0) {
      const filename = `snapshot_ch${channel}_${Date.now()}.jpg`;
      const outDir = path.join(process.cwd(), "test", "diagnostics", "snapshots");
      fs.mkdirSync(outDir, { recursive: true });
      const outputPath = path.join(outDir, filename);
      fs.writeFileSync(outputPath, snapshotBuffer);
      logSuccess(`Snapshot saved to ${outputPath}`);
      
      // Check magic bytes for JPEG (FF D8)
      if (snapshotBuffer[0] === 0xFF && snapshotBuffer[1] === 0xD8) {
        logSuccess("Snapshot has valid JPEG magic bytes");
      } else {
        logError("Snapshot does NOT have valid JPEG magic bytes", `First bytes: ${snapshotBuffer.subarray(0, 10).toString('hex')}`);
        // Try to print as string if it looks like XML
        const str = snapshotBuffer.toString('utf8');
        if (str.trim().startsWith('<')) {
            log("Snapshot content (XML):", str);
        }
      }
    } else {
      logError("Snapshot buffer is empty", "Received 0 bytes");
    }

    // Close connection
    await api.close();
    logSuccess("TCP connection closed");

    return true;
  } catch (error) {
    logError("Error while running Snapshot test", error);
    try {
      await api.close();
    } catch {
      // Ignore close errors
    }
    return false;
  }
}

// Run tests
runSnapshotTest()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    logError("Fatal error", error);
    process.exit(1);
  });
