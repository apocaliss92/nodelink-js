#!/usr/bin/env node
/**
 * Compare two TCP cameras (TCP vs TCP265) for floodlight support.
 *
 * Uses credentials from `.env` via `test/env.ts`:
 * - TCP_HOST/TCP_USERNAME/TCP_PASSWORD
 * - TCP265_HOST/TCP265_USERNAME/TCP265_PASSWORD
 *
 * Optional:
 * - FLOODLIGHT_TOGGLE=1 to attempt a brief on/off cycle (will change camera state).
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

type CompareCamera = {
  name: string;
  host: string;
  username: string;
  password: string;
};

function section(title: string) {
  console.log(`\n${"=".repeat(80)}\n${title}\n${"=".repeat(80)}`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pickSupportFields(support: any, channel = 0) {
  const candidates = (support?.items ?? []).filter(
    (i: any) => i?.chnID === channel || i?.chnID === channel + 1,
  );

  // Mirror the library heuristic: pick the most capability-ish item.
  const score = (item: any) => {
    let s = 0;
    if (item?.name == null) s += 2;
    for (const k of [
      "ptzType",
      "ptzControl",
      "ptzPreset",
      "ledCtrl",
      "lightType",
      "battery",
      "audioVersion",
      "motion",
      "encCtrl",
      "newIspCfg",
      "remoteAbility",
    ]) {
      if (item?.[k] !== undefined) s += 3;
    }
    s += Math.min(10, Math.max(0, Object.keys(item ?? {}).length - 1));
    return s;
  };

  const item = candidates.slice().sort((a: any, b: any) => score(b) - score(a))[0];

  return {
    channel,
    ptzMode: support?.ptzMode,
    topLevel: {
      channelNum: support?.channelNum,
      audioNum: support?.audioNum,
      rtsp: support?.rtsp,
      onvif: support?.onvif,
      wifi: support?.wifi,
      pushAlarm: support?.pushAlarm,
    },
    itemsForChannel: candidates.map((c: any) => ({
      chnID: c?.chnID,
      name: c?.name,
      ver: c?.ver,
      ledCtrl: c?.ledCtrl,
      lightType: c?.lightType,
      ptzType: c?.ptzType,
      ptzControl: c?.ptzControl,
      ptzPreset: c?.ptzPreset,
      battery: c?.battery,
      audioVersion: c?.audioVersion,
      keys: Object.keys(c ?? {}).sort(),
    })),
    item: item
      ? {
          chnID: item.chnID,
          name: (item as any).name,
          ledCtrl: item.ledCtrl,
          lightType: item.lightType,
          battery: item.battery,
          audioVersion: item.audioVersion,
          ptzType: item.ptzType,
          ptzPreset: item.ptzPreset,
          ptzControl: item.ptzControl,
          noAudio: item.noAudio,
        }
      : undefined,
  };
}

function flattenAbilitiesForChannel(abilities: any, channel = 0): Record<string, unknown> {
  const ch0 = abilities?.[channel] ?? undefined;
  const ch1 = abilities?.[channel + 1] ?? undefined;
  const host = abilities?.Host ?? undefined;
  return {
    ...(host && typeof host === "object" ? host : {}),
    ...(ch0 && typeof ch0 === "object" ? ch0 : {}),
    ...(ch1 && typeof ch1 === "object" ? ch1 : {}),
  };
}

function filterAbilityKeys(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const re = /(white|flood|light|led)/i;
  for (const [k, v] of Object.entries(flat)) {
    if (!re.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>) {
  const aKeys = new Set(Object.keys(a));
  const bKeys = new Set(Object.keys(b));
  const onlyA = [...aKeys].filter((k) => !bKeys.has(k)).sort();
  const onlyB = [...bKeys].filter((k) => !aKeys.has(k)).sort();
  const both = [...aKeys].filter((k) => bKeys.has(k)).sort();
  return { onlyA, onlyB, both };
}

function summarizeXml(xml: string) {
  const firstTag = xml.match(/<body>\s*<([A-Za-z0-9_:-]+)/i)?.[1];
  const hasFloodlightTag = /<Floodlight(Task|Manual|StatusList)\b/i.test(xml);
  const hasWhiteLedTag = /<WhiteLed\b/i.test(xml);
  const enable = xml.match(/<enable>([^<]+)<\/enable>/i)?.[1];
  const state = xml.match(/<state>([^<]+)<\/state>/i)?.[1];
  const status = xml.match(/<status>([^<]+)<\/status>/i)?.[1];
  const brightness = xml.match(/<brightness_cur>([^<]+)<\/brightness_cur>/i)?.[1];

  return {
    firstTag,
    hasFloodlightTag,
    hasWhiteLedTag,
    enable,
    state,
    status,
    brightness,
    xmlLength: xml.length,
  };
}

async function inspectCamera(cam: CompareCamera, channel = 0) {
  section(`CAMERA: ${cam.name} (${cam.host})`);

  const api = new ReolinkBaichuanApi({
    host: cam.host,
    username: cam.username,
    password: cam.password,
    channel,
  });

  const toggle = process.env.FLOODLIGHT_TOGGLE === "1";

  try {
    console.log("[INFO] login...");
    await api.login();
    console.log("[OK] login ok");

    console.log("\n[INFO] getDeviceCapabilities...");
    const { capabilities, abilities, support } = await api.getDeviceCapabilities(channel);
    console.log("[OK] capabilities computed:");
    console.log(safeJson(capabilities));

    console.log("\n[INFO] Support summary:");
    console.log(safeJson(pickSupportFields(support, channel)));

    console.log("\n[INFO] Abilities (light/led-related keys only):");
    const flat = flattenAbilitiesForChannel(abilities, channel);
    console.log(safeJson(filterAbilityKeys(flat)));

    console.log("\n[INFO] Raw GetWhiteLed (cmd 289) XML summary:");
    try {
      const xml = await api.sendXml({ cmdId: 289, channel });
      console.log(safeJson(summarizeXml(xml)));
    } catch (e) {
      console.log("[WARN] cmd 289 failed:");
      console.log(safeJson(e));
    }

    console.log("\n[INFO] getWhiteLedState():");
    try {
      const wl = await api.getWhiteLedState(channel);
      console.log(safeJson(wl));
    } catch (e) {
      console.log("[WARN] getWhiteLedState failed:");
      console.log(safeJson(e));
    }

    if (toggle) {
      console.log("\n[WARN] FLOODLIGHT_TOGGLE=1 => will toggle floodlight ON then OFF");
      try {
        await api.setWhiteLedState(channel, true);
        await new Promise((r) => setTimeout(r, 1200));
        const wlOn = await api.getWhiteLedState(channel).catch(() => undefined);
        console.log("[OK] after turnOn:");
        console.log(safeJson(wlOn));
      } catch (e) {
        console.log("[WARN] turnOn failed:");
        console.log(safeJson(e));
      }

      try {
        await api.setWhiteLedState(channel, false);
        await new Promise((r) => setTimeout(r, 1200));
        const wlOff = await api.getWhiteLedState(channel).catch(() => undefined);
        console.log("[OK] after turnOff:");
        console.log(safeJson(wlOff));
      } catch (e) {
        console.log("[WARN] turnOff failed:");
        console.log(safeJson(e));
      }
    }

    return { capabilities, abilitiesFlat: filterAbilityKeys(flat), support: pickSupportFields(support, channel) };
  } finally {
    try {
      await api.close();
    } catch {
      // ignore
    }
  }
}

async function main() {
  const tcp: CompareCamera = {
    name: "TCP",
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
  };
  const tcp265: CompareCamera = {
    name: "TCP265",
    host: config.tcp265.host,
    username: config.tcp265.username,
    password: config.tcp265.password,
  };

  if (!tcp.host || !tcp.username || !tcp.password) {
    console.error("Error: TCP_HOST/TCP_USERNAME/TCP_PASSWORD must be set in environment or .env file");
    process.exit(1);
  }
  if (!tcp265.host || !tcp265.username || !tcp265.password) {
    console.error("Error: TCP265_HOST/TCP265_USERNAME/TCP265_PASSWORD must be set in environment or .env file");
    process.exit(1);
  }

  const channel = Number(process.env.CHANNEL ?? "0");

  const a = await inspectCamera(tcp, channel);
  const b = await inspectCamera(tcp265, channel);

  section("DIFF SUMMARY (light/led-related AbilityInfo keys)");
  const d = diffKeys(a.abilitiesFlat, b.abilitiesFlat);
  console.log(
    safeJson({
      onlyTCP: d.onlyA,
      onlyTCP265: d.onlyB,
      shared: d.both,
    }),
  );

  section("DIFF SUMMARY (capabilities + support highlights)");
  console.log(
    safeJson({
      TCP: { capabilities: a.capabilities, support: a.support },
      TCP265: { capabilities: b.capabilities, support: b.support },
    }),
  );
}

main().catch((e) => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
