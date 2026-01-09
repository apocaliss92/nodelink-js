#!/usr/bin/env node
/**
 * UDP discovery methods integration test.
 *
 * Purpose:
 * - Iterates through all supported UDP discovery methods (local/remote/map/relay)
 * - Uses env config (see test/env.ts) and validates that login+ping works.
 * - Intended for fast local iteration while debugging discovery.
 *
 * Env vars:
 * - UDP_HOST / UDP_USERNAME / UDP_PASSWORD / UDP_UID: required connection settings
 * - UDP_DISCOVERY_METHOD: run only one method (local|remote|map|relay)
 * - UDP_DISCOVERY_REQUIRE_ALL: if "1"/"true", fail if any method fails
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

type Method = "local" | "remote" | "map" | "relay";

function envStr(key: string): string | undefined {
  const v = process.env[key];
  if (v == null) return undefined;
  const s = v.trim();
  return s === "" ? undefined : s;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const raw = envStr(key);
  if (!raw) return defaultValue;
  const v = raw.toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return defaultValue;
}

function asMethod(v: string | undefined): Method | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "local" || s === "remote" || s === "map" || s === "relay") return s;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    t.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}

async function testOne(method: Method): Promise<{ ok: boolean; error?: string }> {
  const host = config.udp.host || "255.255.255.255";

  const api = new ReolinkBaichuanApi({
    host,
    username: config.udp.username,
    password: config.udp.password,
    uid: config.udp.uid,
    transport: "udp",
    udpDiscoveryMethod: method,
    debugOptions: { general: true },
  });

  // Make sure errors don't crash the process from event handlers.
  api.client.on("error", () => {
    // handled by awaited calls
  });

  // Helpful for diagnosing discovery differences between methods.
  api.client.on("debug", (event: string, data?: unknown) => {
    console.log(`  [DEBUG ${method}] ${event}:`, data);
  });

  try {
    // Login is the best end-to-end validator: it exercises discovery + session establishment.
    await withTimeout(api.login(), 25_000, `${method}: login`);
    await withTimeout(api.ping(), 10_000, `${method}: ping`);
    await api.close();
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await api.close();
    } catch {
      // ignore
    }
    // Small backoff to avoid hammering the camera between attempts.
    await sleep(300);
    return { ok: false, error: msg };
  }
}

async function main(): Promise<void> {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║     UDP DISCOVERY METHODS TEST (BCUDP) - REOLINK          ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  if (!config.udp.uid) {
    throw new Error("Missing UDP_UID in .env (required for BCUDP UID discovery)");
  }
  if (!config.udp.password) {
    throw new Error("Missing UDP_PASSWORD in .env (required for login)");
  }

  const only = asMethod(envStr("UDP_DISCOVERY_METHOD"));
  const requireAll = envBool("UDP_DISCOVERY_REQUIRE_ALL", false);

  const methods: Method[] = only ? [only] : ["local", "remote", "map", "relay"];

  console.log("Configuration:");
  console.log(`  Host (env UDP_HOST): ${config.udp.host || ""}`);
  console.log(`  Effective host: ${config.udp.host || "255.255.255.255"}`);
  console.log(`  Username: ${config.udp.username}`);
  console.log(`  UID: ${config.udp.uid}`);
  console.log(`  Methods: ${methods.join(", ")}`);
  console.log(`  Require all: ${requireAll ? "yes" : "no"}\n`);

  const results: Record<Method, { ok: boolean; error?: string }> = {
    local: { ok: false },
    remote: { ok: false },
    map: { ok: false },
    relay: { ok: false },
  };

  for (const m of methods) {
    console.log(`\n[TEST] udpDiscoveryMethod=${m}`);
    const r = await testOne(m);
    results[m] = r;
    if (r.ok) console.log(`[OK] ${m} succeeded`);
    else console.log(`[FAIL] ${m} failed: ${r.error}`);
  }

  console.log("\nSummary:");
  for (const m of methods) {
    const r = results[m];
    const status = r.ok ? "OK" : "FAILED";
    const details = r.ok ? "" : ` - ${r.error}`;
    console.log(`  ${m.padEnd(5)}: ${status}${details}`);
  }

  const okCount = methods.filter((m) => results[m].ok).length;
  const allOk = okCount === methods.length;

  if (requireAll) {
    process.exit(allOk ? 0 : 1);
  }

  // Default policy: pass if at least one method worked.
  process.exit(okCount > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n[FATAL]", e);
  process.exit(1);
});
