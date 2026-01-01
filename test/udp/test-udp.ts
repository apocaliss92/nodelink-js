#!/usr/bin/env node
/**
 * Full test suite for the Baichuan UDP protocol (BCUDP).
 * Tests: login, ping, device info, network ports, encoding, general info.
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
  } else {
    console.error(`   Details: ${error}`);
  }
}

async function runUdpTests() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║         UDP TEST SUITE (BCUDP) - REOLINK BAICHUAN         ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfiguration:`);
  console.log(`  Host: 255.255.255.255 (broadcast)`);
  console.log(`  Username: ${config.udp.username}`);
  console.log(`  UID: ${config.udp.uid}\n`);

  const api = new ReolinkBaichuanApi({
    host: "255.255.255.255",
    username: config.udp.username,
    password: config.udp.password,
    uid: config.udp.uid,
    transport: "udp",
    debug: true, // Enable debug to see what's happening
  });

  // Handle errors
  api.client.on("error", () => {
    // Errors are handled in try/catch blocks.
  });

  // Discovery debug - show all UDP debug events
  api.client.on("debug", (event: string, data?: unknown) => {
    console.log(`  [DEBUG UDP] ${event}:`, data);
  });

  const results: Record<string, boolean> = {};

  try {
    // ========== TEST 1: LOGIN ==========
    log("Test 1: Login UDP");
    await api.login();
    logSuccess("UDP login succeeded");
    results.login = true;

    // ========== TEST 2: PING ==========
    log("Test 2: Ping UDP");
    await api.ping();
    logSuccess("UDP ping succeeded");
    results.ping = true;

    // ========== TEST 3: DEVICE INFO ==========
    log("Test 3: GetInfo - Device information");
    const deviceInfo = await api.getInfo();
    log("Device information", deviceInfo);
    logSuccess("UDP GetInfo succeeded");
    results.deviceInfo = true;

    // ========== TEST 4: NETWORK PORTS ==========
    log("Test 4: GetPorts - Network ports");
    const ports = await api.getPorts();
    log("Network ports", ports);
    logSuccess("UDP GetPorts succeeded");
    results.ports = true;

    // ========== TEST 5: GENERAL INFO (Network, MAC, etc.) ==========
    log("Test 5: GetGeneralXml - General information (Network, MAC, etc.)");
    const generalXml = await api.getGeneralXml();
    log("General XML (first 500 chars)", generalXml.substring(0, 500));
    logSuccess("UDP GetGeneralXml succeeded");
    results.generalInfo = true;

    // ========== TEST 6: ENCODING INFO ==========
    log("Test 6: GetEncXml - Encoding information");
    const encXml = await api.getEncXml(0);
    log("Encoding XML (first 500 chars)", encXml.substring(0, 500));
    logSuccess("UDP GetEncXml succeeded");
    results.encoding = true;

    // Close connection
    await api.close();
    logSuccess("UDP connection closed");

    // Summary
    console.log("\n\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    UDP TEST SUMMARY                       ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    const testNames: Record<string, string> = {
      login: "Login",
      ping: "Ping",
      deviceInfo: "Device Info",
      ports: "Network Ports",
      generalInfo: "General Info (Network/MAC)",
      encoding: "Encoding Info",
    };
    for (const [key, name] of Object.entries(testNames)) {
      console.log(`${name.padEnd(30)}: ${results[key] ? "OK" : "FAILED"}`);
    }
    const successCount = Object.values(results).filter((r) => r).length;
    console.log(`\nTests succeeded: ${successCount}/${Object.keys(results).length}\n`);

    return successCount === Object.keys(results).length;
  } catch (error) {
    logError("Error while running UDP tests", error);
    try {
      await api.close();
    } catch {
      // Ignore close errors
    }
    return false;
  }
}

// Esegui i test
runUdpTests()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    logError("Fatal error", error);
    process.exit(1);
  });

