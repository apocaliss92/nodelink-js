#!/usr/bin/env node
/**
 * Test per AutodiscoveryClient - discovery continuato per 2 minuti
 * 
 * Questo test:
 * 1. Avvia l'AutodiscoveryClient
 * 2. Monitora per 2 minuti
 * 3. Logga ogni nuovo dispositivo scoperto con dettagli (host, type, model, etc.)
 */

// @ts-expect-error - Path resolution at runtime
import { AutodiscoveryClient, type DiscoveredDevice } from "../../index.js";
import { config } from "../env.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fmtNow(): string {
  return new Date().toISOString();
}

function log(message: string, data?: unknown) {
  console.log(`[${fmtNow()}] ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function logSection(title: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

async function main(): Promise<void> {
  logSection("AUTODISCOVERY CLIENT TEST (UDP ONLY)");
  console.log(`Configuration:`);
  console.log(`  Discovery method: UDP broadcast only (no HTTP scanning)`);
  console.log(`  Test duration: 2 minutes`);
  console.log(`  Scan interval: 30 seconds`);

  // Create the client - UDP discovery only (no HTTP scanning)
  logSection("Creating AutodiscoveryClient (UDP only)");
  const client = new AutodiscoveryClient({
    discoveryMethod: "udp", // UDP broadcast only
    scanIntervalMs: 30_000, // 30 seconds between scans
    autoStart: false, // Start manually
    logger: {
      log: (msg: string) => {
        // Log all messages - new devices will be logged immediately by the client
        console.log(`[Discovery] ${msg}`);
      },
      warn: (msg: string) => console.warn(`[Discovery] ${msg}`),
      error: (msg: string) => console.error(`[Discovery] ${msg}`),
      debug: () => {}, // Ignore debug
    },
  });

  // Start the client
  logSection("Starting Discovery");
  log(`Starting AutodiscoveryClient...`);
  client.start();
  log(`✓ Discovery started (interval: 30 seconds)`);
  log(`⚠️  First scan will start immediately`);
  log(`⚠️  Monitoring for 2 minutes...\n`);

  // Monitor for 2 minutes (120 seconds)
  const testDuration = 120_000; // 2 minutes
  const statusInterval = 30_000; // Status update every 30 seconds
  const startTime = Date.now();

  while (Date.now() - startTime < testDuration) {
    await sleep(statusInterval);
    
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const remaining = Math.floor((testDuration - (Date.now() - startTime)) / 1000);
    const currentCount = client.getDiscoveredDevices().length;
    
    log(`[${elapsed}s / ${Math.floor(testDuration / 1000)}s] Discovery active - Devices found: ${currentCount} (remaining: ${remaining}s)`);
  }

  // Stop the client
  logSection("Stopping Discovery");
  log(`Stopping AutodiscoveryClient...`);
  client.stop();
  log(`✓ Discovery stopped`);

  // Final report
  logSection("Final Report");
  const finalDevices = client.getDiscoveredDevices();
  log(`\nTotal devices discovered: ${finalDevices.length}`);
  
  if (finalDevices.length > 0) {
    log(`\nComplete device list:`);
    finalDevices.forEach((device: DiscoveredDevice, index: number) => {
      console.log(`\n[${index + 1}] ${device.host}`);
      if (device.model) console.log(`    Model: ${device.model}`);
      if (device.name) console.log(`    Name: ${device.name}`);
      if (device.uid) console.log(`    UID: ${device.uid}`);
      if (device.firmwareVersion) console.log(`    Firmware: ${device.firmwareVersion}`);
      if (device.httpPort) console.log(`    HTTP Port: ${device.httpPort}`);
      if (device.httpsPort) console.log(`    HTTPS Port: ${device.httpsPort}`);
      console.log(`    Discovery Method: ${device.discoveryMethod}`);
    });
  } else {
    log(`\n⚠️  No devices discovered during test`);
    log(`  Possible causes:`);
    log(`  - No Reolink cameras on the network`);
    log(`  - Incorrect credentials`);
    log(`  - Network unreachable`);
    log(`  - Firewall blocking connections`);
  }

  log(`\nTest completed`);
}

main().catch((e) => {
  console.error("\n[FATAL]", e);
  process.exit(1);
});

