#!/usr/bin/env node
/**
 * NVR TCP test: identify which Baichuan calls provide per-channel information.
 *
 * Constraints: TCP-only (no CGI). Uses NVR_HOST/NVR_USERNAME/NVR_PASSWORD from .env via test/env.ts.
 *
 * Strategy:
 * - Call getAbilityInfo() and getSupportInfo() to see if the NVR returns multi-channel data in one shot.
 * - Derive a channel list from those responses (fallback: probe a fixed range).
 * - For each channel, call getInfo(channel) (cmd_id 318) to fetch per-channel device info.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

function die(message: string): never {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}

function toChannelListFromAbilityInfo(abilities: unknown): number[] {
  if (!abilities || typeof abilities !== "object") return [];
  const keys = Object.keys(abilities as Record<string, unknown>);
  const out: number[] = [];
  for (const k of keys) {
    if (k === "Host") continue;
    const n = Number(k);
    if (Number.isFinite(n)) out.push(n);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function toChannelListFromSupportInfo(support: any): number[] {
  if (!support || typeof support !== "object") return [];

  // Best-effort: SupportInfo shape may vary by firmware.
  // Common patterns we try:
  // - support.channels: array of channel objects with channelId/id/channel
  // - support.channel: array
  // - support.perChannel / support.channelInfo keyed by channel number
  const candidates: unknown[] = [];
  for (const v of [support.channels, support.channel, support.Channel, support.ChannelInfo, support.channelInfo, support.perChannel]) {
    if (Array.isArray(v)) candidates.push(...v);
  }

  const out: number[] = [];
  for (const item of candidates) {
    if (typeof item === "number" && Number.isFinite(item)) {
      out.push(item);
      continue;
    }
    if (item && typeof item === "object") {
      const id = (item as any).channelId ?? (item as any).channel ?? (item as any).id ?? (item as any).chnId ?? (item as any).chnID;
      const n = typeof id === "string" ? Number(id) : id;
      if (typeof n === "number" && Number.isFinite(n)) out.push(n);
    }
  }

  // Keyed object fallback.
  for (const [k, v] of Object.entries(support as Record<string, unknown>)) {
    if (/^ch\d+$/i.test(k) || /^channel\d+$/i.test(k)) {
      const n = Number(k.replace(/\D/g, ""));
      if (Number.isFinite(n)) out.push(n);
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      // Sometimes supportInfo is keyed by channel number directly.
      const n = Number(k);
      if (Number.isFinite(n)) out.push(n);
    }
  }

  return [...new Set(out)].sort((a, b) => a - b);
}

async function main() {
  if (!config.nvr.host) die("Missing NVR_HOST in .env");
  if (!config.nvr.password) die("Missing NVR_PASSWORD in .env");

  const api = new ReolinkBaichuanApi({
    host: config.nvr.host,
    username: config.nvr.username,
    password: config.nvr.password,
    transport: "tcp",
    debug: false,
  });

  const maxEnc = (process.env.BAICHUAN_MAX_ENC as any) as "none" | "bc" | "aes" | "full_aes" | undefined;
  const timeoutMs = Number.parseInt(process.env.NVR_CHANNEL_TIMEOUT_MS ?? "3500", 10);
  const probeMaxChannels = Number.parseInt(process.env.NVR_MAX_CHANNELS ?? "16", 10);
  const useCgi = (process.env.NVR_USE_CGI ?? "").trim() === "1" || (process.env.NVR_USE_CGI ?? "").trim().toLowerCase() === "true";

  try {
    console.log("\n=== NVR TCP - CHANNEL DISCOVERY / SUMMARY ===");
    console.log(`host: ${config.nvr.host}`);
    console.log(`username: ${config.nvr.username}`);

    await api.login(maxEnc ?? "aes");

    // Host info (useful sanity check).
    const hostInfo = await api.getInfo(undefined, { timeoutMs }).catch((e: any) => ({ error: String(e) } as any));
    console.log("\n--- Host getInfo() ---");
    console.log(JSON.stringify(hostInfo, null, 2));

    // Multi-channel candidates.
    let abilityInfo: any = undefined;
    let supportInfo: any = undefined;

    try {
      abilityInfo = await api.getAbilityInfo();
      console.log("\n--- getAbilityInfo() (keys preview) ---");
      const chs = toChannelListFromAbilityInfo(abilityInfo);
      console.log(JSON.stringify({ channelsFromAbilityInfo: chs, keys: Object.keys(abilityInfo ?? {}).slice(0, 30) }, null, 2));
    } catch (e) {
      console.log("\n--- getAbilityInfo() failed ---");
      console.log(String(e));
    }

    try {
      supportInfo = await api.getSupportInfo();
      console.log("\n--- getSupportInfo() (shape preview) ---");
      const chs = toChannelListFromSupportInfo(supportInfo);
      console.log(JSON.stringify({ channelsFromSupportInfo: chs, topLevelKeys: Object.keys(supportInfo ?? {}).slice(0, 50) }, null, 2));
    } catch (e) {
      console.log("\n--- getSupportInfo() failed ---");
      console.log(String(e));
    }

    const channels = (() => {
      const a = toChannelListFromAbilityInfo(abilityInfo);
      const s = toChannelListFromSupportInfo(supportInfo);
      const merged = [...new Set([...a, ...s])].sort((x, y) => x - y);
      if (merged.length) return merged;
      return Array.from({ length: Number.isFinite(probeMaxChannels) && probeMaxChannels > 0 ? probeMaxChannels : 16 }, (_, i) => i);
    })();

    console.log("\n--- Channel list (final) ---");
    console.log(JSON.stringify({ channels }, null, 2));

    const perChannel: Array<{ channel: number; ok: boolean; info?: Record<string, string>; error?: string }> = [];
    for (const ch of channels) {
      try {
        const info = await api.getInfo(ch, { timeoutMs });
        const hasAnyValue = Object.values(info).some((v) => String(v ?? "").trim() !== "");
        if (!hasAnyValue) {
          perChannel.push({ channel: ch, ok: false, error: "empty response" });
          continue;
        }
        perChannel.push({ channel: ch, ok: true, info });
      } catch (e) {
        perChannel.push({ channel: ch, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    console.log("\n=== Per-channel getInfo(channel) summary ===");
    console.log(
      perChannel
        .map((r) => {
          const name = r.info?.name ?? "";
          const type = r.info?.type ?? "";
          const fw = r.info?.firmwareVersion ?? "";
          return `${String(r.channel).padStart(2, "0")}  ${r.ok ? "OK" : "--"}  ${type}  ${name}  ${fw} ${r.ok ? "" : `(${r.error ?? ""})`}`.trim();
        })
        .join("\n"),
    );

    const okCount = perChannel.filter((x) => x.ok).length;

    // Optional: run the unified helper that falls back to CGI under the hood.
    // Useful for battery/sleeping channels behind an NVR/Home Hub that fail Baichuan cmd_id 318.
    if (useCgi) {
      console.log("\n=== getNvrChannelsInfo() (with CGI fallback) ===");
      const rows = await api.getNvrChannelsInfo({
        source: "cgi",
        timeoutMs,
        maxChannels: probeMaxChannels,
      });

      console.log(
        rows
          .map((r: { channel: number; model?: string; name?: string; uid?: string; online?: boolean; sleep?: boolean; firmwareVersion?: string }) => {
            const model = r.model ?? "";
            const name = r.name ?? "";
            const uid = r.uid ?? "";
            const fw = r.firmwareVersion ? `  ${r.firmwareVersion}` : "";
            const flags = [r.online === false ? "offline" : "", r.sleep ? "sleep" : ""].filter(Boolean).join(",");
            return `${String(r.channel).padStart(2, "0")}  ${model}  ${name}${fw}  ${uid}${flags ? `  [${flags}]` : ""}`.trim();
          })
          .join("\n"),
      );
    }

    console.log("\n=== Conclusion (TCP-only) ===");
    console.log(
      [
        `getAbilityInfo(): ${abilityInfo ? "returns multi-channel capability blocks (good to infer channel IDs)" : "not available/failed"}`,
        `getSupportInfo(): ${supportInfo ? "may return some per-channel flags (depends on firmware)" : "not available/failed"}`,
        `getInfo(channel): per-channel main device info via cmd_id 318 (works for ${okCount}/${perChannel.length} probed channels)`,
        "=> There is typically no single Baichuan call that returns full devinfo for all channels in one response; you enumerate/probe channels and call getInfo(channel) per channel.",
        useCgi
          ? "=> CGI fallback enabled: prints general channel info via GetChannelstatus + GetChnTypeInfo."
          : "=> Tip: set NVR_USE_CGI=1 to fetch all channels general info via CGI for this test.",
      ].join("\n"),
    );
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
