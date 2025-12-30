#!/usr/bin/env node
/**
 * SetEnc helper: switch main/sub/ext stream codec (H.264/H.265) and verify via GetEnc.
 *
 * SAFETY:
 * - This modifies camera settings.
 * - Requires CONFIRM=YES.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

function usage(): void {
  console.log("\nUsage:");
  console.log("  CONFIRM=YES PROFILE=main CODEC=H.265 npm run test:tcp:set-enc\n");
  console.log("Env vars:");
  console.log("  PROFILE: main | sub | ext (default: main)");
  console.log("  CODEC:   H.264 | H.265 (default: H.265)");
  console.log("  CHANNEL: number (default: 0)");
  console.log("  CONFIRM: must be YES to apply changes\n");
}

function parseProfile(v: string | undefined): "main" | "sub" | "ext" {
  const p = (v ?? "main").trim().toLowerCase();
  if (p === "main" || p === "sub" || p === "ext") return p;
  throw new Error(`Invalid PROFILE: ${v}`);
}

function parseCodec(v: string | undefined): "H.264" | "H.265" {
  const c = (v ?? "H.265").trim().toUpperCase();
  if (c === "H.264" || c === "H264") return "H.264";
  if (c === "H.265" || c === "H265") return "H.265";
  throw new Error(`Invalid CODEC: ${v}`);
}

async function main(): Promise<void> {
  const profile = parseProfile(process.env.PROFILE);
  const codec = parseCodec(process.env.CODEC);
  const channel = Number(process.env.CHANNEL ?? "0");
  if (!Number.isFinite(channel) || channel < 0) throw new Error(`Invalid CHANNEL: ${process.env.CHANNEL}`);

  if ((process.env.CONFIRM ?? "").trim().toUpperCase() !== "YES") {
    usage();
    console.log("Refusing to change settings without CONFIRM=YES.");
    process.exit(2);
  }

  const api = new ReolinkBaichuanApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
    transport: "tcp",
    debug: true,
  });

  try {
    await api.login();

    const before = await api.getStreamMetadata(channel);
    console.log("\nBEFORE:");
    console.log(JSON.stringify(before, null, 2));

    console.log(`\nSetting channel=${channel} profile=${profile} codec=${codec} ...`);
    await api.setStreamVideoCodec(channel, profile, codec);

    // Many models apply changes asynchronously.
    await new Promise((r) => setTimeout(r, 1500));

    const after = await api.getStreamMetadata(channel);
    console.log("\nAFTER:");
    console.log(JSON.stringify(after, null, 2));

    console.log("\nDone. Restart the stream / RTSP server to take effect.");
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
