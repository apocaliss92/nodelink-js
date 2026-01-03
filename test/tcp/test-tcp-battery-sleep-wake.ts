#!/usr/bin/env node
/**
 * Integration test for battery cameras sleep/wake behavior.
 *
 * Goal:
 * - Verify that GetBatteryInfo (cmd 253) is a non-waking command: if the camera is sleeping,
 *   the request should time out and should NOT wake the camera.
 * - Verify that a "hard wake" (GetEnc / cmd 56 via wakeUp()) wakes the camera and then
 *   GetBatteryInfo succeeds.
 *
 * Notes:
 * - This is highly device/firmware dependent.
 * - You typically need to let the camera go to sleep first. Use BATTERY_WAIT_FOR_SLEEP_MS.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

type BaichuanFrameLike = {
  header: {
    responseCode: number;
  };
  body: {
    length: number;
  };
};

function log(message: string, data?: unknown) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[INFO] ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
  console.log("=".repeat(60));
}

function logSuccess(message: string) {
  console.log(`\n[OK] ${message}`);
}

function logWarn(message: string) {
  console.warn(`\n[WARN] ${message}`);
}

function logError(message: string, error: unknown) {
  console.error(`\n[ERROR] ${message}`);
  if (error instanceof Error) {
    console.error(`   Message: ${error.message}`);
  } else {
    console.error(`   Details: ${error}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout (${label}) after ${ms}ms`)), ms);
    }),
  ]);
}

async function runBatterySleepWakeTest() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║   TCP BATTERY SLEEP/WAKE TEST - REOLINK BAICHUAN          ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  const channel = Number(process.env.BATTERY_CHANNEL ?? "0");
  const waitForSleepMs = Number(process.env.BATTERY_WAIT_FOR_SLEEP_MS ?? "0");
  const nonWakeTimeoutMs = Number(process.env.BATTERY_NON_WAKE_TIMEOUT_MS ?? "5000");
  const wakeTimeoutMs = Number(process.env.BATTERY_WAKE_TIMEOUT_MS ?? "30000");
  const wakeWaitAfterMs = Number(process.env.BATTERY_WAKE_WAIT_AFTER_MS ?? "5000");

  const batteryHost = process.env.BATTERY_HOST ?? config.tcp.host;
  const batteryUsername = process.env.BATTERY_USERNAME ?? config.tcp.username;
  const batteryPassword = process.env.BATTERY_PASSWORD ?? config.tcp.password;
  const batteryUid = process.env.BATTERY_UID;
  const batteryTransport = (process.env.BATTERY_TRANSPORT as "tcp" | "udp" | "auto" | undefined) ?? "tcp";

  console.log(`\nConfiguration:`);
  console.log(`  Host: ${batteryHost}`);
  console.log(`  Username: ${batteryUsername}`);
  console.log(`  Channel: ${channel}`);
  console.log(`  WaitForSleep: ${waitForSleepMs}ms`);
  console.log(`  Transport: ${batteryTransport}`);
  if (batteryTransport !== "tcp") {
    console.log(`  UID: ${batteryUid ? "(set)" : "(missing)"}`);
  }

  if (batteryTransport !== "tcp" && !batteryUid) {
    logError(
      "BATTERY_UID is required for BATTERY_TRANSPORT=udp/auto (BCUDP discovery)",
      "Set BATTERY_UID or force BATTERY_TRANSPORT=tcp",
    );
    return false;
  }

  const api = new ReolinkBaichuanApi({
    host: batteryHost,
    username: batteryUsername,
    password: batteryPassword,
    uid: batteryUid,
    transport: batteryTransport,
    debugOptions: { general: true },
  });

  api.client.on("error", (err: any) => {
    console.error("Client error:", err);
  });

  try {
    log("Test 1: Login TCP");
    await api.login();
    logSuccess("TCP login succeeded");

    if (waitForSleepMs > 0) {
      log(`Waiting ${waitForSleepMs}ms for the camera to go to sleep (no traffic)...`);
      await sleep(waitForSleepMs);
      logSuccess("Wait complete");
    } else {
      logWarn(
        "BATTERY_WAIT_FOR_SLEEP_MS=0: if the camera is currently awake, this test may fail to verify non-waking behavior.",
      );
    }

    // ========== TEST 2: NON-WAKING BATTERY INFO ==========
    // Important: do NOT use api.getBatteryInfo()/sendXml here because sendXml has built-in retries/re-login
    // which makes timing-based assertions noisy and can create extra traffic.
    async function sendBatteryInfoOnce(label: string) {
      const frame = (await withTimeout(
        api.client.sendFrame({ cmdId: 253, channel }) as Promise<BaichuanFrameLike>,
        nonWakeTimeoutMs,
        label,
      )) as BaichuanFrameLike;
      return {
        responseCode: frame.header.responseCode,
        bodyLen: frame.body.length,
      };
    }

    log("Test 2: single-shot BatteryInfo (cmd 253) while camera should be sleeping");
    const b1 = await sendBatteryInfoOnce("BatteryInfo cmd 253 #1");
    log("BatteryInfo #1 reply", b1);

    if (b1.responseCode === 200) {
      logWarn(
        "BatteryInfo returned responseCode=200 immediately. Camera appears awake; let it sleep and retry (increase BATTERY_WAIT_FOR_SLEEP_MS).",
      );
      await api.close();
      return false;
    }

    logSuccess("Camera did not return BatteryInfo (200) while sleeping (expected for non-waking command)");

    await sleep(500);

    log("Test 3: single-shot BatteryInfo again (should still NOT wake the camera)");
    const b2 = await sendBatteryInfoOnce("BatteryInfo cmd 253 #2");
    log("BatteryInfo #2 reply", b2);

    if (b2.responseCode === 200) {
      logError(
        "BatteryInfo #2 unexpectedly returned 200. This suggests cmd 253 may have woken the camera (should be non-waking).",
        b2,
      );
      await api.close();
      return false;
    }

    logSuccess("Second BatteryInfo attempt still not 200 (supports non-waking behavior)");

    // ========== TEST 4: HARD WAKE + BATTERY INFO ==========
    log("Test 4: wakeUp() (hard wake via GetEnc)");
    await api.wakeUp(channel, wakeWaitAfterMs);
    logSuccess("wakeUp() sent");

    log("Test 5: Poll BatteryInfo cmd 253 until responseCode=200 (camera fully awake)");
    const startWakePoll = Date.now();
    let saw200 = false;
    let lastReply: { responseCode: number; bodyLen: number } | undefined;

    while (Date.now() - startWakePoll < wakeTimeoutMs) {
      try {
        lastReply = await sendBatteryInfoOnce("BatteryInfo cmd 253 after wake");
        if (lastReply.responseCode === 200) {
          saw200 = true;
          break;
        }
      } catch (e) {
        lastReply = undefined;
      }
      await sleep(1000);
    }

    if (!saw200) {
      logError(
        "BatteryInfo cmd 253 never returned responseCode=200 after wakeUp().",
        {
          lastReply,
          possibleCauses: [
            "The target is not a battery camera (cmd 253 not supported)",
            "The camera still isn't fully awake (increase BATTERY_WAKE_WAIT_AFTER_MS / BATTERY_WAKE_TIMEOUT_MS)",
            "If this is a battery cam: try BATTERY_TRANSPORT=udp with BATTERY_UID",
          ],
        },
      );
      await api.close();
      return false;
    }

    logSuccess("BatteryInfo cmd 253 returned 200 after wake");

    log("Test 6: GetBatteryInfo (parse batteryPercent)");
    let batteryInfo:
      | Awaited<ReturnType<ReolinkBaichuanApi["getBatteryInfo"]>>
      | undefined;
    try {
      batteryInfo = await withTimeout(api.getBatteryInfo(channel), 10_000, "GetBatteryInfo parse");
    } catch (e) {
      logError("GetBatteryInfo (parse) failed after cmd 253 returned 200", e);
      await api.close();
      return false;
    }

    if (!batteryInfo) {
      logError("GetBatteryInfo returned no data", null);
      await api.close();
      return false;
    }

    log("BatteryInfo after wake", batteryInfo);

    if (typeof batteryInfo.batteryPercent !== "number") {
      logError("batteryPercent missing after wake", batteryInfo);
      await api.close();
      return false;
    }

    logSuccess(`Battery percent: ${batteryInfo.batteryPercent}%`);
    await api.close();
    logSuccess("TCP connection closed");

    return true;
  } catch (error) {
    logError("Error while running Battery sleep/wake test", error);
    try {
      await api.close();
    } catch {
      // ignore
    }
    return false;
  }
}

runBatterySleepWakeTest()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    logError("Fatal error", error);
    process.exit(1);
  });
