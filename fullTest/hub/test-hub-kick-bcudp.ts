#!/usr/bin/env node
/**
 * Hub initiator "kick" via BCUDP local UID discovery (ports 2015/2018).
 *
 * Goal: emulate the Home Hub behaviour that *initiates* contact on LAN.
 * In practice, the hub triggers the BCUDP discovery handshake (C2D_C, then optional T/A),
 * and the camera may subsequently open TCP/6666 + send UDP/7777 notifications.
 *
 * Requires .env (defaults):
 *  - UDP_HOST / UDP_UID
 *
 * Optional env:
 *  - HUB_KICK_HOST (defaults to UDP_HOST)
 *  - HUB_KICK_UID (defaults to UDP_UID)
 *  - HUB_KICK_METHOD: local-direct | local-broadcast (default: local-direct)
 *  - HUB_KICK_TIMEOUT_MS (default: 30000)
 *
 * Suggested usage (one-shot):
 *  - Start the hub emulator in another terminal with capture + idle-exit
 *  - Run this script to trigger the camera
 */

// @ts-expect-error - Path resolution at runtime
import { BcUdpStream } from "../../index.js";
import { config } from "../env.js";

function envNumber(name: string, def: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

async function main(): Promise<void> {
  const host = (process.env.HUB_KICK_HOST ?? config.udp.host).trim();
  const uid = (process.env.HUB_KICK_UID ?? config.udp.uid).trim();
  const methodRaw = (process.env.HUB_KICK_METHOD ?? "local-direct").trim();
  const timeoutMs = envNumber("HUB_KICK_TIMEOUT_MS", 30_000);

  if (!host) throw new Error("Missing HUB_KICK_HOST (or UDP_HOST in .env)");
  if (!uid) throw new Error("Missing HUB_KICK_UID (or UDP_UID in .env)");
  if (methodRaw !== "local-direct" && methodRaw !== "local-broadcast") {
    throw new Error(`Unsupported HUB_KICK_METHOD=${JSON.stringify(methodRaw)} (expected local-direct|local-broadcast)`);
  }

  console.log(`[hub-kick] target host=${host} uid=${uid} method=${methodRaw} timeoutMs=${timeoutMs}`);

  const s = new BcUdpStream({
    mode: "uid",
    uid,
    directHost: host,
    discoveryMethod: methodRaw,
  });

  s.on("debug", (event: string, data?: unknown) => {
    // Keep logs short; this is mainly to confirm we got D2C_* replies.
    const preview = data ? JSON.stringify(data).slice(0, 500) : "";
    console.log(`[hub-kick][debug] ${event}${preview ? ` ${preview}` : ""}`);
  });
  s.on("error", (e: Error) => console.log(`[hub-kick][error] ${e.message}`));

  const startedAt = Date.now();
  try {
    await Promise.race([
      s.connect(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);

    const dt = Date.now() - startedAt;
    console.log(`[hub-kick] discovery/connect succeeded in ${dt}ms`);
  } finally {
    await s.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
