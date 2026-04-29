/* eslint-disable no-console */
/**
 * Local reproduction of issue #13 follow-up: streams must come back up after
 * a transient camera disconnect. Exercises both restreamer modes against the
 * wired TCP camera defined in .env (TCP_HOST).
 *
 * Flow:
 *   1. Bootstrap a temp DATA_PATH with a single-camera settings.json
 *   2. Import rtsp-manager (loads settings)
 *   3. Connect → expect streams running
 *   4. Force socket close on api.client → close handler should mark
 *      rtspServers entries as "stopped" synchronously and await cleanup
 *   5. Re-call getOrCreateApiConnection (simulates watchdog) → onApiConnected
 *      listener should restart streams
 *
 * Usage:
 *   MODE=go2rtc npx tsx test/_scratch/reconnect-repro.ts
 *   MODE=local  npx tsx test/_scratch/reconnect-repro.ts
 */

import "dotenv/config";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// Mirror the production server's unhandled-error handlers so we don't crash
// on transient ECONNRESET from pooled sockets (which the production server.ts
// already swallows via process.on("uncaughtException")).
process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.warn(`[repro] uncaughtException swallowed: ${err.message}`);
});
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.warn(`[repro] unhandledRejection swallowed: ${String(reason)}`);
});

const MODE = (process.env.MODE === "local" ? "local" : "go2rtc") as
  | "go2rtc"
  | "local";

const HOST = process.env.TCP_HOST;
const USER = process.env.TCP_USERNAME ?? "admin";
const PASS = process.env.TCP_PASSWORD ?? "";

if (!HOST) {
  console.error("TCP_HOST missing in .env");
  process.exit(1);
}

// ---- bootstrap temp DATA_PATH BEFORE importing rtsp-manager ----
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reconnect-repro-"));
process.env.DATA_PATH = dataDir;
console.log(`DATA_PATH=${dataDir}`);

const camId = crypto.randomUUID();
const settings = {
  restreamer: MODE,
  go2rtc: {
    apiPort: 21984,
    rtspPort: 28554,
    webrtcPort: 28555,
  },
  localRtsp: { port: 28554, bindHost: "127.0.0.1" },
  cameras: [
    {
      id: camId,
      name: "repro-cam",
      host: HOST,
      port: 9000,
      username: USER,
      password: PASS,
      transport: "tcp",
      autoStart: true,
      isBattery: false,
      rtspChannel: 0,
      rtspProfile: "main",
      rtspStreams: [
        { profile: "main", channel: 0, port: 0, token: "x", enabled: true, autoStart: true },
        { profile: "sub", channel: 0, port: 0, token: "y", enabled: true, autoStart: true },
      ],
    },
  ],
};

fs.writeFileSync(
  path.join(dataDir, "settings.json"),
  JSON.stringify(settings, null, 2),
);

// ---- now import the modules ----
async function main(): Promise<void> {
  const rtspMgr = await import("../../app/src/rtsp-manager.js");
  const go2rtc = await import("../../app/src/go2rtc-manager.js");
  const store = await import("../../app/src/settings-store.js");

  store.loadSettings();

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  if (MODE === "go2rtc") {
    console.log("Starting go2rtc sidecar...");
    await go2rtc.initGo2rtc({
      apiPort: 21984,
      rtspPort: 28554,
      webrtcPort: 28555,
    });
    console.log("go2rtc started");
  } else {
    await rtspMgr.ensureLocalRtspMux();
    console.log("Local RTSP mux started");
  }

  rtspMgr.enableAutoStreamsOnConnect();

  // 1. Initial connect
  console.log("\n=== STEP 1: initial connect ===");
  const api1 = await rtspMgr.getOrCreateApiConnection(camId);
  console.log(`API connected: isReady=${api1.isReady}`);
  await wait(8_000); // let listener start streams

  let infos = rtspMgr.getAllRtspServersInfo();
  console.log("After connect:");
  for (const info of infos) {
    console.log(`  ${info.profile}/ch${info.channel} → ${info.status}  startedAt=${info.startedAt?.toISOString() ?? "?"}`);
  }
  const runningBefore = infos.filter((i) => i.status === "running").length;
  // Snapshot the original startedAt timestamps so we can detect whether the
  // listener actually restarted the streams (fresh startedAt) or just left
  // the stale "running" entries in place.
  const startedAtBefore = new Map(
    infos.map((i) => [`${i.profile}:${i.channel}`, i.startedAt?.getTime() ?? 0]),
  );

  // 2. Force socket close (simulate WiFi drop / scheduled reboot)
  console.log("\n=== STEP 2: force socket close ===");
  await api1.client.close();
  console.log("Socket closed; waiting 5s for close handler + cleanup");
  await wait(5_000);

  infos = rtspMgr.getAllRtspServersInfo();
  console.log("After close:");
  for (const info of infos) {
    console.log(`  ${info.profile}/ch${info.channel} → ${info.status}`);
  }

  // 3. Reconnect (mimics reconnect watchdog tick)
  console.log("\n=== STEP 3: reconnect (watchdog simulation) ===");
  const api2 = await rtspMgr.getOrCreateApiConnection(camId);
  console.log(`Reconnected: isReady=${api2.isReady} sameInstance=${api1 === api2}`);
  await wait(10_000); // wait for listener to restart streams

  infos = rtspMgr.getAllRtspServersInfo();
  console.log("After reconnect:");
  let restartedCount = 0;
  for (const info of infos) {
    const before = startedAtBefore.get(`${info.profile}:${info.channel}`) ?? 0;
    const after = info.startedAt?.getTime() ?? 0;
    const restarted = after > before;
    if (restarted) restartedCount++;
    console.log(
      `  ${info.profile}/ch${info.channel} → ${info.status}  startedAt=${info.startedAt?.toISOString() ?? "?"}  restarted=${restarted}`,
    );
  }
  const runningAfter = infos.filter((i) => i.status === "running").length;

  // 4. Cleanup
  console.log("\n=== STEP 4: cleanup ===");
  await rtspMgr.stopAllRtspServers();
  await rtspMgr.closeApiConnection(camId);
  if (MODE === "go2rtc") await go2rtc.stopGo2rtc();

  console.log("\n" + "=".repeat(50));
  console.log(`MODE=${MODE}`);
  console.log(`Streams running before close:        ${runningBefore}`);
  console.log(`Streams running after reconnect:     ${runningAfter}`);
  console.log(`Streams *actually* restarted:        ${restartedCount}`);
  const ok = restartedCount > 0 && restartedCount >= runningBefore;
  console.log(
    ok
      ? "RESULT: PASS — listener restarted streams on reconnect"
      : "RESULT: FAIL — listener did NOT restart streams (entries are stale)",
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("Crashed:", e);
  process.exit(1);
});
