#!/usr/bin/env node
/**
 * TCP -> PTZ control validation test.
 *
 * Requires .env:
 *  - TCP_HOST / TCP_USERNAME / TCP_PASSWORD
 *
 * Optional env:
 *  - BAICHUAN_TRACE_TALK / BAICHUAN_TRACE_STREAM / BAICHUAN_DEBUG
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
  const debugOptions = {
    enabled: debugEnabled,
    traceTalk: envBool(process.env.BAICHUAN_TRACE_TALK, false),
    traceNativeStream:
      envBool(process.env.BAICHUAN_TRACE_NATIVE_STREAM, false) ||
      envBool(process.env.BAICHUAN_TRACE_STREAM, false) ||
      envBool(process.env.BAICHUAN_DEBUG_H264, debugEnabled) ||
      envBool(process.env.BAICHUAN_DEBUG_PARAMSETS, false),
  } as const;

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    debugOptions,
  });

  try {
    // Pan left briefly; the API auto-sends stop after ~500ms.
    await api.ptz(0, { action: "start", command: "Left", speed: 0.5 });

    // Give time for the stop timer and the camera movement to be observable.
    await new Promise((r) => setTimeout(r, 1200));

    console.log("\n[OK] PTZ command sent (Left -> auto Stop)");
  } finally {
    await api.close();
  }
}

main().catch((e) => {
  console.error("\n[ERROR] PTZ test failed");
  console.error(e instanceof Error ? e.stack || e.message : e);
  process.exitCode = 1;
});
