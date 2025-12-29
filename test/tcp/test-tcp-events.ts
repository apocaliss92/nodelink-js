#!/usr/bin/env node
/**
 * TCP -> event subscription test.
 *
 * Prints motion/object detection events as soon as they are pushed.
 *
 * Requires .env:
 *  - TCP_HOST / TCP_USERNAME / TCP_PASSWORD
 *
 * Optional env:
 *  - EVENTS_SECONDS=60
 *  - BAICHUAN_DEBUG=1
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

function envBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "y" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n" || v === "off") return false;
  return defaultValue;
}

async function main(): Promise<void> {
  const host = config.tcp.host;
  const username = config.tcp.username;
  const password = config.tcp.password;

  if (!host) throw new Error("Missing TCP_HOST in .env");
  if (!password) throw new Error("Missing TCP_PASSWORD in .env");

  const debugEnabled = envBool(process.env.BAICHUAN_DEBUG, false);
  const seconds = Number.parseInt(process.env.EVENTS_SECONDS ?? "60", 10) || 60;

  console.log("\n============================================================");
  console.log("[INFO] Starting events test", JSON.stringify({ host, username, seconds }, null, 2));
  console.log("============================================================\n");

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    debugOptions: {
      enabled: debugEnabled,
      traceTalk: envBool(process.env.BAICHUAN_TRACE_TALK, false),
      traceStream: envBool(process.env.BAICHUAN_TRACE_STREAM, false),
      debugH264: envBool(process.env.BAICHUAN_DEBUG_H264, debugEnabled),
      debugParamSets: envBool(process.env.BAICHUAN_DEBUG_PARAMSETS, false),
    },
  });

  try {
    await api.subscribeEvents();

    api.client.on("event", (event: any) => {
      if (event.type === "motion") {
        console.log("[EVENT] motion", {
          channel: event.channel,
          state: event.motion?.state,
          source: event.motion?.source,
          timestamp: event.timestamp,
        });
        return;
      }
      if (event.type === "ai") {
        console.log("[EVENT] objectDetection", {
          channel: event.channel,
          type: event.ai?.type,
          detected: event.ai?.detected,
          timestamp: event.timestamp,
        });
        return;
      }
      console.log("[EVENT]", event);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
    console.log("\n[OK] Events test completed (timeout)");
  } finally {
    await api.close();
  }
}

main().catch((e) => {
  console.error("\n[ERROR] Events test failed");
  console.error(e instanceof Error ? e.stack || e.message : e);
  process.exitCode = 1;
});
