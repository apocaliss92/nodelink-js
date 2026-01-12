#!/usr/bin/env node
/**
 * UDP Sleep Probe (battery cameras, BCUDP).
 *
 * Goals:
 * - Run repeatable sequences (no-login vs login) and measure total time.
 * - Try to minimize “awake time” by closing the connection immediately after reads.
 * - Optionally do a *passive* listen on local BCUDP discovery ports (2015/2018)
 *   to capture any camera/hub broadcasts without sending traffic.
 *
 * Environment:
 * - Uses UDP_SLEEP_* by default (see test/env.ts)
 * - Set SLEEP_TARGET=udp to reuse UDP_* instead.
 *
 * Useful env vars:
 * - SLEEP_TARGET: udpSleep | udp (default: udpSleep)
 * - UDP_CHANNEL: number (default: 0)
 * - PROBE_MODE: listen | no-login | fast | fast+events (default: fast)
 * - PROBE_MODE: events (subscribe only, minimal polling)
 * - PROBE_LISTEN_MS: listen duration for mode=listen (default: 60000)
 * - PROBE_LISTEN_7777: 1 to also bind UDP/7777 in listen mode (default: 0)
 * - PROBE_WAIT_AFTER_CLOSE_MS: wait time after close (default: 30000)
 * - PROBE_MAX_ENC: none | bc | aes | full_aes (default: aes)
 * - PROBE_LOGIN_FALLBACK: 1 to fallback encryption on failure (default: 1)
 * - PROBE_EVENTS_LISTEN_MS: events listen duration (default: 120000)
 * - PROBE_EVENTS_EXIT_ON_PIR: 1 to exit after first PIR/motion event (default: 0)
 * - PROBE_EVENTS_POLL_INTERVAL_MS: if >0, poll getEvents() at this interval (debug; may keep camera awake)
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

import dgram from "node:dgram";
import { performance } from "node:perf_hooks";

// BCUDP discovery ports (used by official clients on LAN).
const BCUDP_DISCOVERY_PORT_LOCAL_ANY = 2015;
const BCUDP_DISCOVERY_PORT_LOCAL_UID = 2018;

// Minimal BCUDP discovery decoding (avoid importing non-exported internals).
const BCUDP_MAGIC_NEGO = 0x2a87cf3a;

// Reolink BCUDP XML crypto (XOR keystream keyed by TID).
const XML_KEY_U32 = Uint32Array.from([
  0x1f2d3c4b, 0x5a6c7f8d, 0x38172e4b, 0x8271635a, 0x863f1a2b, 0xa5c6f7d8, 0x8371e1b4, 0x17f2d3a5,
]);

function* bcudpXmlKeystream(offset: number): Generator<number, void, void> {
  let idx = 0;
  while (true) {
    const word = (XML_KEY_U32[idx % XML_KEY_U32.length]! + (offset >>> 0)) >>> 0;
    yield word & 0xff;
    yield (word >>> 8) & 0xff;
    yield (word >>> 16) & 0xff;
    yield (word >>> 24) & 0xff;
    idx++;
  }
}

function bcudpXmlDecrypt(tid: number, enc: Buffer): Buffer {
  const out = Buffer.allocUnsafe(enc.length);
  const ks = bcudpXmlKeystream(tid >>> 0);
  for (let i = 0; i < enc.length; i++) out[i] = enc[i]! ^ (ks.next().value as number);
  return out;
}

let crcTable: Uint32Array | undefined;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  crcTable = t;
  return t;
}

function bcudpCrc32(buf: Buffer): number {
  const t = getCrcTable();
  let crc = 0x00000000;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    crc = (t[(crc ^ b) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return crc >>> 0;
}

function tryDecodeBcudpDiscovery(buf: Buffer): { tid: number; xml: string } | undefined {
  if (buf.length < 20) return undefined;
  const magic = buf.readUInt32LE(0);
  if (magic !== BCUDP_MAGIC_NEGO) return undefined;
  const payloadSize = buf.readUInt32LE(4);
  const unknownA = buf.readUInt32LE(8);
  if (unknownA !== 1) return undefined;
  const tid = buf.readUInt32LE(12);
  const checksum = buf.readUInt32LE(16);
  const enc = buf.subarray(20);
  if (enc.length < payloadSize) return undefined;
  const encSlice = enc.subarray(0, payloadSize);
  const actual = bcudpCrc32(encSlice);
  if ((checksum >>> 0) !== (actual >>> 0)) return undefined;
  const plain = bcudpXmlDecrypt(tid, encSlice);
  return { tid, xml: plain.toString("utf8") };
}

function tryParseUdp7777(buf: Buffer):
  | { magicLE: number; dataLen: number; seq: number; uid: string; headerLen: number; dataHeadHex: string; dataTailHex: string }
  | undefined {
  if (buf.length < 44) return undefined;
  const magicLE = buf.readUInt32LE(0);
  // We expect the same family magic seen in PCAP: 0x2a87cf32
  if (magicLE !== 0x2a87cf32) return undefined;
  const dataLen = buf.readUInt32LE(4);
  const seq = buf.readUInt32LE(8);
  const headerLen = buf.length - dataLen;
  if (headerLen !== 44) {
    // In captures so far it is always 44; keep strict so we don't mislabel other UDP.
    return undefined;
  }
  const uidRaw = buf.subarray(12, 28);
  const nul = uidRaw.indexOf(0);
  const uid = (nul >= 0 ? uidRaw.subarray(0, nul) : uidRaw).toString("ascii");
  const data = buf.subarray(44);
  const dataHeadHex = data.subarray(0, Math.min(24, data.length)).toString("hex");
  const dataTailHex = data.subarray(Math.max(0, data.length - 16)).toString("hex");
  return { magicLE, dataLen, seq, uid, headerLen, dataHeadHex, dataTailHex };
}

type MaxEncryption = "none" | "bc" | "aes" | "full_aes";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fmtNow(): string {
  return new Date().toISOString();
}

function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function getStringEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw != null && raw.trim() !== "" ? raw : fallback;
}

function log(message: string, data?: unknown): void {
  console.log(`[${fmtNow()}] ${message}`);
  if (data !== undefined) console.log(JSON.stringify(data, null, 2));
}

function redactCfg(cfg: { host: string; username: string; password: string; uid: string }) {
  return {
    host: cfg.host,
    username: cfg.username,
    password: cfg.password ? "***" : "",
    uid: cfg.uid,
  };
}

async function timeIt<T>(label: string, fn: () => Promise<T>): Promise<{ label: string; ok: boolean; ms: number; result?: T; error?: string }> {
  const t0 = performance.now();
  try {
    const result = await fn();
    const ms = Math.round(performance.now() - t0);
    return { label, ok: true, ms, result };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const error = e instanceof Error ? e.message : String(e);
    return { label, ok: false, ms, error };
  }
}

function pickTarget(): { label: string; host: string; username: string; password: string; uid: string } {
  const target = getStringEnv("SLEEP_TARGET", "udpSleep");
  if (target === "udp") {
    return { label: "udp", ...config.udp };
  }
  return { label: "udpSleep", ...config.udpSleep };
}

async function passiveListen(listenMs: number): Promise<void> {
  log(`Passive listen on BCUDP discovery ports for ${listenMs}ms (no TX)`);

  const sockets: dgram.Socket[] = [];

  const bindOne = async (port: number) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sockets.push(sock);

    sock.on("message", (msg, rinfo) => {
      if (port === 7777) {
        const p = tryParseUdp7777(msg);
        if (p) {
          log(`RX udp7777 from=${rinfo.address}:${rinfo.port} len=${msg.length} seq=${p.seq} uid=${p.uid} dataLen=${p.dataLen}`, {
            dataHeadHex: p.dataHeadHex,
            dataTailHex: p.dataTailHex,
          });
          return;
        }
      }

      const disc = tryDecodeBcudpDiscovery(msg);
      if (disc) {
        log(`RX bcudp_discovery port=${port} from=${rinfo.address}:${rinfo.port} tid=${disc.tid}`, {
          xmlPreview: disc.xml.slice(0, 500),
        });
        return;
      }

      // Not a discovery packet; still log a short hexdump preview.
      const preview = msg.subarray(0, Math.min(32, msg.length)).toString("hex");
      log(`RX udp port=${port} from=${rinfo.address}:${rinfo.port} len=${msg.length}`, { hexPreview: preview });
    });

    await new Promise<void>((resolve) => sock.bind(port, "0.0.0.0", () => resolve()));
    log(`Listening on 0.0.0.0:${port}`);
  };

  try {
    await bindOne(BCUDP_DISCOVERY_PORT_LOCAL_ANY);
    await bindOne(BCUDP_DISCOVERY_PORT_LOCAL_UID);

    if (getStringEnv("PROBE_LISTEN_7777", "0") === "1") {
      await bindOne(7777);
    }

    await sleep(listenMs);
  } finally {
    await Promise.allSettled(
      sockets.map(
        (s) =>
          new Promise<void>((resolve) => {
            try {
              s.close(() => resolve());
            } catch {
              resolve();
            }
          })
      )
    );
  }
}

async function probeEventsOnly(target: ReturnType<typeof pickTarget>): Promise<void> {
  const channel = getNumberEnv("UDP_CHANNEL", 0);
  const maxEnc = getStringEnv("PROBE_MAX_ENC", "aes") as MaxEncryption;
  const allowFallback = getStringEnv("PROBE_LOGIN_FALLBACK", "1") !== "0";
  const listenEventsMs = getNumberEnv("PROBE_EVENTS_LISTEN_MS", 120_000);
  const exitOnPir = getStringEnv("PROBE_EVENTS_EXIT_ON_PIR", "0") === "1";
  const pollIntervalMs = getNumberEnv("PROBE_EVENTS_POLL_INTERVAL_MS", 0);

  if (!target.uid) throw new Error(`Missing UID for target=${target.label} (check UDP_SLEEP_UID or UDP_UID)`);

  log(`Starting probe mode=events target=${target.label}`, { target: redactCfg(target), channel, maxEnc, allowFallback, listenEventsMs, exitOnPir });

  const api = new ReolinkBaichuanApi({
    host: target.host || "255.255.255.255",
    username: target.username,
    password: target.password,
    uid: target.uid,
    transport: "udp",
    debugOptions: { general: false },
  });

  const t0 = performance.now();
  let subscribeAtMs: number | undefined;
  let firstMotionAtMs: number | undefined;
  let firstPirAtMs: number | undefined;

  api.client.on("error", (e: Error) => {
    log(`CLIENT error (non-fatal for events probe)`, { message: e?.message ?? String(e) });
  });

  api.client.on("event", (ev: any) => {
    const nowMs = performance.now();
    const type = ev?.type ?? "unknown";
    const source = ev?.motion?.source ?? ev?.motion?.type ?? "";
    if (type === "motion" && firstMotionAtMs === undefined) firstMotionAtMs = nowMs;

    const isPir = type === "motion" && String(source).toLowerCase().includes("pir");
    if (isPir && firstPirAtMs === undefined) firstPirAtMs = nowMs;

    log(`EVENT rx type=${type}${source ? ` source=${source}` : ""}`, ev);

    if (exitOnPir && isPir) {
      log("Exit-on-PIR triggered", {
        sinceStartMs: Math.round(nowMs - t0),
        sinceSubscribeMs: subscribeAtMs !== undefined ? Math.round(nowMs - subscribeAtMs) : undefined,
      });
      api.close().catch(() => undefined);
    }
  });

  try {
    const loginRes = await loginWithOptions(api, maxEnc, allowFallback);
    if (!loginRes.attempts.some((a) => a.ok)) {
      throw new Error(`Login failed for all attempted encryptions: ${loginRes.attempts.map((a) => a.enc).join(", ")}`);
    }

    const sub = await timeIt("subscribeEvents", async () => api.subscribeEvents());
    if (!sub.ok) throw new Error(`subscribeEvents failed: ${sub.error ?? "unknown"}`);
    subscribeAtMs = performance.now();

    let pollTimer: NodeJS.Timeout | undefined;
    let lastPolledEventsJson: string | undefined;
    if (pollIntervalMs > 0) {
      log(`Polling getEvents() every ${pollIntervalMs}ms (debug; may keep camera awake)`);
      pollTimer = setInterval(() => {
        (async () => {
          try {
            const events = await api.getEvents(channel);
            const json = JSON.stringify(events);
            if (json !== lastPolledEventsJson) {
              lastPolledEventsJson = json;
              log("EVENTS poll changed", events);
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log("EVENTS poll error", { message: msg });
          }
        })().catch(() => undefined);
      }, pollIntervalMs);
    }

    log(`Listening for events for ${listenEventsMs}ms (trigger PIR now)`);
    await sleep(listenEventsMs);

    if (pollTimer) clearInterval(pollTimer);
  } finally {
    await api.close().catch(() => undefined);
  }

  log("EVENTS SUMMARY", {
    target: target.label,
    channel,
    firstMotionLatencyMs: firstMotionAtMs !== undefined && subscribeAtMs !== undefined ? Math.round(firstMotionAtMs - subscribeAtMs) : undefined,
    firstPirLatencyMs: firstPirAtMs !== undefined && subscribeAtMs !== undefined ? Math.round(firstPirAtMs - subscribeAtMs) : undefined,
  });
}

async function loginWithOptions(api: ReolinkBaichuanApi, maxEnc: MaxEncryption, allowFallback: boolean): Promise<{ used: MaxEncryption; attempts: Array<{ enc: MaxEncryption; ok: boolean; ms: number; error?: string }> }> {
  const order: MaxEncryption[] = (() => {
    if (!allowFallback) return [maxEnc];

    // Practical heuristic:
    // - If AES works, it can be dramatically faster on some battery cameras.
    // - If AES fails, try full_aes next.
    // - Then degrade to bc/none.
    if (maxEnc === "aes") return ["aes", "full_aes", "bc", "none"];
    if (maxEnc === "full_aes") return ["full_aes", "aes", "bc", "none"];
    if (maxEnc === "bc") return ["bc", "aes", "full_aes", "none"];
    return ["none", "bc", "aes", "full_aes"];
  })();

  const attempts: Array<{ enc: MaxEncryption; ok: boolean; ms: number; error?: string }> = [];

  for (const enc of order) {
    const res = await timeIt(`login(${enc})`, async () => api.login(enc as any));
    attempts.push({ enc, ok: res.ok, ms: res.ms, ...(res.ok ? {} : { error: res.error }) });
    if (res.ok) return { used: enc, attempts };
  }

  // Return last attempt as “used” even if failed; caller will handle.
  return { used: order[order.length - 1]!, attempts };
}

async function probeFast(target: ReturnType<typeof pickTarget>, mode: "fast" | "fast+events"): Promise<void> {
  const channel = getNumberEnv("UDP_CHANNEL", 0);
  const waitAfterCloseMs = getNumberEnv("PROBE_WAIT_AFTER_CLOSE_MS", 30_000);
  const maxEnc = getStringEnv("PROBE_MAX_ENC", "aes") as MaxEncryption;
  const allowFallback = getStringEnv("PROBE_LOGIN_FALLBACK", "1") !== "0";

  if (!target.uid) throw new Error(`Missing UID for target=${target.label} (check UDP_SLEEP_UID or UDP_UID)`);

  log(`Starting probe mode=${mode} target=${target.label}`, { target: redactCfg(target), channel, maxEnc, allowFallback });

  const api = new ReolinkBaichuanApi({
    host: target.host || "255.255.255.255",
    username: target.username,
    password: target.password,
    uid: target.uid,
    transport: "udp",
    debugOptions: { general: false },
  });

  const clientErrors: Array<{ atMs: number; message: string }> = [];
  api.client.on("error", (e: Error) => {
    clientErrors.push({ atMs: Date.now(), message: e?.message ?? String(e) });
    // Do not throw; battery cameras can send D2C_DISC during experimentation.
    log(`CLIENT error (non-fatal for probe)`, { message: e?.message ?? String(e) });
  });

  const debugEvents: Array<{ atMs: number; event: string; data?: unknown }> = [];
  api.client.on("debug", (event: string, data?: unknown) => {
    // Keep it lightweight: store in memory, print summary later.
    debugEvents.push({ atMs: Date.now(), event, data });
  });

  const rxEvents: Array<{ atMs: number; type: string; payload: unknown }> = [];
  api.client.on("event", (ev: any) => {
    rxEvents.push({ atMs: Date.now(), type: ev?.type ?? "unknown", payload: ev });
    log(`EVENT rx type=${ev?.type ?? "unknown"}`, ev);
  });

  const timings: Array<{ label: string; ok: boolean; ms: number; error?: string }> = [];

  try {
    const loginRes = await loginWithOptions(api, maxEnc, allowFallback);
    for (const a of loginRes.attempts) timings.push({ label: `login(${a.enc})`, ok: a.ok, ms: a.ms, ...(a.error ? { error: a.error } : {}) });

    if (!loginRes.attempts.some((a) => a.ok)) {
      throw new Error(`Login failed for all attempted encryptions: ${loginRes.attempts.map((a) => a.enc).join(", ")}`);
    }

    const battery = await timeIt("getBatteryInfo", async () => api.getBatteryInfo(channel));
    timings.push({ label: battery.label, ok: battery.ok, ms: battery.ms, ...(battery.error ? { error: battery.error } : {}) });
    if (battery.ok) log("BatteryInfo", battery.result);

    const pir = await timeIt("getPirInfo", async () => api.getPirInfo(channel));
    timings.push({ label: pir.label, ok: pir.ok, ms: pir.ms, ...(pir.error ? { error: pir.error } : {}) });
    if (pir.ok) log("PirInfo", pir.result);

    const events = await timeIt("getEvents", async () => api.getEvents(channel));
    timings.push({ label: events.label, ok: events.ok, ms: events.ms, ...(events.error ? { error: events.error } : {}) });
    if (events.ok) log("Events (motion/AI/visitor)", events.result);

    const motionEnabled = await timeIt("getMotionState(enabled)", async () => api.getMotionState(channel));
    timings.push({ label: motionEnabled.label, ok: motionEnabled.ok, ms: motionEnabled.ms, ...(motionEnabled.error ? { error: motionEnabled.error } : {}) });
    if (motionEnabled.ok) log("MotionEnabled", motionEnabled.result);

    if (mode === "fast+events") {
      const sub = await timeIt("subscribeEvents", async () => api.subscribeEvents());
      timings.push({ label: sub.label, ok: sub.ok, ms: sub.ms, ...(sub.error ? { error: sub.error } : {}) });
      if (sub.ok) {
        const listenEventsMs = getNumberEnv("PROBE_EVENTS_LISTEN_MS", 10_000);
        log(`Listening for events for ${listenEventsMs}ms (try triggering PIR now)`);
        await sleep(listenEventsMs);
      }
    }
  } finally {
    const closeRes = await timeIt("close", async () => api.close());
    timings.push({ label: closeRes.label, ok: closeRes.ok, ms: closeRes.ms, ...(closeRes.error ? { error: closeRes.error } : {}) });
  }

  // Wait for camera to re-enter sleep (best-effort, we do not actively verify to avoid waking it).
  log(`Waiting ${waitAfterCloseMs}ms after close (camera should go back to sleep)`);
  await sleep(waitAfterCloseMs);

  const totalMs = timings.reduce((sum, t) => sum + t.ms, 0);

  log("SUMMARY", {
    target: target.label,
    channel,
    totalMeasuredMs: totalMs,
    timings,
    rxEventsCount: rxEvents.length,
    debugEventsCount: debugEvents.length,
    clientErrorsCount: clientErrors.length,
    clientErrors: clientErrors.slice(-5),
    note:
      "TotalMeasuredMs is the sum of step durations (not perfectly wall-clock). Use timings[] for per-step latency.",
  });
}

async function probeNoLogin(target: ReturnType<typeof pickTarget>): Promise<void> {
  const channel = getNumberEnv("UDP_CHANNEL", 0);
  const waitAfterCloseMs = getNumberEnv("PROBE_WAIT_AFTER_CLOSE_MS", 30_000);

  if (!target.uid) throw new Error(`Missing UID for target=${target.label} (check UDP_SLEEP_UID or UDP_UID)`);

  log(`Starting probe mode=no-login target=${target.label}`, { target: redactCfg(target), channel });

  const api = new ReolinkBaichuanApi({
    host: target.host || "255.255.255.255",
    username: target.username,
    password: target.password,
    uid: target.uid,
    transport: "udp",
    debugOptions: { general: false },
  });

  const clientErrors: Array<{ atMs: number; message: string }> = [];
  api.client.on("error", (e: Error) => {
    clientErrors.push({ atMs: Date.now(), message: e?.message ?? String(e) });
    log(`CLIENT error (non-fatal for probe)`, { message: e?.message ?? String(e) });
  });

  const timings: Array<{ label: string; ok: boolean; ms: number; error?: string; responseCode?: number }> = [];

  try {
    // IMPORTANT: do NOT call api.sendXml()/api.getBatteryInfo()/api.getPirInfo() here.
    // Those call api.client.login() automatically.

    const connectRes = await timeIt("client.connect (no-login)", async () => api.client.connect());
    timings.push({ label: connectRes.label, ok: connectRes.ok, ms: connectRes.ms, ...(connectRes.error ? { error: connectRes.error } : {}) });

    const tryCmd = async (cmdId: number, label: string) => {
      const res = await timeIt(label, async () => {
        const frame = await api.client.sendFrame({ cmdId, channel, timeoutMs: 5000, encryption: { kind: "none" } as any });
        return { responseCode: frame.header.responseCode, bodyLen: frame.body.length };
      });
      const responseCode = (res.result as any)?.responseCode;
      timings.push({
        label: res.label,
        ok: res.ok,
        ms: res.ms,
        ...(res.error ? { error: res.error } : {}),
        ...(typeof responseCode === "number" ? { responseCode } : {}),
      });
      if (res.ok) log(`No-login response ${label}`, res.result);
    };

    // Candidate commands (may be rejected without login; we still measure the behavior).
    await tryCmd(253, "cmd253 getBatteryInfo (no-login, enc=none)");
    await tryCmd(212, "cmd212 getPirInfo (no-login, enc=none)");
    await tryCmd(46, "cmd46 getMotionState (no-login, enc=none)");
  } finally {
    const closeRes = await timeIt("close", async () => api.close());
    timings.push({ label: closeRes.label, ok: closeRes.ok, ms: closeRes.ms, ...(closeRes.error ? { error: closeRes.error } : {}) });
  }

  log(`Waiting ${waitAfterCloseMs}ms after close (camera should go back to sleep)`);
  await sleep(waitAfterCloseMs);

  log("SUMMARY", { target: target.label, channel, timings, clientErrorsCount: clientErrors.length, clientErrors: clientErrors.slice(-5) });
}

async function main(): Promise<void> {
  const target = pickTarget();
  const mode = getStringEnv("PROBE_MODE", "fast");

  if (!target.host) {
    log(
      `WARNING: target host is empty for ${target.label}; discovery will likely use broadcast (255.255.255.255). ` +
        `Set UDP_SLEEP_HOST / UDP_HOST for direct unicast.`
    );
  }

  if (mode === "listen") {
    const listenMs = getNumberEnv("PROBE_LISTEN_MS", 60_000);
    await passiveListen(listenMs);
    return;
  }

  if (mode === "no-login") {
    await probeNoLogin(target);
    return;
  }

  if (mode === "fast") {
    await probeFast(target, "fast");
    return;
  }

  if (mode === "fast+events") {
    await probeFast(target, "fast+events");
    return;
  }

  if (mode === "events") {
    await probeEventsOnly(target);
    return;
  }

  throw new Error(`Unknown PROBE_MODE=${mode}. Expected: listen | no-login | fast | fast+events | events`);
}

main().catch((e) => {
  console.error("\n[FATAL]", e);
  process.exit(1);
});
