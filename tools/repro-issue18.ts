/**
 * Repro for issue #18: sleep/awake cycle on battery cameras.
 *
 * Connects to the .env ARGUS_*, subscribes to simple events, then sits
 * idle while logging every incoming frame's cmd_id alongside any
 * sleeping/awake events the lib emits.
 *
 * The point is to see WHAT the camera is pushing every ~60 s that flips
 * the sleep inference back to "awake" — and whether the pushes carry any
 * payload that would let us classify them as non-waking.
 *
 *   ARGUS_HOST=… ARGUS_USERNAME=… ARGUS_PASSWORD=… ARGUS_UID=… \
 *     npx tsx tools/repro-issue18.ts
 */
import * as dotenv from "dotenv";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ReolinkBaichuanApi } from "../src/reolink/baichuan/ReolinkBaichuanApi";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const host = process.env.ARGUS_HOST;
const username = process.env.ARGUS_USERNAME ?? "admin";
const password = process.env.ARGUS_PASSWORD;
const uid = process.env.ARGUS_UID;
if (!host || !password) {
  console.error("Set ARGUS_HOST / ARGUS_USERNAME / ARGUS_PASSWORD / ARGUS_UID");
  process.exit(2);
}

const startedAt = Date.now();
const t = (): string => {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(7);
  return `+${secs}s`;
};

(async () => {
  // Custom logger prefixed with our elapsed time so debug lines align with
  // sleeping/awake events.
  const logger = {
    log: (...args: unknown[]) => console.log(`${t()} [log]`, ...args),
    info: (...args: unknown[]) => console.log(`${t()} [info]`, ...args),
    warn: (...args: unknown[]) => console.log(`${t()} [warn]`, ...args),
    error: (...args: unknown[]) => console.log(`${t()} [err]`, ...args),
    debug: (...args: unknown[]) => console.log(`${t()} [dbg]`, ...args),
  };

  const api = new ReolinkBaichuanApi({
    host,
    port: 9000,
    username,
    password,
    transport: "udp",
    ...(uid ? { uid } : {}),
    debugOptions: { general: true },
    logger: logger as any,
  });

  console.log(`${t()} connecting to ${host}…`);
  await api.login();
  console.log(`${t()} logged in, transport=${api.client.getTransport?.()}`);

  // Tap every incoming Baichuan frame
  api.client.on("push", (frame: any) => {
    const cmdId = frame?.header?.cmdId;
    const rc = frame?.header?.responseCode;
    console.log(
      `${t()}  PUSH cmd_id=${cmdId} responseCode=0x${(rc ?? 0).toString(16)} bodyLen=${frame?.body?.length ?? 0}`,
    );
  });

  // rxHistory/txHistory keep only the last 32 entries (shifted on overflow),
  // so we dedup by `atMs` instead of index.
  let lastRxAtMs = 0;
  let lastTxAtMs = 0;
  setInterval(() => {
    const rx = api.client.getRxHistory();
    const tx = api.client.getTxHistory();
    for (const h of rx) {
      if (h.atMs <= lastRxAtMs) continue;
      console.log(
        `${t()}  RX cmd_id=${h.cmdId} rc=${h.responseCode} msgNum=${h.msgNum} ch=${h.channelId} +${h.atMs - startedAt}ms`,
      );
    }
    for (const h of tx) {
      if (h.atMs <= lastTxAtMs) continue;
      console.log(
        `${t()}  TX cmd_id=${h.cmdId} rc=${h.responseCode} msgNum=${h.msgNum} ch=${h.channelId} +${h.atMs - startedAt}ms`,
      );
    }
    if (rx.length) lastRxAtMs = Math.max(lastRxAtMs, rx[rx.length - 1]!.atMs);
    if (tx.length) lastTxAtMs = Math.max(lastTxAtMs, tx[tx.length - 1]!.atMs);
  }, 500);

  // Also log getSleepStatus return values every 2s so we can correlate
  setInterval(() => {
    const s = api.getSleepStatus();
    console.log(`${t()}  INFER state=${s.state} reason=${s.reason}`);
  }, 2000);

  await api.subscribeEvents();
  console.log(`${t()} subscribed to simple events`);

  api.onSimpleEvent((evt: any) => {
    console.log(`${t()}  EVENT  type=${evt.type} channel=${evt.channel}`);
  });

  console.log(`${t()} now idle — observing for 5 minutes…`);
  await new Promise((r) => setTimeout(r, 5 * 60_000));

  console.log(`${t()} time's up, closing`);
  await api.close().catch(() => {});
})();
