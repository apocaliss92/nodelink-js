/**
 * Capture per-model fixture data from all locally-configured cameras.
 *
 * Structure:
 *   test/fixtures/models/
 *     <ItemNo>/channels/0/   — standalone cameras (one channel)
 *     <HubItemNo>/           — Hub/NVR device-level info only
 *     <CamItemNo>/channels/0/— each camera behind the Hub gets its OWN folder
 *
 * Run with: npx tsx test/capture-model-fixtures.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { ReolinkBaichuanApi } from "../src/reolink/baichuan/ReolinkBaichuanApi";
import { captureModelFixtures } from "../src/debug/DiagnosticsTools";
import { getSupportItemForChannel } from "../src/reolink/baichuan/capabilities";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, "fixtures", "models");

interface CameraConfig {
  name: string;
  host: string;
  username: string;
  password: string;
}

function getCameras(): CameraConfig[] {
  const cameras: CameraConfig[] = [];

  if (process.env.TCP_HOST) {
    cameras.push({
      name: "TCP",
      host: process.env.TCP_HOST,
      username: process.env.TCP_USERNAME ?? "admin",
      password: process.env.TCP_PASSWORD ?? "",
    });
  }
  if (process.env.TCP265_HOST) {
    cameras.push({
      name: "TCP265",
      host: process.env.TCP265_HOST,
      username: process.env.TCP265_USERNAME ?? "admin",
      password: process.env.TCP265_PASSWORD ?? "",
    });
  }
  if (process.env.NVR_HOST) {
    cameras.push({
      name: "NVR",
      host: process.env.NVR_HOST,
      username: process.env.NVR_USERNAME ?? "admin",
      password: process.env.NVR_PASSWORD ?? "",
    });
  }
  if (process.env.HUB_HOST) {
    cameras.push({
      name: "HUB",
      host: process.env.HUB_HOST,
      username: process.env.HUB_USERNAME ?? "admin",
      password: process.env.HUB_PASSWORD ?? "",
    });
  }

  return cameras;
}

/** Derive a filesystem-safe folder name from device info, preferring the
 *  human-readable `type` ("E1 Zoom") over the terse `itemNo` ("E340"). */
function modelDirName(info: Record<string, unknown> | undefined): string | undefined {
  const type = info?.type as string | undefined;
  if (type) return type.replace(/[/\\:*?"<>|]+/g, "_").replace(/\s+/g, "_");
  const itemNo = info?.itemNo as string | undefined;
  if (itemNo) return itemNo;
  return undefined;
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

async function captureCamera(config: CameraConfig) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Camera: ${config.name} (${config.host})`);
  console.log("=".repeat(60));

  const api = new ReolinkBaichuanApi({
    host: config.host,
    port: 9000,
    username: config.username,
    password: config.password,
  });

  try {
    await api.login();

    // Device info (host-level)
    const info = await api.getInfo();
    const hostDirName =
      modelDirName(info as any) ?? config.host.replace(/\./g, "_");

    console.log(`  Model: ${info?.type ?? "unknown"} → ${hostDirName}/`);
    console.log(`  FW:    ${info?.firmwareVersion ?? "unknown"}`);

    const support = await api.getSupportInfo();
    const abilities = await api.getAbilityInfo();
    const supportChannelNum = (support as any)?.channelNum as number | undefined;
    const numChannels = supportChannelNum ?? 1;
    const isNvr = await api.isNvrDevice();

    console.log(`  Channels: ${numChannels}, isNvr: ${isNvr}`);

    if (!isNvr) {
      // ── Standalone camera ─────────────────────────────────────────────
      const outDir = path.join(MODELS_DIR, hostDirName, "channels", "0");
      console.log(`\n  Saving to: ${hostDirName}/channels/0/`);

      const result = await captureModelFixtures({
        api,
        channel: 0,
        outDir,
        log: console.log,
      });
      console.log(
        `  Result: ${result.summary.ok}/${result.summary.total} ok, ${result.summary.failed} failed`,
      );
    } else {
      // ── NVR/Hub ───────────────────────────────────────────────────────
      // Save Hub-level info only
      const hubDir = path.join(MODELS_DIR, hostDirName);
      fs.mkdirSync(hubDir, { recursive: true });
      writeJson(path.join(hubDir, "device-info.json"), info);
      if (support) writeJson(path.join(hubDir, "support-info.json"), support);
      if (abilities) writeJson(path.join(hubDir, "ability-info.json"), abilities);
      console.log(`  Hub info saved to: ${hostDirName}/`);

      // Each connected camera → its own model folder
      for (let ch = 0; ch < numChannels; ch++) {
        const item = support ? getSupportItemForChannel(support, ch) : undefined;
        if (!item) continue; // skip channels without support item

        // Try to get per-channel device info for model identification
        let chInfo: Record<string, unknown> | undefined;
        try {
          chInfo = (await api.getInfo(ch)) as Record<string, unknown>;
        } catch {
          // Channel not connected / sleeping — skip
          console.log(`  ch${ch}: skipped (getInfo failed — not connected or sleeping)`);
          continue;
        }

        const chDirName =
          modelDirName(chInfo) ?? `${hostDirName}_ch${ch}`;

        // Use channels/0 since each model folder represents one camera
        // Add _summary note about which Hub channel this was captured from
        const outDir = path.join(MODELS_DIR, chDirName, "channels", "0");
        console.log(`\n  ch${ch} → ${chDirName}/channels/0/`);

        const result = await captureModelFixtures({
          api,
          channel: ch,
          outDir,
          log: console.log,
        });

        // Write a hub-context file so we know where this fixture came from
        writeJson(path.join(MODELS_DIR, chDirName, "hub-context.json"), {
          hubModel: info?.type,
          hubItemNo: hostDirName,
          hubFirmware: info?.firmwareVersion,
          hubHost: config.host,
          channelOnHub: ch,
          capturedAt: new Date().toISOString(),
        });

        console.log(
          `  ch${ch} result: ${result.summary.ok}/${result.summary.total} ok, ${result.summary.failed} failed`,
        );
      }
    }

    try {
      await api.close();
    } catch {
      /* ignore */
    }
  } catch (e) {
    console.log(
      `  ERROR: ${e instanceof Error ? e.message : String(e)}`,
    );
    try {
      await api.close();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const cameras = getCameras();
  console.log(`Found ${cameras.length} camera(s) in .env`);
  console.log(`Saving fixtures to: test/fixtures/models/\n`);

  for (const cam of cameras) {
    await captureCamera(cam);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("Done. Review fixtures in test/fixtures/models/");
}

main().catch(console.error);
