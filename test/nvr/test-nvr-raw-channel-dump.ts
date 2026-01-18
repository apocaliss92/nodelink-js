#!/usr/bin/env node
/**
 * NVR raw channel dump
 *
 * Purpose:
 * - Connect to NVR_HOST via Baichuan TCP
 * - Fetch and print "raw-ish" data returned by the hub for multiple channels
 *
 * Output strategy:
 * - Print short previews of large XML payloads (full output optional via env)
 * - Print per-channel summaries (DevInfo tags + WhiteLed cmd289 probe on ch and ch+1)
 *
 * Required env (loaded from .env by test/env.ts):
 * - NVR_HOST
 * - NVR_USERNAME
 * - NVR_PASSWORD
 *
 * Optional env:
 * - NVR_MAX_CHANNELS=16
 * - NVR_CHANNELS=0,1,2   (explicit list overrides autodetect)
 * - NVR_TIMEOUT_MS=3500
 * - NVR_XML_PREVIEW_CHARS=1800
 * - NVR_XML_FULL=1       (prints full XML payloads; can be very large)
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, buildAbilityInfoExtensionXml, getXmlText, parseSupportXml } from "../../index.js";
import { config } from "../env.js";

function getXmlTexts(xml: string, tags: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of tags) {
    const v = getXmlText(xml, tag);
    if (typeof v === "string") out[tag] = v;
  }
  return out;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function previewXml(xml: string, maxChars: number, full: boolean): string {
  if (full) return xml;
  if (xml.length <= maxChars) return xml;
  return `${xml.slice(0, Math.max(0, maxChars))}\n... (truncated, len=${xml.length})`;
}

function parseChannelsList(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .filter((n, idx, arr) => arr.indexOf(n) === idx)
    .sort((a, b) => a - b);
}

async function main(): Promise<void> {
  const host = process.env.NVR_HOST || config.nvr.host;
  const username = process.env.NVR_USERNAME || config.nvr.username;
  const password = process.env.NVR_PASSWORD || config.nvr.password;

  if (!host) throw new Error("Missing NVR_HOST");
  if (!username) throw new Error("Missing NVR_USERNAME");
  if (!password) throw new Error("Missing NVR_PASSWORD");

  const timeoutMs = envNum("NVR_TIMEOUT_MS", 3500);
    const whiteLedTimeoutMs = envNum("NVR_WHITELED_TIMEOUT_MS", 1200);
  const maxChannels = envNum("NVR_MAX_CHANNELS", 16);
  const previewChars = envNum("NVR_XML_PREVIEW_CHARS", 1800);
  const fullXml = envBool("NVR_XML_FULL");
    const skipWhiteLed = envBool("NVR_SKIP_WHITELED");

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    uid: config.nvr.uid || undefined,
    transport: "tcp",
    logger: console,
    debugOptions: {
      // keep it quiet: this test prints its own summaries
      general: false,
      debugRtsp: false,
      traceNativeStream: false,
    },
  });

  try {
    console.log("================================================================================");
    console.log("NVR raw channel dump");
    console.log(JSON.stringify({ host, username, timeoutMs, whiteLedTimeoutMs, skipWhiteLed, maxChannels, previewChars, fullXml }, null, 2));

    await api.login();

    // Host DevInfo (cmd 80) raw
    console.log("\n=== Host DevInfo (cmd 80) raw XML ===");
    const hostDevInfoXml = await api.sendXml({ cmdId: 80, timeoutMs });
    console.log(previewXml(hostDevInfoXml, previewChars, fullXml));

    // AbilityInfo (cmd 151) raw
    console.log("\n=== AbilityInfo (cmd 151) raw XML ===");
    const abilityXml = await api.sendXml({
      cmdId: 151,
      timeoutMs,
      extensionXml: buildAbilityInfoExtensionXml(username),
    });
    console.log(previewXml(abilityXml, previewChars, fullXml));

    // Support (cmd 199) raw
    console.log("\n=== Support (cmd 199) raw XML ===");
    const supportXml = await api.sendXml({ cmdId: 199, timeoutMs });
    console.log(previewXml(supportXml, previewChars, fullXml));

    const supportParsed = parseSupportXml(supportXml);
    console.log("\n--- Support parsed (summary) ---");
    console.log(
      JSON.stringify(
        {
          channelNum: (supportParsed as any)?.channelNum,
          ptzMode: (supportParsed as any)?.ptzMode,
          itemsCount: (supportParsed?.items ?? []).length,
          exampleItems: (supportParsed?.items ?? []).slice(0, 5),
        },
        null,
        2,
      ),
    );

    const channelsFromEnv = parseChannelsList(process.env.NVR_CHANNELS);

    const channels = (() => {
      if (channelsFromEnv.length) return channelsFromEnv;

      // Prefer explicit channelNum from support (when available).
      const chn = Number((supportParsed as any)?.channelNum);
      if (Number.isFinite(chn) && chn > 0 && chn <= 128) {
        return Array.from({ length: chn }, (_, i) => i);
      }

      // Fallback: scan for numeric keys in AbilityInfo XML (channelId tags).
      const ids = new Set<number>();
      for (const m of abilityXml.matchAll(/<channelId>(\d+)<\/channelId>/gi)) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n >= 0) ids.add(n);
      }
      if (ids.size) return Array.from(ids).sort((a, b) => a - b);

      return Array.from({ length: Math.max(1, maxChannels) }, (_, i) => i);
    })();

    console.log("\n=== Channels to probe ===");
    console.log(JSON.stringify({ channels }, null, 2));

    const devInfoTags = ["type", "name", "serialNumber", "hardwareVersion", "firmwareVersion", "itemNo"] as const;

    console.log("\n=== Per-channel raw dumps ===");

    for (const ch of channels) {
      console.log("\n--------------------------------------------------------------------------------");
      console.log(`Channel ${ch}`);

      // DevInfo channel (cmd 318)
      try {
        const xml = await api.sendXml({ cmdId: 318, channel: ch, timeoutMs });
        const parsed = getXmlTexts(xml, devInfoTags);

        console.log("\n[cmd 318] DevInfo raw XML:");
        console.log(previewXml(xml, previewChars, fullXml));
        console.log("\n[cmd 318] DevInfo parsed tags:");
        console.log(JSON.stringify(parsed, null, 2));
      } catch (e: unknown) {
        console.log("\n[cmd 318] DevInfo failed:");
        console.log(e instanceof Error ? e.message : String(e));
      }

      if (!skipWhiteLed) {
        // White LED / Floodlight (cmd 289). Try ch and ch+1 since some firmwares are inconsistent.
        const candidates = Array.from(new Set([ch, ch + 1]));
        const whiteLedResults: Array<{ candidateChannel: number; ok: boolean; tags?: any; preview?: string; error?: string }> = [];

        for (const candidateCh of candidates) {
          try {
            const xml = await api.sendXml({ cmdId: 289, channel: candidateCh, timeoutMs: whiteLedTimeoutMs });
            const hasFloodlightTags = /(<FloodlightTask\b|<FloodlightManual\b|<FloodlightStatusList\b)/i.test(xml);
            const hasWhiteLedTag = /<WhiteLed\b/i.test(xml);
            const hasWhiteLedFields = /<(bright|brightness(_cur|_max)?|mode|status|switch|enable|level|manual|task)>/i.test(xml);

            whiteLedResults.push({
              candidateChannel: candidateCh,
              ok: true,
              tags: { hasFloodlightTags, hasWhiteLedTag, hasWhiteLedFields },
              preview: previewXml(xml, Math.min(previewChars, 900), fullXml),
            });
          } catch (e: unknown) {
            whiteLedResults.push({
              candidateChannel: candidateCh,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        console.log("\n[cmd 289] WhiteLed/Floodlight probe summary:");
        console.log(JSON.stringify(whiteLedResults, null, 2));
      } else {
        console.log("\n[cmd 289] WhiteLed/Floodlight probe skipped (NVR_SKIP_WHITELED=1)");
      }

      // Support items subset for this channel
      const items = (supportParsed?.items ?? []).filter((i: any) => i.chnID === ch || i.chnID === ch + 1);
      if (items.length) {
        console.log("\n[support] items for ch/ch+1:");
        console.log(JSON.stringify(items, null, 2));
      }
    }

    console.log("\n================================================================================");
    console.log("Done.");
  } finally {
    try {
      await api.close();
    } catch {
      // ignore
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
