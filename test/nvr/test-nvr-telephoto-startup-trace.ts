#!/usr/bin/env node
/**
 * NVR test: measure telephoto MAIN startup latency and inspect early cmd_id=3 frames.
 *
 * Goal:
 * - quantify where time is spent (startVideoStream response vs first media vs first keyframe)
 * - inspect the first frames to see if BcMedia magic is offset (e.g. constant 528 bytes)
 * - help iterate on parser alignment/recovery.
 *
 * Env:
 * - NVR_HOST, NVR_USERNAME, NVR_PASSWORD (required)
 * - NVR_CHANNEL (optional, default 2)
 * - NVR_DURATION_MS (optional, default 20000)
 * - NVR_PROFILE (optional, main|sub, default main)
 * - NVR_VARIANT (optional, default telephoto)
 */

// @ts-expect-error - resolved at runtime from dist output (ESM .js)
import { ReolinkBaichuanApi, BaichuanVideoStream, type BaichuanFrame } from "../../index.js";
import { config } from "../env.js";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs(): number {
  return Date.now();
}

function fmtMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function findFirstKnownMagicOffset(buf: Buffer, maxScan = 4096): number {
  const isKnownMagic = (magic: number): boolean => {
    const isInfoV1 = magic === 0x31303031; // "1001" LE
    const isInfoV2 = magic === 0x32303031; // "2001" LE
    const isIFrame = magic >= 0x63643030 && magic <= 0x63643039; // "cd00".."cd09" LE
    const isPFrame = magic >= 0x63643130 && magic <= 0x63643139; // "cd10".."cd19" LE
    const isAac = magic === 0x62773530; // "bw50" LE
    const isAdpcm = magic === 0x62773130; // "bw10" LE
    return isInfoV1 || isInfoV2 || isIFrame || isPFrame || isAac || isAdpcm;
  };

  const lim = Math.min(buf.length - 4, maxScan);
  for (let i = 0; i <= lim; i++) {
    const m = buf.readUInt32LE(i);
    if (isKnownMagic(m)) return i;
  }
  return -1;
}

async function main(): Promise<void> {
  const host = process.env.NVR_HOST || config.nvr.host;
  const username = process.env.NVR_USERNAME || config.nvr.username;
  const password = process.env.NVR_PASSWORD || config.nvr.password;

  if (!host) throw new Error("Missing NVR_HOST");
  if (!username) throw new Error("Missing NVR_USERNAME");
  if (!password) throw new Error("Missing NVR_PASSWORD");

  const channel = Number(process.env.NVR_CHANNEL ?? 2);
  const profile = (process.env.NVR_PROFILE ?? "main") as "main" | "sub";
  const variant = (process.env.NVR_VARIANT ?? "telephoto") as "default" | "autotrack" | "telephoto";
  const durationMs = Number(process.env.NVR_DURATION_MS ?? 20000);

  console.log("================================================================================");
  console.log("NVR telephoto startup trace");
  console.log(JSON.stringify({ host, channel, profile, variant, durationMs }, null, 2));

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    uid: config.nvr.uid || undefined,
    logger: console,
    transport: "tcp",
    debugOptions: {
      // Keep logs manageable; you can toggle these if needed.
      debugRtsp: false,
      traceNativeStream: false,
      general: false,
    },
  });

  await api.login();
  await api.subscribeToAllEvents();

  // Best-effort: stop old streams.
  try {
    await api.stopVideoStream(channel, profile, { variant: "default" });
  } catch {
    // ignore
  }
  for (const v of ["autotrack", "telephoto"] as const) {
    try {
      await api.stopVideoStream(channel, profile, { variant: v });
    } catch {
      // ignore
    }
  }

  await sleepMs(150);

  let firstCmd3At: number | undefined;
  let firstCmd3Dumped = 0;
  const maxFrameDumps = 20;

  const startAt = nowMs();

  const onFrame = (frame: BaichuanFrame) => {
    if (frame.header.cmdId !== 3) return;

    if (firstCmd3At === undefined) {
      firstCmd3At = nowMs();
      console.log(`[trace] first cmd_id=3 push seen at +${fmtMs(firstCmd3At - startAt)} (msgNum=${frame.header.msgNum} streamType=${frame.header.streamType} channelId=${frame.header.channelId})`);
    }

    if (firstCmd3Dumped < maxFrameDumps) {
      firstCmd3Dumped++;
      const raw = frame.payload.length > 0 ? frame.payload : frame.body;
      const off = findFirstKnownMagicOffset(raw);
      const prefix = raw.subarray(0, Math.min(32, raw.length)).toString("hex");
      const magicPrefix = off >= 0 ? raw.subarray(off, Math.min(off + 16, raw.length)).toString("hex") : "-";

      console.log(
        `[cmd3 #${firstCmd3Dumped}] +${fmtMs(nowMs() - startAt)} msgNum=${frame.header.msgNum} streamType=${frame.header.streamType} ` +
          `bodyLen=${frame.body.length} payloadLen=${frame.payload.length} payloadOffset=${frame.header.payloadOffset ?? "?"} ` +
          `firstKnownMagicOffset=${off} prefix32=${prefix} magic16=${magicPrefix}`,
      );
    }
  };

  api.client.on("frame", onFrame);

  // Use BaichuanVideoStream to detect first access unit / keyframe.
  const stream = new BaichuanVideoStream({
    client: api.client,
    api,
    channel,
    profile,
    variant,
    logger: console,
  });

  let firstAuAt: number | undefined;
  let firstKeyframeAt: number | undefined;

  stream.on("videoAccessUnit", (au: { data: Buffer; isKeyframe: boolean; videoType: "H264" | "H265" }) => {
    if (firstAuAt === undefined) {
      firstAuAt = nowMs();
      console.log(`[trace] first access unit at +${fmtMs(firstAuAt - startAt)} (videoType=${au.videoType} key=${au.isKeyframe} len=${au.data.length})`);
    }
    if (au.isKeyframe && firstKeyframeAt === undefined) {
      firstKeyframeAt = nowMs();
      console.log(`[trace] first keyframe at +${fmtMs(firstKeyframeAt - startAt)} (videoType=${au.videoType} len=${au.data.length})`);
    }
  });
  stream.on("error", (e: unknown) => {
    console.warn("[stream error]", e);
  });

  const startPromise = stream.start();

  // Wait a bit and print whether start() has resolved (useful to see if startVideoStream response is slow).
  await sleepMs(1000);
  console.log(`[trace] +${fmtMs(nowMs() - startAt)} start() resolved? (pending)`);

  await Promise.race([startPromise.then(() => "resolved" as const), sleepMs(durationMs).then(() => "timeout" as const)]).then((r) => {
    if (r === "resolved") {
      console.log(`[trace] stream.start() resolved at +${fmtMs(nowMs() - startAt)}`);
    }
  });

  await sleepMs(Math.max(0, durationMs - (nowMs() - startAt)));

  console.log("\nSUMMARY");
  console.log(
    JSON.stringify(
      {
        startAt,
        firstCmd3AtDeltaMs: firstCmd3At ? firstCmd3At - startAt : null,
        firstAuAtDeltaMs: firstAuAt ? firstAuAt - startAt : null,
        firstKeyframeAtDeltaMs: firstKeyframeAt ? firstKeyframeAt - startAt : null,
      },
      null,
      2,
    ),
  );

  api.client.off("frame", onFrame);

  try {
    await stream.stop();
  } catch {
    // ignore
  }
  try {
    await api.stopVideoStream(channel, profile, variant === "default" ? undefined : { variant });
  } catch {
    // ignore
  }

  await api.client.close({ reason: "startup-trace done" });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
