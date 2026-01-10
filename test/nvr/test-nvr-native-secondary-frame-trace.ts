// @ts-expect-error - resolved at runtime from dist output (ESM .js)
import { ReolinkBaichuanApi, type BaichuanFrame } from "../../index.js";
import { config } from "../env.js";
import { createHash } from "node:crypto";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type GroupKey = string;

type GroupStats = {
  cmdId: number;
  msgNum: number;
  streamType: number;
  channelId: number;
  frames: number;
  bodyBytes: number;
  payloadBytes: number;
  firstAtMs: number;
  lastAtMs: number;
  samplePayloadLen?: number;
  samplePayloadSha1_4k?: string;
  samplePayloadPrefixHex16?: string;
};

function sha1Hex(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

function hexPrefix16(data: Uint8Array): string {
  const prefix = data.subarray(0, 16);
  return Buffer.from(prefix).toString("hex");
}

function makeKey(frame: BaichuanFrame): GroupKey {
  return `${frame.header.cmdId}:${frame.header.msgNum}:${frame.header.streamType}:${frame.header.channelId}`;
}

function addFrame(groups: Map<GroupKey, GroupStats>, frame: BaichuanFrame): void {
  const now = Date.now();
  const key = makeKey(frame);
  const existing = groups.get(key);
  if (existing) {
    existing.frames++;
    existing.bodyBytes += frame.body.length;
    existing.payloadBytes += frame.payload.length;
    existing.lastAtMs = now;

    if (existing.samplePayloadSha1_4k === undefined && frame.payload.length > 0) {
      const sample = frame.payload.subarray(0, Math.min(frame.payload.length, 4096));
      existing.samplePayloadLen = frame.payload.length;
      existing.samplePayloadSha1_4k = sha1Hex(sample);
      existing.samplePayloadPrefixHex16 = hexPrefix16(sample);
    }
    return;
  }

  const sample = frame.payload.length > 0 ? frame.payload.subarray(0, Math.min(frame.payload.length, 4096)) : undefined;
  groups.set(key, {
    cmdId: frame.header.cmdId,
    msgNum: frame.header.msgNum,
    streamType: frame.header.streamType,
    channelId: frame.header.channelId,
    frames: 1,
    bodyBytes: frame.body.length,
    payloadBytes: frame.payload.length,
    firstAtMs: now,
    lastAtMs: now,
    samplePayloadLen: frame.payload.length > 0 ? frame.payload.length : undefined,
    samplePayloadSha1_4k: sample ? sha1Hex(sample) : undefined,
    samplePayloadPrefixHex16: sample ? hexPrefix16(sample) : undefined,
  });
}

function printGroups(params: {
  title: string;
  groups: Map<GroupKey, GroupStats>;
  expected?: { msgNum?: number; streamType?: number; channelId?: number };
}): void {
  const { title, groups, expected } = params;

  const list = [...groups.values()].sort((a, b) => b.frames - a.frames);
  console.log(`\n${title}`);
  console.log(`groups=${list.length}`);

  const expectedMsgNum = expected?.msgNum;
  const expectedStreamType = expected?.streamType;
  const expectedChannelId = expected?.channelId;

  for (const g of list.slice(0, 12)) {
    const durMs = Math.max(0, g.lastAtMs - g.firstAtMs);
    const match = [
      expectedMsgNum !== undefined ? g.msgNum === expectedMsgNum : true,
      expectedStreamType !== undefined ? g.streamType === expectedStreamType : true,
      expectedChannelId !== undefined ? g.channelId === expectedChannelId : true,
    ].every(Boolean);

    const flag = match ? " <= expected" : "";
    console.log(
      `  cmdId=${g.cmdId} msgNum=${g.msgNum} streamType=${g.streamType} channelId=${g.channelId} frames=${g.frames} payloadBytes=${g.payloadBytes} durMs=${durMs} sampleLen=${g.samplePayloadLen ?? 0} sampleSha1_4k=${g.samplePayloadSha1_4k ?? "-"} sampleHex16=${g.samplePayloadPrefixHex16 ?? "-"}${flag}`,
    );
  }

  // Highlight any cmdId=3 frames that do NOT match the expected msgNum.
  if (expectedMsgNum !== undefined) {
    const foreign = list.filter((g) => g.cmdId === 3 && g.msgNum !== expectedMsgNum);
    if (foreign.length > 0) {
      console.log(`  note: saw ${foreign.length} other cmdId=3 groups with different msgNum (parallel/old streams?)`);
    }
  }
}

async function captureWindow(params: {
  api: ReolinkBaichuanApi;
  label: string;
  channel: number;
  profile: "main" | "sub";
  variant: "default" | "autotrack" | "telephoto";
  durationMs: number;
}): Promise<void> {
  const { api, label, channel, profile, variant, durationMs } = params;

  // Capture *all* frames (unfiltered) to see what actually arrives on the wire.
  const allCmd3 = new Map<GroupKey, GroupStats>();
  const allOther = new Map<GroupKey, GroupStats>();

  const onFrame = (frame: BaichuanFrame) => {
    if (frame.header.cmdId === 3) addFrame(allCmd3, frame);
    else addFrame(allOther, frame);
  };

  api.client.on("frame", onFrame);
  try {
    console.log(`\n================================================================================`);
    console.log(`CAPTURE: ${label}`);
    console.log(`channel=${channel} profile=${profile} variant=${variant} durationMs=${durationMs}`);

    await api.startVideoStream(channel, profile, variant === "default" ? undefined : { variant });

    const expectedMsgNum = api.getActiveVideoMsgNumWithVariant(channel, profile, variant);
    const expectedStreamType = variant === "default" ? (profile === "sub" ? 1 : 0) : profile === "sub" ? 3 : 2;

    console.log(`expected: msgNum=${expectedMsgNum ?? "(unknown)"} streamType=${expectedStreamType} channelId=${channel}`);

    await sleepMs(durationMs);

    await api.stopVideoStream(channel, profile, variant === "default" ? undefined : { variant });

    const expected: { msgNum?: number; streamType?: number; channelId?: number } = {
      streamType: expectedStreamType,
      channelId: channel,
    };
    if (expectedMsgNum !== undefined) expected.msgNum = expectedMsgNum;

    printGroups({
      title: "RX cmdId=3 groups (raw, before subscription filter)",
      groups: allCmd3,
      expected,
    });

    // Also show a small summary of other cmdIds to detect side-effects (keepalive, channel info, etc).
    const otherByCmd = new Map<number, number>();
    for (const g of allOther.values()) {
      otherByCmd.set(g.cmdId, (otherByCmd.get(g.cmdId) ?? 0) + g.frames);
    }
    const otherList = [...otherByCmd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`\nRX other cmdIds (top): ${otherList.map(([cmdId, n]) => `${cmdId}:${n}`).join(" ") || "(none)"}`);
  } finally {
    api.client.off("frame", onFrame);
  }
}

async function main(): Promise<void> {
  const host = config.nvr.host;
  const username = config.nvr.username;
  const password = config.nvr.password;
  const channel = Number(process.env.NVR_CHANNEL ?? 2);

  if (!host) throw new Error("Missing NVR_HOST in .env");

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    port: 9000,
    transport: "tcp",
    debugOptions: {
      general: true,
      traceStream: true,
    },
    logger: console,
  });

  console.log("================================================================================");
  console.log("TEST: NVR native stream frame-level audit (secondary lens / variant)");
  console.log("================================================================================");
  console.log(`Host: ${host}`);
  console.log(`User: ${username}`);
  console.log(`Channel: ${channel}`);

  await api.login();
  try {
    // Capture sub first (this is the problematic one).
    await captureWindow({
      api,
      label: "WIDE sub (default)",
      channel,
      profile: "sub",
      variant: "default",
      durationMs: Number(process.env.NVR_STREAM_DURATION_MS ?? 2500),
    });

    await sleepMs(250);

    await captureWindow({
      api,
      label: "TELE sub (autotrack)",
      channel,
      profile: "sub",
      variant: "autotrack",
      durationMs: Number(process.env.NVR_STREAM_DURATION_MS ?? 2500),
    });

    await sleepMs(250);

    await captureWindow({
      api,
      label: "TELE sub (telephoto)",
      channel,
      profile: "sub",
      variant: "telephoto",
      durationMs: Number(process.env.NVR_STREAM_DURATION_MS ?? 2500),
    });

    // Also do main quickly, just to compare channelId/msgNum patterns.
    await sleepMs(250);
    await captureWindow({
      api,
      label: "WIDE main (default)",
      channel,
      profile: "main",
      variant: "default",
      durationMs: 1500,
    });

    await sleepMs(250);
    await captureWindow({
      api,
      label: "TELE main (autotrack)",
      channel,
      profile: "main",
      variant: "autotrack",
      durationMs: 1500,
    });
  } finally {
    await api.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
