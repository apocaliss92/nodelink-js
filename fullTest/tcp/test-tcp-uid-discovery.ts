#!/usr/bin/env node
/**
 * Test: discover camera UID via APIs using TCP_HOST.
 *
 * Env:
 * - TCP_HOST / TCP_USERNAME / TCP_PASSWORD (required)
 * - TCP_UID (optional, used as reference if set)
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, ReolinkCgiApi } from "../../index.js";
import { config } from "../env.js";

function die(msg: string): never {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

function extractUidLike(value: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | undefined => {
    if (v == null) return undefined;
    if (typeof v === "string") {
      const s = v.trim();
      // Typical Reolink UID: uppercase alnum, ~16 chars (e.g. 9527000HZ56U1ORU)
      if (/^[0-9A-Z]{12,24}$/.test(s) && /[A-Z]/.test(s)) return s;
      return undefined;
    }
    if (typeof v !== "object") return undefined;
    if (seen.has(v)) return undefined;
    seen.add(v);

    if (Array.isArray(v)) {
      for (const it of v) {
        const r = walk(it);
        if (r) return r;
      }
      return undefined;
    }

    for (const vv of Object.values(v as Record<string, unknown>)) {
      const r = walk(vv);
      if (r) return r;
    }
    return undefined;
  };
  return walk(value);
}

async function main(): Promise<void> {
  if (!config.tcp.host) die("Missing TCP_HOST in .env");
  if (!config.tcp.password) die("Missing TCP_PASSWORD in .env");

  const explicitUid = (process.env.TCP_UID ?? "").trim();

  const api = new ReolinkBaichuanApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
    transport: "tcp",
    debug: (process.env.DEBUG ?? "").trim() === "1",
  });

  console.log("\n=== TCP UID DISCOVERY TEST ===");
  console.log(`host: ${config.tcp.host}`);
  if (explicitUid) {
    console.log(`TCP_UID (env): ${explicitUid}`);
  } else {
    console.log("TCP_UID (env): (not set)");
  }

  try {
    await api.login();

    // 1) Try Baichuan getInfo() -> serialNumber and related fields
    const info = await api.getInfo();
    const serial = (info.serialNumber ?? "").trim();
    console.log(`\n[Baichuan] getInfo().serialNumber: ${serial || "(missing)"}`);

    let discoveredUid: string | undefined;

    // 2) Try HTTP CGI GetP2p / GetDevInfo / GetChannelstatus
    try {
      const cgi = new ReolinkCgiApi({
        host: config.tcp.host,
        username: config.tcp.username,
        password: config.tcp.password,
      });
      await cgi.login();

      try {
        const p2p = await cgi.call("GetP2p", {});
        const fromP2p = extractUidLike(p2p);
        console.log(`[HTTP CGI] GetP2p UID candidate: ${fromP2p || "(none)"}`);
        discoveredUid = discoveredUid ?? fromP2p ?? undefined;
      } catch {
        console.log("[HTTP CGI] GetP2p failed (ignored)");
      }

      try {
        const devInfo = await cgi.GetDevInfo();
        const fromDevInfo = extractUidLike(devInfo);
        console.log(`[HTTP CGI] GetDevInfo UID candidate: ${fromDevInfo || "(none)"}`);
        discoveredUid = discoveredUid ?? fromDevInfo ?? undefined;
      } catch {
        console.log("[HTTP CGI] GetDevInfo failed (ignored)");
      }

      try {
        const ch = await cgi.GetChannelstatus();
        const fromChannelStatus = extractUidLike(ch);
        console.log(`[HTTP CGI] GetChannelstatus UID candidate: ${fromChannelStatus || "(none)"}`);
        discoveredUid = discoveredUid ?? fromChannelStatus ?? undefined;
      } catch {
        console.log("[HTTP CGI] GetChannelstatus failed (ignored)");
      }

      await cgi.logout().catch(() => undefined);
    } catch {
      console.log("[HTTP CGI] Login or requests failed (ignored)");
    }

    // 3) Try Baichuan GetP2p via sendXml(cmdId=114)
    if (!discoveredUid) {
      try {
        const p2pXml = await api.sendXml({ cmdId: 114, timeoutMs: 10_000 });
        const fromBaichuanP2p = extractUidLike(p2pXml);
        console.log(`\n[Baichuan] cmdId=114 (GetP2p) UID candidate: ${fromBaichuanP2p || "(none)"}`);
        discoveredUid = discoveredUid ?? fromBaichuanP2p ?? undefined;
      } catch (e) {
        console.log(`[Baichuan] cmdId=114 (GetP2p) failed: ${(e as Error).message}`);
      }
    }

    // 4) Fallback: serialNumber as UID (some firmwares accept it)
    if (!discoveredUid && serial) {
      console.log("\n[Fallback] Using serialNumber as UID candidate");
      discoveredUid = serial;
    }

    console.log("\n=== RESULT ===");
    console.log(`Discovered UID: ${discoveredUid || "(none)"}`);

    if (explicitUid) {
      console.log(`Configured TCP_UID: ${explicitUid}`);
      if (discoveredUid && discoveredUid !== explicitUid) {
        console.log("WARNING: Discovered UID does not match TCP_UID");
      }
    }

    if (!discoveredUid) {
      console.log("\nNo UID could be derived automatically. Set TCP_UID in .env and retry.");
      process.exitCode = 1;
      return;
    }
  } finally {
    await api.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("[FATAL] UID discovery test failed:", err);
  process.exit(1);
});


