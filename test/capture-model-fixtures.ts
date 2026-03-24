/**
 * Capture per-model fixture data from all locally-configured cameras.
 *
 * Structure:
 *   test/fixtures/models/
 *     <ModelName>/channels/0/   — standalone cameras (one channel)
 *     <HubModelName>/           — Hub/NVR device-level info only
 *     <CamModelName>/channels/0/— each camera behind the Hub gets its OWN folder
 *
 * Run with:
 *   npx tsx test/capture-model-fixtures.ts              # single run
 *   npx tsx test/capture-model-fixtures.ts --runs 3     # 3 runs for confirmation
 *
 * NVR handling:
 *   1. Detects active channels (skips empty/sleeping ones)
 *   2. Dumps API fixtures per-channel WITHOUT stream combination test
 *   3. Runs stream combination test PER-CAMERA (only that camera's channels)
 *      - Single-lens cameras on NVR have 1 channel → 3 profiles → 3 pairs
 *      - Multifocal cameras on NVR have 2 channels → 6 profiles → 15 pairs
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

const runs = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx >= 0 ? parseInt(process.argv[idx + 1]!, 10) || 1 : 1;
})();

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

/** Derive a filesystem-safe folder name from device info. */
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

/** Detect which NVR channels have an active camera connected. */
async function detectActiveChannels(
  api: ReolinkBaichuanApi,
  numChannels: number,
  support: any,
): Promise<Array<{ channel: number; info: Record<string, unknown> }>> {
  const active: Array<{ channel: number; info: Record<string, unknown> }> = [];

  for (let ch = 0; ch < numChannels; ch++) {
    const item = support ? getSupportItemForChannel(support, ch) : undefined;
    if (!item) {
      console.log(`    ch${ch}: no support item — skipping`);
      continue;
    }

    try {
      const chInfo = (await api.getInfo(ch)) as Record<string, unknown>;
      if (!chInfo?.type) {
        console.log(`    ch${ch}: getInfo returned no type — skipping`);
        continue;
      }
      console.log(`    ch${ch}: ${chInfo.type} (fw: ${chInfo.firmwareVersion ?? "?"})`);
      active.push({ channel: ch, info: chInfo });
    } catch {
      console.log(`    ch${ch}: getInfo failed — not connected or sleeping`);
    }
  }

  return active;
}

async function captureStandalone(
  api: ReolinkBaichuanApi,
  hostDirName: string,
  run: number,
) {
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
}

async function captureNvr(
  api: ReolinkBaichuanApi,
  hostDirName: string,
  info: any,
  support: any,
  abilities: any,
  numChannels: number,
  run: number,
) {
  // Save Hub-level info
  const hubDir = path.join(MODELS_DIR, hostDirName);
  fs.mkdirSync(hubDir, { recursive: true });
  writeJson(path.join(hubDir, "device-info.json"), info);
  if (support) writeJson(path.join(hubDir, "support-info.json"), support);
  if (abilities) writeJson(path.join(hubDir, "ability-info.json"), abilities);
  console.log(`  Hub info saved to: ${hostDirName}/`);

  // Detect active channels
  console.log(`\n  Detecting active channels (${numChannels} total)...`);
  const activeChannels = await detectActiveChannels(api, numChannels, support);

  if (activeChannels.length === 0) {
    console.log(`  No active channels found — skipping NVR`);
    return;
  }

  console.log(`  Active channels: ${activeChannels.map((c) => `ch${c.channel}`).join(", ")}`);

  // Dump each active camera channel.
  // Skip stream combination test here — getDualLensChannelInfo(ch) on NVR returns
  // the NVR's total channelCount (e.g. 8), not the camera's own channels, which
  // generates hundreds of cross-camera pairs. Stream combo is tested separately below.
  for (const { channel, info: chInfo } of activeChannels) {
    const chDirName = modelDirName(chInfo) ?? `${hostDirName}_ch${channel}`;
    const outDir = path.join(MODELS_DIR, chDirName, "channels", "0");
    console.log(`\n  ch${channel} → ${chDirName}/channels/0/ (API dump, no stream combo)`);

    const result = await captureModelFixtures({
      api,
      channel,
      outDir,
      log: console.log,
      skipStreamCombinationTest: true,
    });

    // Write hub-context
    writeJson(path.join(MODELS_DIR, chDirName, "hub-context.json"), {
      hubModel: info?.type,
      hubItemNo: hostDirName,
      hubFirmware: info?.firmwareVersion,
      channelOnHub: channel,
      capturedAt: new Date().toISOString(),
      run,
    });

    console.log(
      `  ch${channel} result: ${result.summary.ok}/${result.summary.total} ok, ${result.summary.failed} failed`,
    );
  }

  // Per-camera stream combination test: only test main/sub/ext on each
  // camera's own NVR channel (3 pairs per single-lens camera).
  // Multifocal cameras have a second channel offset (channel+1) → tested as 6 profiles.
  console.log(`\n  Stream combination tests (per-camera on NVR)...`);
  for (const { channel, info: chInfo } of activeChannels) {
    const chDirName = modelDirName(chInfo) ?? `${hostDirName}_ch${channel}`;
    const outDir = path.join(MODELS_DIR, chDirName, "channels", "0");

    // Detect if this camera is multifocal (has a second channel on the NVR)
    let dualLensInfo: any;
    try {
      dualLensInfo = await api.getDualLensChannelInfo(channel, { onNvr: true });
    } catch { /* ignore */ }
    const isMultifocal = dualLensInfo?.isDualLens === true;

    // Build channels to test: just this camera's channel(s)
    const cameraChannels = isMultifocal ? [channel, channel + 1] : [channel];
    const profiles: Array<"main" | "sub" | "ext"> = ["main", "sub", "ext"];

    type StreamId = { ch: number; profile: string; label: string };
    const streams: StreamId[] = [];
    for (const ch of cameraChannels) {
      for (const p of profiles) {
        const label = cameraChannels.length > 1 ? `ch${ch}_${p}` : p;
        streams.push({ ch, profile: p, label });
      }
    }

    // Generate all unique pairs within this camera
    const pairs: Array<[StreamId, StreamId]> = [];
    for (let i = 0; i < streams.length; i++) {
      for (let j = i + 1; j < streams.length; j++) {
        pairs.push([streams[i]!, streams[j]!]);
      }
    }

    console.log(
      `\n  ch${channel} (${chInfo.type}): ${pairs.length} stream pair(s)` +
        (isMultifocal ? ` (multifocal, channels ${cameraChannels.join(",")})` : ""),
    );

    const TEST_DURATION_MS = 4000;
    const results: Array<{ pair: string; ok: boolean; framesA: number; framesB: number }> = [];

    for (const [a, b] of pairs) {
      console.log(`    testing ${a.label}+${b.label}...`);
      let session: { client: any; release: () => Promise<void> } | undefined;
      try {
        session = await api.createDedicatedSession(`test:combo:${a.label}_${b.label}`);
      } catch (e) {
        console.log(`      session error: ${e instanceof Error ? e.message : String(e)}`);
        results.push({ pair: `${a.label}+${b.label}`, ok: false, framesA: 0, framesB: 0 });
        continue;
      }

      const testClient = session.client;
      let framesA = 0;
      let framesB = 0;

      const stTypes: Record<string, Set<number>> = {
        main: new Set([0, 2]), sub: new Set([1, 3]), ext: new Set([0, 2]),
      };
      const setA = stTypes[a.profile]!;
      const setB = stTypes[b.profile]!;

      const onFrame = (frame: any) => {
        if (frame.header?.cmdId !== 3) return; // BC_CMD_ID_VIDEO
        const st = frame.header.streamType;
        if (setA.has(st)) framesA++;
        else if (setB.has(st)) framesB++;
      };
      testClient.on("frame", onFrame);

      try {
        await (api as any).startVideoStream(a.ch, a.profile, { client: testClient });
        await (api as any).startVideoStream(b.ch, b.profile, { client: testClient });
        await new Promise((r) => setTimeout(r, TEST_DURATION_MS));
        await (api as any).stopVideoStream(a.ch, a.profile, { client: testClient }).catch(() => {});
        await (api as any).stopVideoStream(b.ch, b.profile, { client: testClient }).catch(() => {});
      } catch { /* ignore */ } finally {
        testClient.removeListener("frame", onFrame);
        await session.release().catch(() => {});
      }

      const ok = framesA > 0 && framesB > 0;
      results.push({ pair: `${a.label}+${b.label}`, ok, framesA, framesB });
      console.log(`      ${ok ? "OK" : "FAIL"} A=${framesA} B=${framesB}`);
    }

    writeJson(path.join(outDir, "stream-combination-test.json"), {
      isMultifocal,
      cameraChannels,
      results,
    });
  }
}

async function captureCamera(config: CameraConfig, run: number) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Camera: ${config.name} (${config.host}) — run ${run}/${runs}`);
  console.log("=".repeat(60));

  const api = new ReolinkBaichuanApi({
    host: config.host,
    port: 9000,
    username: config.username,
    password: config.password,
  });

  try {
    await api.login();

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
      await captureStandalone(api, hostDirName, run);
    } else {
      await captureNvr(api, hostDirName, info, support, abilities, numChannels, run);
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
  console.log(`Runs: ${runs}`);
  console.log(`Saving fixtures to: test/fixtures/models/\n`);

  for (let run = 1; run <= runs; run++) {
    if (runs > 1) {
      console.log(`\n${"#".repeat(60)}`);
      console.log(`# RUN ${run}/${runs}`);
      console.log(`${"#".repeat(60)}`);
    }

    for (const cam of cameras) {
      await captureCamera(cam, run);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("Done. Review fixtures in test/fixtures/models/");
}

main().catch(console.error);
