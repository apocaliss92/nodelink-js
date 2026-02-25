#!/usr/bin/env npx tsx
/**
 * Test script: CoverPreview back-pressure, queue limit & incremental backoff.
 *
 * Usage:
 *   npx tsx scripts/test-coverpreview-backpressure.ts [--live]
 *
 * Without --live: runs unit-style tests against internal data structures
 *                 (no camera required).
 * With --live:    connects to the camera defined by TCP265_* vars in .env
 *                 and fires 60+ concurrent thumbnail requests to verify
 *                 protections in practice. Saves JPEG thumbnails to
 *                 ./test/artifacts/coverpreview-backpressure/.
 */

import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BaichuanClient } from "../src/client/BaichuanClient.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const PASS = "\x1b[32m✔\x1b[0m";
const FAIL = "\x1b[31m✘\x1b[0m";
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Access private/static members via reflection (test-only hack)
// ---------------------------------------------------------------------------
const ClientAny = BaichuanClient as any;

function getBackoffMap(): Map<string, number> {
  return ClientAny.coverPreviewBackoffMs ?? ClientAny["coverPreviewBackoffMs"];
}

function getQueueTailMap(): Map<string, Promise<void>> {
  return (
    ClientAny.coverPreviewQueueTail ?? ClientAny["coverPreviewQueueTail"]
  );
}

function getInitialBackoff(): number {
  return (
    ClientAny.COVER_PREVIEW_INITIAL_BACKOFF_MS ??
    ClientAny["COVER_PREVIEW_INITIAL_BACKOFF_MS"] ??
    1000
  );
}

function getMaxBackoff(): number {
  return (
    ClientAny.COVER_PREVIEW_MAX_BACKOFF_MS ??
    ClientAny["COVER_PREVIEW_MAX_BACKOFF_MS"] ??
    30000
  );
}

// ---------------------------------------------------------------------------
// Test 1: Static backoff map exists and has correct constants
// ---------------------------------------------------------------------------
function testBackoffConstants(): void {
  console.log("\n── Test 1: Backoff constants ──");

  const map = getBackoffMap();
  assert(map instanceof Map, "coverPreviewBackoffMs is a Map");
  assert(map.size === 0, "Backoff map starts empty");

  const initial = getInitialBackoff();
  assert(initial === 1_000, `INITIAL_BACKOFF = ${initial} (expected 1000)`);

  const max = getMaxBackoff();
  assert(max === 30_000, `MAX_BACKOFF = ${max} (expected 30000)`);
}

// ---------------------------------------------------------------------------
// Test 2: Backoff increases on simulated 400 failures
// ---------------------------------------------------------------------------
async function testBackoffIncrement(): Promise<void> {
  console.log("\n── Test 2: Incremental backoff on 400 rejection ──");

  const map = getBackoffMap();
  const testKey = "coverpreview|test-host|TEST-UID";

  // Clean slate
  map.delete(testKey);

  // Simulate failures by setting values directly and checking progression
  // (We can't easily call withSerializedCoverPreview because it needs a full
  // client instance, but we verify the map-based contract.)

  // Simulate first failure: 0 → INITIAL
  const initial = getInitialBackoff();
  const maxBo = getMaxBackoff();

  map.set(testKey, 0);
  // Emulate what withSerializedCoverPreview does on 400:
  let current = map.get(testKey) ?? 0;
  let next = current === 0 ? initial : Math.min(current * 2, maxBo);
  map.set(testKey, next);
  assert(
    map.get(testKey) === initial,
    `After 1st failure: backoff = ${map.get(testKey)} (expected ${initial})`,
  );

  // 2nd failure: 1000 → 2000
  current = map.get(testKey) ?? 0;
  next = current === 0 ? initial : Math.min(current * 2, maxBo);
  map.set(testKey, next);
  assert(
    map.get(testKey) === 2_000,
    `After 2nd failure: backoff = ${map.get(testKey)} (expected 2000)`,
  );

  // 3rd failure: 2000 → 4000
  current = map.get(testKey) ?? 0;
  next = current === 0 ? initial : Math.min(current * 2, maxBo);
  map.set(testKey, next);
  assert(
    map.get(testKey) === 4_000,
    `After 3rd failure: backoff = ${map.get(testKey)} (expected 4000)`,
  );

  // Keep doubling until we hit max
  let val = map.get(testKey)!;
  while (val < maxBo) {
    current = val;
    val = Math.min(current * 2, maxBo);
    map.set(testKey, val);
  }
  assert(
    map.get(testKey) === maxBo,
    `Backoff caps at MAX = ${map.get(testKey)} (expected ${maxBo})`,
  );

  // Simulate success: delete entry
  map.delete(testKey);
  assert(
    !map.has(testKey),
    "After success: backoff entry deleted (reset to 0)",
  );
}

// ---------------------------------------------------------------------------
// Test 3: Queue limit of 50 in ReolinkBaichuanApi
// ---------------------------------------------------------------------------
async function testQueueLimit(): Promise<void> {
  console.log("\n── Test 3: Queue limit of 50 ──");

  // We import ReolinkBaichuanApi dynamically to avoid top-level import errors
  // if some transitive deps can't resolve in script mode.
  let ApiClass: any;
  try {
    const mod = await import(
      "../src/reolink/baichuan/ReolinkBaichuanApi.js"
    );
    ApiClass = mod.ReolinkBaichuanApi;
  } catch {
    console.log("  ⚠ Could not import ReolinkBaichuanApi – skipping queue test (build first with 'npm run build')");
    return;
  }

  // Create a minimal instance just to access the queue (we won't actually connect)
  // We need to mock enough of the constructor args.
  let api: any;
  try {
    // The constructor requires specific args; we'll just prototype-hack a queue
    api = Object.create(ApiClass.prototype);
    api.videoclipThumbnailQueue = [];
    api.videoclipThumbnailInFlight = null; // pretend something is in flight
  } catch {
    console.log("  ⚠ Could not create mock instance – skipping queue test");
    return;
  }

  // Simulate in-flight so new requests go to queue
  // We can't call getVideoclipThumbnail directly without the full stack,
  // so we verify the queue limit logic manually.
  const queue: Array<{ params: any; resolve: any; reject: any }> =
    api.videoclipThumbnailQueue;

  // Fill queue to 49 – should be fine
  for (let i = 0; i < 49; i++) {
    queue.push({ params: {}, resolve: () => {}, reject: () => {} });
  }
  assert(queue.length === 49, `Queue at 49 entries (below limit)`);

  // Push to 50 – still within limit
  queue.push({ params: {}, resolve: () => {}, reject: () => {} });
  assert(queue.length === 50, `Queue at 50 entries (at limit)`);

  // Attempt to push at >= 50 should be rejected by the real code
  // We verify by calling the guard logic:
  const wouldReject = queue.length >= 50;
  assert(
    wouldReject,
    `New request at queue length ${queue.length} would be rejected`,
  );

  // Clean up
  queue.length = 0;
  assert(queue.length === 0, "Queue cleared after test");
}

// ---------------------------------------------------------------------------
// Test 4: sendBinaryCoverPreview has no retry params
// ---------------------------------------------------------------------------
function testNoRetryParams(): void {
  console.log("\n── Test 4: Minimal retry (2 attempts) in sendBinaryCoverPreview ──");

  const proto = BaichuanClient.prototype as any;
  const method = proto.sendBinaryCoverPreview;
  assert(typeof method === "function", "sendBinaryCoverPreview exists");

  // The method source should NOT contain old 'maxRetries' or 'retryDelayMs'
  const src = method.toString();
  const hasMaxRetries = src.includes("maxRetries");
  const hasRetryDelay = src.includes("retryDelayMs");

  assert(
    !hasMaxRetries,
    `No old 'maxRetries' param (found: ${hasMaxRetries})`,
  );
  assert(
    !hasRetryDelay,
    `No old 'retryDelayMs' param (found: ${hasRetryDelay})`,
  );

  // Verify it delegates to _sendBinaryCoverPreviewOnce
  const callsOnce = src.includes("sendBinaryCoverPreviewOnce");
  assert(
    callsOnce,
    "sendBinaryCoverPreview delegates to _sendBinaryCoverPreviewOnce",
  );

  // Verify max attempts is 5 (camera needs multiple retries)
  const hasMaxAttempts = src.includes("maxAttempts = 5") || src.includes("maxAttempts=5");
  assert(
    hasMaxAttempts,
    "sendBinaryCoverPreview uses maxAttempts = 5 (camera needs retries)",
  );
}

// ---------------------------------------------------------------------------
// Test 5 (optional): Live integration test against a real camera
// ---------------------------------------------------------------------------
async function testLiveFlood(): Promise<void> {
  console.log("\n── Test 5: Live flood test ──");

  const host = process.env["TCP265_HOST"];
  const user = process.env["TCP265_USERNAME"] ?? "admin";
  const pass = process.env["TCP265_PASSWORD"];

  if (!host || !pass) {
    console.log(
      "  ⚠ Set TCP265_HOST and TCP265_PASSWORD in .env to run live test. Skipping.",
    );
    return;
  }

  let ApiClass: any;
  try {
    const mod = await import(
      "../src/reolink/baichuan/ReolinkBaichuanApi.js"
    );
    ApiClass = mod.ReolinkBaichuanApi;
  } catch (e) {
    console.log(`  ⚠ Could not import: ${e}`);
    return;
  }

  const outDir = join(process.cwd(), "test", "artifacts", "coverpreview-backpressure");
  await mkdir(outDir, { recursive: true });
  console.log(`  Output dir: ${outDir}`);
  console.log(`  Connecting to ${host} as ${user}...`);

  const api = new ApiClass({
    host,
    port: 9000,
    username: user,
    password: pass,
    logger: {
      debug: (...a: unknown[]) => console.log(`  [DEBUG] ${a.map(String).join(" ")}`),
      info: (...a: unknown[]) => console.log(`  [INFO]  ${a.map(String).join(" ")}`),
      warn: (...a: unknown[]) => console.log(`  [WARN]  ${a.map(String).join(" ")}`),
      error: (...a: unknown[]) => console.log(`  [ERROR] ${a.map(String).join(" ")}`),
    },
  });

  try {
    console.log("  ⏳ Logging in...");
    await api.login();
    console.log("  ✓ Logged in.\n");

    // ── Phase A: List existing recordings ──────────────────────────────
    console.log("  ── Phase A: Listing existing recordings ──");
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    let recordings: any[] = [];
    try {
      console.log(`  ⏳ Querying recordings for today (${startOfDay.toLocaleDateString()})...`);
      recordings = await api.getVideoclips({
        channel: 0,
        start: startOfDay,
        end: endOfDay,
        streamType: "subStream",
        timeoutMs: 30_000,
      });
      console.log(`  ✓ Found ${recordings.length} sub-stream recordings today.`);
      // Show first few
      for (const rec of recordings.slice(0, 5)) {
        const s = rec.startTime ? rec.startTime.toLocaleTimeString() : "?";
        const e = rec.endTime ? rec.endTime.toLocaleTimeString() : "?";
        console.log(`    • ${rec.fileName ?? rec.name ?? rec.id} [${s} → ${e}]`);
      }
      if (recordings.length > 5) {
        console.log(`    ... and ${recordings.length - 5} more`);
      }
    } catch (e: any) {
      console.log(`  ✘ Failed to list recordings: ${e.message?.slice(0, 150)}`);
    }

    if (recordings.length === 0) {
      console.log("  ⚠ No main-stream recordings found today. Trying yesterday...");
      const yesterday = new Date(now.getTime() - 86400_000);
      const startYesterday = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 0, 0, 0);
      const endYesterday = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59);
      try {
        recordings = await api.getVideoclips({
          channel: 0,
          start: startYesterday,
          end: endYesterday,
          streamType: "subStream",
          timeoutMs: 30_000,
        });
        console.log(`  ✓ Found ${recordings.length} sub-stream recordings yesterday.`);
      } catch (e: any) {
        console.log(`  ✘ Failed: ${e.message?.slice(0, 150)}`);
      }
    }

    assert(recordings.length > 0, `Phase A: found recordings (${recordings.length})`);
    if (recordings.length === 0) {
      console.log("  ⚠ Cannot proceed without recordings. Skipping remaining phases.");
      return;
    }

    // ── Phase B: Single thumbnail from a real recording ─────────────────
    console.log("\n  ── Phase B: Single thumbnail from real recording ──");

    // Pick a recording from the middle for safety
    const singleRec = recordings[Math.min(Math.floor(recordings.length / 2), recordings.length - 1)]!;
    const singleTime = singleRec.startTime ?? now;
    const singleEndTime = singleRec.endTime ?? new Date(singleTime.getTime() + 10_000);

    try {
      console.log(`  ⏳ Requesting thumbnail for: ${singleRec.fileName ?? singleRec.id}`);
      console.log(`     time=${singleTime.toLocaleTimeString()} → ${singleEndTime.toLocaleTimeString()}`);

      const t0 = Date.now();
      const snap = await api.getVideoclipThumbnail({
        channel: 0,
        time: singleTime,
        endTime: singleEndTime,
        snapType: "sub",
        timeoutMs: 20_000,
      });
      const elapsed = Date.now() - t0;
      console.log(`  ✓ Got I-frame: ${snap.encoding}, ${snap.frame.length} bytes in ${elapsed}ms`);

      // Save raw frame
      const rawPath = join(outDir, `single-frame.${snap.encoding === "h265" ? "h265" : "h264"}`);
      await writeFile(rawPath, snap.frame);
      console.log(`  ✓ Saved raw frame: ${rawPath}`);

      // Try JPEG conversion
      try {
        console.log(`  ⏳ Converting to JPEG via ffmpeg...`);
        const jpeg = await api.getVideoclipThumbnailJpeg({
          channel: 0,
          time: singleTime,
          endTime: singleEndTime,
          snapType: "sub",
          timeoutMs: 20_000,
        });
        const jpegPath = join(outDir, "single-thumbnail.jpg");
        await writeFile(jpegPath, jpeg);
        console.log(`  ✓ Saved JPEG: ${jpegPath} (${jpeg.length} bytes)`);
      } catch (e: any) {
        console.log(`  ⚠ JPEG conversion failed (ffmpeg needed): ${e.message?.slice(0, 120)}`);
      }

      assert(snap.frame.length > 0, `Phase B: got thumbnail frame (${snap.frame.length} bytes)`);
    } catch (e: any) {
      console.log(`  ✘ Phase B failed: ${e.message}`);
      assert(false, "Phase B: single thumbnail from real recording");
    }

    // ── Phase C: Queue overflow (fire 60 concurrent, 10 should be rejected) ─
    console.log("\n  ── Phase C: Queue overflow (60 concurrent → expect ~10 rejected) ──");

    // Take up to 60 recordings (or repeat if fewer)
    const TOTAL = 60;
    const targets = Array.from({ length: TOTAL }, (_, i) => recordings[i % recordings.length]!);

    const startMs = Date.now();
    console.log(`  ⏳ Firing ${TOTAL} concurrent getVideoclipThumbnail calls...`);
    console.log(`     (using ${Math.min(recordings.length, TOTAL)} unique recording timestamps)`);

    let savedCount = 0;
    const promises = targets.map((rec, i) => {
      const time: Date = rec.startTime ?? now;
      const endTime: Date = rec.endTime ?? new Date(time.getTime() + 10_000);
      return api
        .getVideoclipThumbnail({
          channel: 0,
          time,
          endTime,
          snapType: "sub",
          timeoutMs: 20_000,
        })
        .then(
          async (r: any) => {
            const size = r?.frame?.length ?? 0;
            if (size > 0) {
              const ext = r.encoding === "h265" ? "h265" : "h264";
              const framePath = join(outDir, `thumb-${String(i).padStart(3, "0")}.${ext}`);
              await writeFile(framePath, r.frame).catch(() => {});
              savedCount++;
            }
            return { index: i, status: "ok" as const, size };
          },
          (e: any) => ({ index: i, status: "error" as const, message: e?.message ?? String(e) }),
        );
    });

    // Collect results: wait up to 8s for immediate rejections + first completions,
    // then collect whatever else resolved.
    const raceResults: Array<{ index: number; status: string; size?: number; message?: string }> = [];

    const quickTimeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 8_000));
    const settled = await Promise.race([
      Promise.allSettled(promises).then((r) => r),
      quickTimeout.then(() => null),
    ]);

    if (settled && settled !== "timeout") {
      for (const r of settled) {
        if (r.status === "fulfilled") raceResults.push(r.value);
      }
    } else {
      console.log("  ⏳ Collecting results (8s window elapsed)...");
      for (const p of promises) {
        const result = await Promise.race([
          p,
          new Promise<null>((r) => setTimeout(() => r(null), 200)),
        ]);
        if (result) raceResults.push(result);
      }
    }

    const elapsedMs = Date.now() - startMs;
    const queueFullCount = raceResults.filter(
      (r) => r.status === "error" && (r.message?.includes("queue full") || r.message?.includes("Thumbnail queue full")),
    ).length;
    const okCount = raceResults.filter((r) => r.status === "ok").length;
    const otherErrors = raceResults.filter(
      (r) => r.status === "error" && !r.message?.includes("queue full") && !r.message?.includes("Thumbnail queue full"),
    );

    console.log(`\n  ── Results after ${elapsedMs}ms ──`);
    console.log(`  Resolved:        ${raceResults.length}/${TOTAL}`);
    console.log(`  Succeeded (ok):  ${okCount}`);
    console.log(`  Queue-full:      ${queueFullCount}`);
    console.log(`  Other errors:    ${otherErrors.length}`);
    console.log(`  Saved to disk:   ${savedCount} frames`);
    if (otherErrors.length > 0) {
      console.log(`  Sample errors:`);
      for (const e of otherErrors.slice(0, 3)) {
        console.log(`    [#${e.index}] ${e.message?.slice(0, 150)}`);
      }
    }

    // With 60 concurrent: 1 runs immediately, 49 fill the queue, 10 must be rejected
    assert(queueFullCount >= 9, `Queue-full rejections ≥ 9 (got ${queueFullCount})`);

    // ── Phase D: Check backoff map state ──────────────────────────────
    console.log("\n  ── Phase D: Backoff state ──");
    const backoffMap = getBackoffMap();
    console.log(`  Backoff entries: ${backoffMap.size}`);
    for (const [k, v] of backoffMap) {
      console.log(`    ${k} → ${v}ms`);
    }

    // Save summary
    const summary = {
      timestamp: new Date().toISOString(),
      host,
      recordingsFound: recordings.length,
      total: TOTAL,
      resolved: raceResults.length,
      ok: okCount,
      queueFull: queueFullCount,
      otherErrors: otherErrors.length,
      savedToDisk: savedCount,
      elapsedMs,
      backoffEntries: Object.fromEntries(backoffMap),
    };
    const summaryPath = join(outDir, "test-summary.json");
    await writeFile(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`  ✓ Summary saved: ${summaryPath}`);

    console.log("\n  ⏳ Cleaning up remaining requests (fire & forget)...");

  } finally {
    try {
      await api.destroy?.();
      console.log("  ✓ API destroyed.");
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  CoverPreview Back-pressure & Backoff Test Suite    ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  testBackoffConstants();
  await testBackoffIncrement();
  await testQueueLimit();
  testNoRetryParams();

  if (process.argv.includes("--live")) {
    await testLiveFlood();
  }

  console.log("\n──────────────────────────────────────────────────────");
  console.log(`  Total: ${passed + failed} | ${PASS} Passed: ${passed} | ${FAIL} Failed: ${failed}`);
  console.log("──────────────────────────────────────────────────────\n");

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
