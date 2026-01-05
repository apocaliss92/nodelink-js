/**
 * Test suite for Reolink device discovery on local network.
 * This test scans the local network to find Reolink cameras and devices.
 *
 * Usage:
 *   npm run test:discovery
 *   # or
 *   npx tsx test/discovery/test-discovery.ts
 */

import { discoverReolinkDevices, type DiscoveredDevice } from "../../src/reolink/discovery";
import { config } from "../env";

function log(message: string, data?: unknown) {
  console.log(`[TEST] ${message}`);
  if (data !== undefined) {
    console.log(`      `, data);
  }
}

function logSuccess(message: string) {
  console.log(`[TEST] ✅ ${message}`);
}

function logError(message: string, error: unknown) {
  console.error(`[TEST] ❌ ${message}`);
  if (error instanceof Error) {
    console.error(`      Error: ${error.message}`);
    if (error.stack) {
      console.error(`      Stack: ${error.stack.split("\n").slice(1, 3).join("\n")}`);
    }
  } else {
    console.error(`      Details: ${error}`);
  }
}

async function runDiscoveryTest() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║      REOLINK DEVICE DISCOVERY TEST - LOCAL NETWORK        ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfiguration:`);
  console.log(`  Username: ${config.tcp.username}`);
  console.log(`  Password: ${config.tcp.password ? "***" : "(not provided - will try unauthenticated)"}`);
  console.log(`  Network: Auto-detect local network\n`);

  const startTime = Date.now();

  try {
    log("Starting device discovery...");
    log("This may take a while as it scans the local network...");
    console.log("");

    const discoveryOptions: {
      username?: string;
      password?: string;
      logger?: {
        log: (msg: string) => void;
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
        debug: (msg: string) => void;
      };
      httpProbeTimeoutMs: number;
      udpBroadcastTimeoutMs: number;
      maxConcurrentProbes: number;
      enableUdpDiscovery: boolean;
      enableHttpScanning: boolean;
    } = {
      username: config.tcp.username,
      logger: {
        log: (msg: string) => {
          // Only log important messages, not every probe
          if (msg.includes("[Discovery] Starting") || msg.includes("[Discovery] Found") || msg.includes("[Discovery] complete")) {
            console.log(msg);
          }
        },
        info: (msg: string) => {
          // Only log important messages, not every probe
          if (msg.includes("[Discovery] Starting") || msg.includes("[Discovery] Found") || msg.includes("[Discovery] complete")) {
            console.log(msg);
          }
        },
        warn: (msg: string) => console.warn(msg),
        error: (msg: string) => console.error(msg),
        debug: (msg: string) => {
          // Suppress debug messages unless verbose
        },
      },
      httpProbeTimeoutMs: 2000,
      udpBroadcastTimeoutMs: 5000,
      maxConcurrentProbes: 50,
      enableUdpDiscovery: true,
      enableHttpScanning: true,
    };
    if (config.tcp.password) {
      discoveryOptions.password = config.tcp.password;
    }
    const devices = await discoverReolinkDevices(discoveryOptions);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                   DISCOVERY RESULTS                        ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log(`\nScan completed in ${duration} seconds`);
    console.log(`Found ${devices.length} device(s):\n`);

    if (devices.length === 0) {
      console.log("  No Reolink devices found on the local network.");
      console.log("\nPossible reasons:");
      console.log("  - No Reolink devices are on the same network");
      console.log("  - Devices require authentication and credentials were not provided");
      console.log("  - Devices are on a different network segment");
      console.log("  - Firewall blocking discovery packets");
      console.log("  - Devices are in sleep mode (battery cameras)");
      return;
    }

    // Display discovered devices
    for (let i = 0; i < devices.length; i++) {
      const device = devices[i];
      if (!device) continue;
      console.log(`Device ${i + 1}:`);
      console.log(`  Host:         ${device.host}`);
      if (device.httpPort) console.log(`  HTTP Port:    ${device.httpPort}`);
      if (device.httpsPort) console.log(`  HTTPS Port:   ${device.httpsPort}`);
      if (device.model) console.log(`  Model:        ${device.model}`);
      if (device.uid) console.log(`  UID:          ${device.uid}`);
      if (device.name) console.log(`  Name:         ${device.name}`);
      if (device.firmwareVersion) console.log(`  Firmware:     ${device.firmwareVersion}`);
      console.log(`  Method:       ${device.discoveryMethod}`);
      if (device.supportsHttps !== undefined) {
        console.log(`  HTTPS:        ${device.supportsHttps ? "Yes" : "No"}`);
      }
      console.log("");
    }

    // Test connectivity to discovered devices
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║              CONNECTIVITY VERIFICATION                     ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log("");

    for (const device of devices) {
      log(`Testing connectivity to ${device.host}...`);

      try {
        // Try to create a basic connection test
        const { ReolinkCgiApi } = await import("../../src/reolink/cgi/ReolinkCgiApi");
        const port = device.httpsPort ?? device.httpPort;
        if (!port) {
          log(`⚠️  ${device.host} has no HTTP/HTTPS port configured`);
          continue;
        }
        const cgiOptions: {
          host: string;
          port: number;
          useHttps: boolean;
          username: string;
          password: string;
          timeoutMs: number;
        } = {
          host: device.host,
          port,
          useHttps: device.supportsHttps ?? false,
          username: config.tcp.username,
          password: config.tcp.password || "",
          timeoutMs: 5000,
        };
        const cgi = new ReolinkCgiApi(cgiOptions);

        try {
          await cgi.getInfo();
          logSuccess(`✅ ${device.host} is accessible and responding`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("401") || errMsg.includes("Unauthorized")) {
            log(`⚠️  ${device.host} requires authentication (credentials may be incorrect)`);
          } else {
            log(`⚠️  ${device.host} is reachable but not responding correctly: ${errMsg}`);
          }
        }
      } catch (err) {
        logError(`Failed to connect to ${device.host}`, err);
      }
    }

    logSuccess("Discovery test completed successfully");

    // Compare with known devices from config
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║              COMPARISON WITH CONFIG                       ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log("");

    const knownHosts = [
      { name: "TCP Camera", host: config.tcp.host },
      { name: "UDP Camera", host: config.udp.host },
      { name: "NVR", host: config.nvr.host },
    ].filter((d) => d.host);

    for (const known of knownHosts) {
      const found = devices.find((d) => d.host === known.host);
      if (found) {
        logSuccess(`✅ ${known.name} (${known.host}) - FOUND`);
      } else {
        log(`⚠️  ${known.name} (${known.host}) - NOT FOUND in discovery results`);
        log(`   (May be on a different network, require auth, or be offline)`);
      }
    }

    console.log("\n");
    console.log("════════════════════════════════════════════════════════════");
    console.log("Discovery test complete!");
    console.log("════════════════════════════════════════════════════════════\n");
  } catch (error) {
    logError("Discovery test failed", error);
    process.exit(1);
  }
}

// Run the test
runDiscoveryTest().catch((error) => {
  logError("Unexpected error", error);
  process.exit(1);
});

