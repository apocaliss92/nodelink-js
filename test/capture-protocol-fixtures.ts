/**
 * Capture protocol-level XML request/response pairs from a real camera.
 * Run with: npx tsx test/capture-protocol-fixtures.ts
 *
 * Hooks into the BaichuanClient to intercept TX/RX XML payloads.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ReolinkBaichuanApi } from "../src/reolink/baichuan/ReolinkBaichuanApi";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures", "protocol");

const CAMERA_HOST = "192.168.1.170";
const CAMERA_PORT = 9000;
const CAMERA_USER = "admin";
const CAMERA_PASS = "Ruocco123";

interface CapturedExchange {
  command: string;
  cmdId: number;
  request?: string;
  response?: string;
  responseCode?: number;
}

async function main() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  const exchanges: CapturedExchange[] = [];

  const api = new ReolinkBaichuanApi({
    host: CAMERA_HOST,
    port: CAMERA_PORT,
    username: CAMERA_USER,
    password: CAMERA_PASS,
    debugOptions: { general: true },
  });

  console.log("Logging in...");
  await api.login();
  console.log("Logged in.\n");

  // Helper to capture a command
  async function capture<T>(name: string, fn: () => Promise<T>): Promise<T> {
    console.log(`Capturing: ${name}...`);
    try {
      const result = await fn();
      console.log(`  OK`);
      return result;
    } catch (e) {
      console.log(`  FAILED: ${e}`);
      throw e;
    }
  }

  // Device info commands
  const info = await capture("getInfo", () => api.getInfo());
  fs.writeFileSync(path.join(FIXTURES_DIR, "getInfo-response.json"), JSON.stringify(info, null, 2));

  const channels = await capture("getChannelCount", () => api.getChannelCount());
  fs.writeFileSync(path.join(FIXTURES_DIR, "getChannelCount-response.json"), JSON.stringify({ channelCount: channels }));

  const channelInfo = await capture("getChannelInfo", () => api.getChannelInfo(0));
  fs.writeFileSync(path.join(FIXTURES_DIR, "getChannelInfo-response.json"), JSON.stringify(channelInfo, null, 2));

  // Stream metadata
  const streamMeta = await capture("getStreamMetadata", () => api.getStreamMetadata(0));
  fs.writeFileSync(path.join(FIXTURES_DIR, "getStreamMetadata-response.json"), JSON.stringify(streamMeta, null, 2));

  const streamOpts = await capture("buildVideoStreamOptions", () => api.buildVideoStreamOptions({ channel: 0 }));
  fs.writeFileSync(path.join(FIXTURES_DIR, "buildVideoStreamOptions-response.json"), JSON.stringify(streamOpts, null, 2));

  // Stream info list
  const streamInfoList = await capture("getStreamInfoList", () => api.getStreamInfoList(0));
  fs.writeFileSync(path.join(FIXTURES_DIR, "getStreamInfoList-response.json"), JSON.stringify(streamInfoList, null, 2));

  // Network
  try {
    const netInfo = await capture("getNetworkInfo", () => api.getNetworkInfo());
    fs.writeFileSync(path.join(FIXTURES_DIR, "getNetworkInfo-response.json"), JSON.stringify(netInfo, null, 2));
  } catch { /* some cameras don't support */ }

  try {
    const ports = await capture("getPorts", () => api.getPorts());
    fs.writeFileSync(path.join(FIXTURES_DIR, "getPorts-response.json"), JSON.stringify(ports, null, 2));
  } catch { /* skip */ }

  // OSD
  try {
    const osd = await capture("getOsd", () => api.getOsd(0));
    fs.writeFileSync(path.join(FIXTURES_DIR, "getOsd-response.json"), JSON.stringify(osd, null, 2));
  } catch { /* skip */ }

  // Motion/AI
  try {
    const motion = await capture("getMotionAlarm", () => api.getMotionAlarm(0));
    fs.writeFileSync(path.join(FIXTURES_DIR, "getMotionAlarm-response.json"), JSON.stringify(motion, null, 2));
  } catch { /* skip */ }

  try {
    const aiState = await capture("getAiState", () => api.getAiState(0));
    fs.writeFileSync(path.join(FIXTURES_DIR, "getAiState-response.json"), JSON.stringify(aiState, null, 2));
  } catch { /* skip */ }

  // White LED
  try {
    const led = await capture("getWhiteLedState", () => api.getWhiteLedState(0));
    fs.writeFileSync(path.join(FIXTURES_DIR, "getWhiteLedState-response.json"), JSON.stringify(led, null, 2));
  } catch { /* skip */ }

  // PTZ
  try {
    const presets = await capture("getPtzPresets", () => api.getPtzPresets(0));
    fs.writeFileSync(path.join(FIXTURES_DIR, "getPtzPresets-response.json"), JSON.stringify(presets, null, 2));
  } catch { /* skip */ }

  try {
    const ptzPos = await capture("getPtzPosition", () => api.getPtzPosition(0));
    fs.writeFileSync(path.join(FIXTURES_DIR, "getPtzPosition-response.json"), JSON.stringify(ptzPos, null, 2));
  } catch { /* skip */ }

  // Encoding
  try {
    const enc = await capture("getEncXml", () => api.getEncXml(0));
    fs.writeFileSync(path.join(FIXTURES_DIR, "getEncXml-response.json"), JSON.stringify(enc, null, 2));
  } catch { /* skip */ }

  // Record config
  try {
    const recCfg = await capture("getRecordCfg", () => api.getRecordCfg(0));
    fs.writeFileSync(path.join(FIXTURES_DIR, "getRecordCfg-response.json"), JSON.stringify(recCfg, null, 2));
  } catch { /* skip */ }

  // Audio config
  try {
    const audio = await capture("getTwoWayAudioConfig", () => api.getTwoWayAudioConfig());
    fs.writeFileSync(path.join(FIXTURES_DIR, "getTwoWayAudioConfig-response.json"), JSON.stringify(audio, null, 2));
  } catch { /* skip */ }

  // WiFi
  try {
    const wifi = await capture("getWifiSignal", () => api.getWifiSignal(0));
    fs.writeFileSync(path.join(FIXTURES_DIR, "getWifiSignal-response.json"), JSON.stringify(wifi, null, 2));
  } catch { /* skip */ }

  // HDD info
  try {
    const hdd = await capture("getHddInfoList", () => api.getHddInfoList());
    fs.writeFileSync(path.join(FIXTURES_DIR, "getHddInfoList-response.json"), JSON.stringify(hdd, null, 2));
  } catch { /* skip */ }

  // System general
  try {
    const sysGen = await capture("getSystemGeneral", () => api.getSystemGeneral());
    fs.writeFileSync(path.join(FIXTURES_DIR, "getSystemGeneral-response.json"), JSON.stringify(sysGen, null, 2));
  } catch { /* skip */ }

  // Ability/Support info (for capabilities)
  try {
    const support = await capture("getSupportInfo", () => api.getSupportInfo());
    fs.writeFileSync(path.join(FIXTURES_DIR, "getSupportInfo-response.json"), JSON.stringify(support, null, 2));
  } catch { /* skip */ }

  try {
    const ability = await capture("getAbilityInfo", () => api.getAbilityInfo());
    fs.writeFileSync(path.join(FIXTURES_DIR, "getAbilityInfo-response.json"), JSON.stringify(ability, null, 2));
  } catch { /* skip */ }

  // Ping
  await capture("ping", () => api.ping());

  await api.close();

  console.log(`\nDone! ${fs.readdirSync(FIXTURES_DIR).length} protocol fixtures saved.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
