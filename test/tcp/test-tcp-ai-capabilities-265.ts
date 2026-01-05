#!/usr/bin/env node
/**
 * TCP265 AI capabilities diagnostic test.
 *
 * Goal: understand where (AbilityInfo/SupportInfo XML) this specific firmware exposes
 * AI-related capability hints, and confirm object types via AiCfg (cmd 299).
 *
 * Requires .env:
 *  - TCP265_HOST / TCP265_USERNAME / TCP265_PASSWORD
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, BC_CMD_ID_ABILITY_INFO, BC_CMD_ID_SUPPORT, buildAbilityInfoExtensionXml, getXmlText } from "../../index.js";
import { config } from "../env.js";

const DEFAULT_REGEX = /\b(ai|smart|person|people|human|vehicle|car|pet|dog|cat|face|package|visitor|baby|detection|alarm)\b/i;

function logSection(title: string, data?: unknown): void {
  console.log(`\n${"=".repeat(70)}`);
  console.log(title);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
  console.log("=".repeat(70));
}

function extractXmlContextMatches(
  xml: string,
  regex: RegExp,
  options?: { contextLines?: number; maxMatches?: number },
): string[] {
  const contextLines = options?.contextLines ?? 1;
  const maxMatches = options?.maxMatches ?? 80;

  const lines = xml.split(/\r?\n/);
  const out: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!regex.test(line)) continue;

    const start = Math.max(0, i - contextLines);
    const end = Math.min(lines.length - 1, i + contextLines);
    const snippet = lines.slice(start, end + 1).join("\n").trimEnd();

    if (!snippet) continue;
    if (seen.has(snippet)) continue;
    seen.add(snippet);
    out.push(snippet);

    if (out.length >= maxMatches) break;
  }

  return out;
}

function findObjectMatches(
  input: unknown,
  regex: RegExp,
  options?: { maxMatches?: number },
): Array<{ path: string; match: string }> {
  const maxMatches = options?.maxMatches ?? 200;

  const results: Array<{ path: string; match: string }> = [];
  const visited = new Set<unknown>();

  const walk = (value: unknown, path: string) => {
    if (results.length >= maxMatches) return;
    if (value === null || value === undefined) return;

    if (typeof value === "string") {
      if (regex.test(value)) results.push({ path, match: value });
      return;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return;
    }

    if (typeof value !== "object") return;

    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        walk(value[i], `${path}[${i}]`);
        if (results.length >= maxMatches) return;
      }
      return;
    }

    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k;
      if (regex.test(k)) results.push({ path: childPath, match: k });
      if (results.length >= maxMatches) return;
      walk(v, childPath);
      if (results.length >= maxMatches) return;
    }
  };

  walk(input, "");
  return results;
}

// (intentionally no HTTP/CGI usage in this diagnostic)

async function main(): Promise<void> {
  if (!config.tcp265.host || !config.tcp265.password) {
    console.error("[ERROR] TCP265 configuration is incomplete in the .env file");
    process.exit(1);
  }

  const regex = process.env.AI_DIAG_REGEX ? new RegExp(process.env.AI_DIAG_REGEX, "i") : DEFAULT_REGEX;

  const api = new ReolinkBaichuanApi({
    host: config.tcp265.host,
    username: config.tcp265.username,
    password: config.tcp265.password,
    transport: "tcp",
    debug: false,
  });

  // Avoid crashing the process on connection resets while probing unsupported commands.
  api.client.on("error", () => {
    // handled via try/catch around awaited calls
  });

  try {
    logSection("TCP265 AI diagnostic - starting", {
      host: config.tcp265.host,
      username: config.tcp265.username,
      regex: regex.toString(),
    });

    await api.login();

    const dev = await api.getInfo();
    logSection("Device info (GetDevInfo)", dev);

    const rawAbilityXml = await api.sendXml({
      cmdId: BC_CMD_ID_ABILITY_INFO,
      extensionXml: buildAbilityInfoExtensionXml(config.tcp265.username),
    });

    const rawSupportXml = await api.sendXml({ cmdId: BC_CMD_ID_SUPPORT });

    const abilityXmlMatches = extractXmlContextMatches(rawAbilityXml, regex, { contextLines: 1, maxMatches: 120 });
    logSection("AbilityInfo XML matches (context +/-1 line)", abilityXmlMatches);

    const supportXmlMatches = extractXmlContextMatches(rawSupportXml, regex, { contextLines: 1, maxMatches: 120 });
    logSection("Support XML matches (context +/-1 line)", supportXmlMatches);

    const abilities = await api.getAbilityInfo();
    const support = await api.getSupportInfo();

    const abilityKeyMatches: Record<string, string[]> = {};
    for (const [channelKey, channelAbilities] of Object.entries(abilities)) {
      if (!channelAbilities) continue;
      const matches = Object.keys(channelAbilities).filter((k) => regex.test(k));
      if (matches.length > 0) abilityKeyMatches[channelKey] = matches.sort();
    }

    logSection("getAbilityInfo() key matches", abilityKeyMatches);

    const supportMatches = findObjectMatches(support, regex, { maxMatches: 250 });
    logSection("getSupportInfo() deep matches (paths)", supportMatches);

    const caps = await api.getDeviceCapabilities(0);
    logSection("getDeviceCapabilities(0).objects", caps.objects ?? null);

    // Read AiCfg (cmd 299) which often exposes a comma-separated detectType list.
    // Example:
    // <AiCfg><detectType>people,vehicle,dog_cat</detectType>...</AiCfg>
    try {
      const aiCfgXml = await api.sendXml({ cmdId: 299, channel: 0 });
      const detectTypeRaw = (getXmlText(aiCfgXml, "detectType") ?? "").trim();
      const detectTypes = detectTypeRaw
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      logSection("AiCfg (cmd 299)", { detectTypeRaw, detectTypes, snippet: aiCfgXml.length > 600 ? `${aiCfgXml.slice(0, 600)}…` : aiCfgXml });
    } catch (e) {
      logSection("AiCfg (cmd 299) error", { error: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    await api.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
