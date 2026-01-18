#!/usr/bin/env node
/**
 * TCP265 -> event subscription + PTZ-trigger test.
 *
 * Emulates a client that subscribes to push events, then moves PTZ to try to
 * trigger motion/object detection events.
 *
 * Requires .env:
 *  - TCP265_HOST / TCP265_USERNAME / TCP265_PASSWORD
 *
 * Optional env:
 *  - EVENTS_SECONDS=60
 *  - PTZ_ENABLED=0            (default 0; set to 1 to move PTZ)
 *  - PTZ_CHANNEL=0            (only if PTZ_ENABLED=1)
 *  - PTZ_SPEED=0.5            (only if PTZ_ENABLED=1)
 *  - PTZ_MOVE_MS=1200         (only if PTZ_ENABLED=1)
 *  - PTZ_PAUSE_MS=300         (only if PTZ_ENABLED=1)
 *  - PTZ_CYCLES=2             (only if PTZ_ENABLED=1)
 *  - PTZ_INITIAL_WAIT_MS=1500 (only if PTZ_ENABLED=1)
 *  - BAICHUAN_DEBUG=1
 *  - BAICHUAN_TRACE_TALK=1
 *  - BAICHUAN_TRACE_STREAM=1
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

function envNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const host = config.tcp265.host;
  const username = config.tcp265.username;
  const password = config.tcp265.password;

  if (!host) throw new Error("Missing TCP265_HOST in .env");
  if (!password) throw new Error("Missing TCP265_PASSWORD in .env");

  const debugEnabled = envBool(process.env.BAICHUAN_DEBUG, false);

  const seconds = Math.max(1, Math.floor(envNumber(process.env.EVENTS_SECONDS, 60)));

  const ptzEnabled = envBool(process.env.PTZ_ENABLED, false);

  const channel = Math.max(0, Math.floor(envNumber(process.env.PTZ_CHANNEL, 0)));
  const speed = envNumber(process.env.PTZ_SPEED, 0.5);
  const moveMs = Math.max(50, Math.floor(envNumber(process.env.PTZ_MOVE_MS, 1200)));
  const pauseMs = Math.max(0, Math.floor(envNumber(process.env.PTZ_PAUSE_MS, 300)));
  const cycles = Math.max(1, Math.floor(envNumber(process.env.PTZ_CYCLES, 2)));
  const initialWaitMs = Math.max(0, Math.floor(envNumber(process.env.PTZ_INITIAL_WAIT_MS, 1500)));

  console.log("\n============================================================");
  console.log(
    "[INFO] Starting events+PTZ trigger test",
    JSON.stringify(
      {
        host,
        username,
        seconds,
        ptzEnabled,
        ...(ptzEnabled
          ? {
              channel,
              speed,
              moveMs,
              pauseMs,
              cycles,
              initialWaitMs,
            }
          : {}),
      },
      null,
      2
    )
  );
  console.log("============================================================\n");

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    debugOptions: {
      enabled: debugEnabled,
      traceTalk: envBool(process.env.BAICHUAN_TRACE_TALK, false),
      traceNativeStream:
        envBool(process.env.BAICHUAN_TRACE_NATIVE_STREAM, false) ||
        envBool(process.env.BAICHUAN_TRACE_STREAM, false) ||
        envBool(process.env.BAICHUAN_DEBUG_H264, debugEnabled) ||
        envBool(process.env.BAICHUAN_DEBUG_PARAMSETS, false),
    },
  });

  let totalEvents = 0;
  let motionEvents = 0;
  let aiEvents = 0;

  const onRichEvent = (event: any) => {
    totalEvents++;

    if (event?.type === "motion") {
      motionEvents++;
      console.log("[EVENT] motion", {
        channel: event.channel,
        state: event.motion?.state,
        source: event.motion?.source,
        timestamp: event.timestamp,
      });
      return;
    }

    if (event?.type === "ai") {
      aiEvents++;
      console.log("[EVENT] objectDetection", {
        channel: event.channel,
        type: event.ai?.type,
        detected: event.ai?.detected,
        timestamp: event.timestamp,
      });
      return;
    }

    console.log("[EVENT]", event);
  };

  const onSimpleEvent = (event: any) => {
    console.log("[SIMPLE]", {
      type: event.type,
      channel: event.channel,
      timestamp: event.timestamp,
    });
  };

  const startedAt = Date.now();

  try {
    api.client.on("event", onRichEvent);
    api.simpleEvents.on("event", onSimpleEvent);

    console.log("[INFO] Subscribing to events...");
    await api.subscribeEvents();
    if (!ptzEnabled) {
      console.log("[OK] Subscribed. PTZ is disabled (PTZ_ENABLED=0). Waiting for events...");
    } else {
      const ptzStop = async (): Promise<void> => {
        // `PtzCommand` requires a `command` even for stop; implementation ignores it.
        await api.ptz(channel, { action: "stop", command: "Left" });
      };

      const ptzMove = async (command: "Left" | "Right" | "Up" | "Down"): Promise<void> => {
        await api.ptz(channel, { action: "start", command, speed });
        await sleep(moveMs);
        await ptzStop();
        if (pauseMs) await sleep(pauseMs);
      };

      console.log("[OK] Subscribed. Waiting a bit before PTZ...");
      if (initialWaitMs) await sleep(initialWaitMs);

      console.log("[INFO] Running PTZ movement sequence...");
      for (let i = 0; i < cycles; i++) {
        console.log(`[INFO] PTZ cycle ${i + 1}/${cycles}`);
        await ptzMove("Left");
        await ptzMove("Right");
        await ptzMove("Up");
        await ptzMove("Down");
      }
      console.log("[OK] PTZ sequence completed. Waiting for events...");
    }

    const elapsedMs = Date.now() - startedAt;
    const remainingMs = Math.max(0, seconds * 1000 - elapsedMs);
    if (remainingMs) await sleep(remainingMs);

    console.log("\n[OK] Events+PTZ trigger test completed (timeout)");
    console.log("[INFO] Counters", { totalEvents, motionEvents, aiEvents });
  } finally {
    api.client.off("event", onRichEvent);
    api.simpleEvents.off("event", onSimpleEvent);
    await api.close();
  }
}

main().catch((e) => {
  console.error("\n[ERROR] Events+PTZ trigger test failed");
  console.error(e instanceof Error ? e.stack || e.message : e);
  process.exitCode = 1;
});
