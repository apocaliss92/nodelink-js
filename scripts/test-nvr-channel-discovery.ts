#!/usr/bin/env npx tsx
/**
 * Test: NVR channel discovery strategies
 *
 * Investigates why getNvrChannelsSummary returns empty on first call
 * and compares 3 approaches for fast channel discovery:
 *
 *  1. CGI GetChannelstatus   → immediate, no wait needed
 *  2. Push cache (cmd_id 145) → async, NVR sends it after connection
 *  3. getAllChannelsInfo (cmd_id 145 explicit request) → likely empty (read-only push)
 *
 * Usage:
 *   npx tsx scripts/test-nvr-channel-discovery.ts
 *
 * Reads from .env: HUB_HOST, HUB_USERNAME, HUB_PASSWORD
 */

import "dotenv/config";
import { ReolinkBaichuanApi } from "../src/reolink/baichuan/ReolinkBaichuanApi.js";

const HOST = process.env.HUB_HOST ?? process.env.NVR_HOST ?? "";
const USERNAME = process.env.HUB_USERNAME ?? process.env.NVR_USERNAME ?? "admin";
const PASSWORD = process.env.HUB_PASSWORD ?? process.env.NVR_PASSWORD ?? "";

if (!HOST) {
  console.error("Missing HUB_HOST or NVR_HOST in .env");
  process.exit(1);
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

function log(msg: string) { console.log(msg); }
function ok(msg: string) { log(`  ${GREEN}✔${RESET} ${msg}`); }
function warn(msg: string) { log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function fail(msg: string) { log(`  ${RED}✘${RESET} ${msg}`); }
function section(msg: string) { log(`\n${BOLD}${CYAN}── ${msg} ──${RESET}`); }
function dim(msg: string) { log(`  ${DIM}${msg}${RESET}`); }

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  log(`\n${BOLD}NVR Channel Discovery Test${RESET}`);
  log(`Hub: ${HOST} | User: ${USERNAME}`);

  const api = new ReolinkBaichuanApi({
    host: HOST,
    username: USERNAME,
    password: PASSWORD,
    transport: "tcp",
  });

  // ── Connect ──────────────────────────────────────────────────────────────
  section("Login");
  const t0 = Date.now();
  await api.login();
  log(`  Login OK in ${Date.now() - t0}ms`);

  // ── Approach 1: CGI GetChannelstatus (immediate) ──────────────────────────
  section("Approach 1: CGI GetChannelstatus");
  const t1 = Date.now();
  try {
    // Access the cgi sub-api via any cast (it's private but for testing)
    const cgi = (api as any).cgiApi as import("../src/reolink/cgi/ReolinkCgiApi.js").ReolinkCgiApi;
    const { channels: cgiChannels, channelsResponse } = await cgi.getChannels();
    const elapsed1 = Date.now() - t1;

    if (cgiChannels.length > 0) {
      ok(`Found ${cgiChannels.length} channel(s) in ${elapsed1}ms: [${cgiChannels.join(", ")}]`);
      const status = channelsResponse?.[0]?.value?.status ?? [];
      for (const s of status.filter((s: any) => !!s?.uid)) {
        dim(`  channel=${s.channel}  uid=${s.uid}  name=${s.name}  sleep=${s.sleep}`);
      }
    } else {
      warn(`No channels via CGI (${elapsed1}ms). Raw status:`);
      const status = channelsResponse?.[0]?.value?.status ?? [];
      for (const s of status) {
        dim(`  channel=${(s as any).channel}  uid=${(s as any).uid ?? "(none)"}  name=${(s as any).name ?? "(none)"}`);
      }
    }
  } catch (e: any) {
    fail(`CGI GetChannelstatus failed: ${e?.message ?? String(e)}`);
  }

  // ── Approach 2a: Push cache right after login (before cmd_id 145 arrives) ──
  section("Approach 2a: Push cache immediately after login");
  const t2a = Date.now();
  const pushCacheImmediate = api.getChannelInfoFromPushCache();
  const elapsed2a = Date.now() - t2a;
  if (pushCacheImmediate.size > 0) {
    ok(`Push cache has ${pushCacheImmediate.size} channel(s) immediately (${elapsed2a}ms)`);
    for (const [ch, info] of pushCacheImmediate) {
      dim(`  channel=${ch}  uid=${info.uid}  name=${info.name}  state=${info.state}`);
    }
  } else {
    warn(`Push cache empty immediately after login (${elapsed2a}ms) — cmd_id 145 not yet received`);
  }

  // ── Approach 2b: getNvrChannelsSummary immediately (current code path) ──
  section("Approach 2b: getNvrChannelsSummary() immediately (current behavior)");
  const t2b = Date.now();
  try {
    const summary0 = await api.getNvrChannelsSummary({ timeoutMs: 5000 });
    const elapsed2b = Date.now() - t2b;
    if (summary0.channels.length > 0) {
      ok(`getNvrChannelsSummary returned ${summary0.channels.length} channel(s) in ${elapsed2b}ms`);
    } else {
      warn(`getNvrChannelsSummary returned EMPTY in ${elapsed2b}ms — push cache was not ready`);
    }
  } catch (e: any) {
    fail(`getNvrChannelsSummary failed: ${e?.message ?? String(e)}`);
  }

  // ── Approach 3: getAllChannelsInfo via cmd_id 145 explicit request ──
  section("Approach 3: getAllChannelsInfo (cmd_id 145 explicit request)");
  const t3 = Date.now();
  try {
    const allInfo = await api.getAllChannelsInfo({ timeoutMs: 5000 });
    const elapsed3 = Date.now() - t3;
    if (allInfo.size > 0) {
      ok(`getAllChannelsInfo returned ${allInfo.size} channel(s) in ${elapsed3}ms`);
      for (const [ch, info] of allInfo) {
        dim(`  channel=${ch}  uid=${(info as any).uid ?? "(none)"}  name=${(info as any).name ?? "(none)"}`);
      }
    } else {
      warn(`getAllChannelsInfo returned EMPTY in ${elapsed3}ms — NVR doesn't allow explicit cmd_id 145 request`);
    }
  } catch (e: any) {
    fail(`getAllChannelsInfo failed: ${e?.message ?? String(e)}`);
  }

  // ── Wait for push cache to populate (cmd_id 145 arrives async) ──
  section("Approach 2c: Wait up to 3s for cmd_id 145 push cache to populate");
  const waitStart = Date.now();
  let pushCacheAfterWait = new Map<number, any>();
  for (let i = 0; i < 30; i++) {
    pushCacheAfterWait = api.getChannelInfoFromPushCache();
    if (pushCacheAfterWait.size > 0) break;
    await sleep(100);
  }
  const elapsed2c = Date.now() - waitStart;

  if (pushCacheAfterWait.size > 0) {
    ok(`Push cache populated after ${elapsed2c}ms with ${pushCacheAfterWait.size} channel(s):`);
    for (const [ch, info] of pushCacheAfterWait) {
      dim(`  channel=${ch}  uid=${info.uid}  name=${info.name}  state=${info.state}`);
    }
  } else {
    warn(`Push cache still empty after ${elapsed2c}ms`);
  }

  // ── Re-run getNvrChannelsSummary after push cache is ready ──
  section("Approach 2d: getNvrChannelsSummary() after push cache populated");
  if (pushCacheAfterWait.size > 0) {
    const t2d = Date.now();
    try {
      const summary1 = await api.getNvrChannelsSummary({ timeoutMs: 5000 });
      const elapsed2d = Date.now() - t2d;
      if (summary1.channels.length > 0) {
        ok(`getNvrChannelsSummary returned ${summary1.channels.length} channel(s) in ${elapsed2d}ms after push cache ready`);
        for (const d of summary1.devices) {
          dim(`  channel=${d.channel}  name=${d.name}  uid=${d.uid}  isBattery=${d.isBattery}  isDoorbell=${d.isDoorbell}`);
        }
      } else {
        fail(`getNvrChannelsSummary still empty after push cache populated — unexpected`);
      }
    } catch (e: any) {
      fail(`getNvrChannelsSummary (after wait) failed: ${e?.message ?? String(e)}`);
    }
  } else {
    warn("Skipping 2d: push cache never populated");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  section("Summary");
  log(`  Total time: ${Date.now() - t0}ms`);
  log(`
  Recommendations based on results:
  - If CGI returned channels immediately → use CGI as primary source for channel list
  - If push cache populated in <500ms → add a short poll/wait after login
  - If push cache takes >1s → definitely need CGI or cmd_id 318 fallback
  `);

  await api.disconnect?.().catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  console.error("\nFatal error:", e?.message ?? String(e));
  process.exit(1);
});
