#!/usr/bin/env node
/**
 * NVR/HUB Diagnostics Test
 * Comprehensive diagnostics for NVR/HUB devices - collects and prints all available information.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkCgiApi } from "../../index.js";
import { config } from "../env.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function safeNow(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

async function main(): Promise<void> {
  const { host, username, password } = config.nvr;
  if (!host) throw new Error("Missing NVR_HOST in .env");
  if (!username) throw new Error("Missing NVR_USERNAME in .env");
  if (!password) throw new Error("Missing NVR_PASSWORD in .env");

  const cgi = new ReolinkCgiApi({
    host,
    username,
    password,
    timeoutMs: 30_000,
  });

  try {
    await cgi.login();
    console.log("✓ Logged in to NVR/HUB");

    // Collect comprehensive diagnostics using the client method
    const diagnostics = await cgi.collectNvrDiagnostics({
      logger: {
        log: (msg: string, data?: unknown) => {
          console.log(msg);
          if (data !== undefined) {
            console.log(JSON.stringify(data, null, 2));
          }
        },
      },
    });

    // Print human-readable report using the client method
    cgi.printNvrDiagnostics(diagnostics, {
      log: (msg: string, data?: unknown) => {
        console.log(msg);
        if (data !== undefined) {
          console.log(JSON.stringify(data, null, 2));
        }
      },
    });

    // Save full diagnostics to file
    const dir = join(process.cwd(), "test", "diagnostics-dumps");
    mkdirSync(dir, { recursive: true });
    const outPath = join(dir, `nvr_diagnostics_${safeNow()}.json`);
    writeFileSync(outPath, JSON.stringify(diagnostics, null, 2), "utf8");
    console.log(`\n✓ Full diagnostics saved to: ${outPath}`);
  } catch (error) {
    console.error("Error:", error);
    throw error;
  } finally {
    await cgi.logout();
    console.log("✓ Logged out");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

