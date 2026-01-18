// @ts-expect-error - resolved at runtime from dist output (ESM .js)
import { ReolinkBaichuanApi, type BaichuanFrame } from "../../index.js";
import type { ReolinkSupportedStream } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { config } from "../env.js";
import { createHash } from "node:crypto";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type GroupKey = string;

const MIN_SAMPLE_PAYLOAD_BYTES = 512;

type NativeVariant = "default" | "autotrack" | "telephoto";

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

    if (existing.samplePayloadSha1_4k === undefined && frame.payload.length >= MIN_SAMPLE_PAYLOAD_BYTES) {
      const sample = frame.payload.subarray(0, Math.min(frame.payload.length, 4096));
      existing.samplePayloadLen = frame.payload.length;
      existing.samplePayloadSha1_4k = sha1Hex(sample);
      existing.samplePayloadPrefixHex16 = hexPrefix16(sample);
    }
    return;
  }

  const base: GroupStats = {
    cmdId: frame.header.cmdId,
    msgNum: frame.header.msgNum,
    streamType: frame.header.streamType,
    channelId: frame.header.channelId,
    frames: 1,
    bodyBytes: frame.body.length,
    payloadBytes: frame.payload.length,
    firstAtMs: now,
    lastAtMs: now,
  };

  if (frame.payload.length >= MIN_SAMPLE_PAYLOAD_BYTES) {
    const sample = frame.payload.subarray(0, Math.min(frame.payload.length, 4096));
    base.samplePayloadLen = frame.payload.length;
    base.samplePayloadSha1_4k = sha1Hex(sample);
    base.samplePayloadPrefixHex16 = hexPrefix16(sample);
  }

  groups.set(key, base);
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

type TargetStream = {
  id: string;
  lens: "wide" | "telephoto";
  profile: "main" | "sub";
  variant: NativeVariant;
};

type CapturedTarget = {
  target: TargetStream;
  expectedMsgNum?: number;
  expectedStreamType: number;
  expectedGroup?: GroupStats;
};

function expectedStreamTypeFor(profile: "main" | "sub", variant: NativeVariant): number {
  if (variant === "default") return profile === "sub" ? 1 : 0;
  return profile === "sub" ? 3 : 2;
}

function sameHash(a?: string, b?: string): boolean {
  return typeof a === "string" && typeof b === "string" && a.length > 0 && a === b;
}

function must<T>(v: T | undefined, msg: string): T {
  if (v === undefined) throw new Error(msg);
  return v;
}

function findBestExpectedGroup(params: {
  groups: Map<GroupKey, GroupStats>;
  expected: { msgNum?: number; streamType: number; channelId: number };
}): GroupStats | undefined {
  const { groups, expected } = params;
  const list = [...groups.values()]
    .filter((g) => g.cmdId === 3)
    .filter((g) => g.channelId === expected.channelId)
    .filter((g) => g.streamType === expected.streamType)
    .filter((g) => (expected.msgNum !== undefined ? g.msgNum === expected.msgNum : true))
    .sort((a, b) => b.frames - a.frames);
  return list[0];
}

async function captureConcurrent(params: {
  api: ReolinkBaichuanApi;
  channel: number;
  durationMs: number;
  targets: TargetStream[];
}): Promise<CapturedTarget[]> {
  const { api, channel, durationMs, targets } = params;

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
    console.log(`CAPTURE: concurrent native streams`);
    console.log(`channel=${channel} durationMs=${durationMs}`);
    for (const t of targets) {
      console.log(`  target: id=${t.id} lens=${t.lens} profile=${t.profile} variant=${t.variant}`);
    }

    // Start all targets.
    for (const t of targets) {
      await api.startVideoStream(channel, t.profile, t.variant === "default" ? undefined : { variant: t.variant });
      await sleepMs(75);
    }

    const captured: CapturedTarget[] = targets.map((t) => {
      const expectedStreamType = expectedStreamTypeFor(t.profile, t.variant);
      const expectedMsgNum = api.getActiveVideoMsgNumWithVariant(channel, t.profile, t.variant);
      console.log(
        `expected for ${t.id}: msgNum=${expectedMsgNum ?? "(unknown)"} streamType=${expectedStreamType} channelId=${channel}`,
      );
      return { target: t, expectedMsgNum, expectedStreamType };
    });

    await sleepMs(durationMs);

    // Stop all targets (reverse order).
    for (const t of [...targets].reverse()) {
      await api.stopVideoStream(channel, t.profile, t.variant === "default" ? undefined : { variant: t.variant });
      await sleepMs(50);
    }

    // Resolve expected groups.
    for (const c of captured) {
      const g = findBestExpectedGroup({
        groups: allCmd3,
        expected: {
          channelId: channel,
          streamType: c.expectedStreamType,
          ...(c.expectedMsgNum !== undefined ? { msgNum: c.expectedMsgNum } : {}),
        },
      });
      if (g) c.expectedGroup = g;
    }

    printGroups({
      title: "RX cmdId=3 groups (raw, concurrent)",
      groups: allCmd3,
    });

    console.log("\nResolved expected groups:");
    for (const c of captured) {
      const g = c.expectedGroup;
      console.log(
        `  ${c.target.id}: streamType=${c.expectedStreamType} msgNum=${c.expectedMsgNum ?? "(unknown)"} -> ` +
          (g
            ? `frames=${g.frames} sampleSha1_4k=${g.samplePayloadSha1_4k ?? "-"} sampleHex16=${g.samplePayloadPrefixHex16 ?? "-"}`
            : "NO MATCH"),
      );
    }

    // Also show a small summary of other cmdIds to detect side-effects (keepalive, channel info, etc).
    const otherByCmd = new Map<number, number>();
    for (const g of allOther.values()) {
      otherByCmd.set(g.cmdId, (otherByCmd.get(g.cmdId) ?? 0) + g.frames);
    }
    const otherList = [...otherByCmd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`\nRX other cmdIds (top): ${otherList.map(([cmdId, n]) => `${cmdId}:${n}`).join(" ") || "(none)"}`);

    return captured;
  } finally {
    api.client.off("frame", onFrame);
  }
}

async function captureSingle(params: {
  api: ReolinkBaichuanApi;
  channel: number;
  durationMs: number;
  target: TargetStream;
}): Promise<CapturedTarget> {
  const { api, channel, durationMs, target } = params;

  const allCmd3 = new Map<GroupKey, GroupStats>();
  const allOther = new Map<GroupKey, GroupStats>();

  const onFrame = (frame: BaichuanFrame) => {
    if (frame.header.cmdId === 3) addFrame(allCmd3, frame);
    else addFrame(allOther, frame);
  };

  api.client.on("frame", onFrame);
  try {
    console.log(`\n================================================================================`);
    console.log(`CAPTURE: ${target.id}`);
    console.log(`channel=${channel} lens=${target.lens} profile=${target.profile} variant=${target.variant} durationMs=${durationMs}`);

    // Best-effort: stop any potentially-running streams of both variants for this profile.
    // TrackMix on NVR can behave like the variant start replaces/stops the default stream.
    try {
      await api.stopVideoStream(channel, target.profile, undefined);
    } catch {
      // ignore
    }
    try {
      await api.stopVideoStream(channel, target.profile, target.variant === "default" ? undefined : { variant: target.variant });
    } catch {
      // ignore
    }

    await sleepMs(150);

    await api.startVideoStream(channel, target.profile, target.variant === "default" ? undefined : { variant: target.variant });

    const expectedStreamType = expectedStreamTypeFor(target.profile, target.variant);
    const expectedMsgNum = api.getActiveVideoMsgNumWithVariant(channel, target.profile, target.variant);
    console.log(`expected: msgNum=${expectedMsgNum ?? "(unknown)"} streamType=${expectedStreamType} channelId=${channel}`);

    await sleepMs(durationMs);

    try {
      await api.stopVideoStream(channel, target.profile, target.variant === "default" ? undefined : { variant: target.variant });
    } catch {
      // ignore
    }

    const expectedGroup = findBestExpectedGroup({
      groups: allCmd3,
      expected: {
        channelId: channel,
        streamType: expectedStreamType,
        ...(expectedMsgNum !== undefined ? { msgNum: expectedMsgNum } : {}),
      },
    });

    printGroups({
      title: "RX cmdId=3 groups (raw, single)",
      groups: allCmd3,
      expected: {
        channelId: channel,
        streamType: expectedStreamType,
        ...(expectedMsgNum !== undefined ? { msgNum: expectedMsgNum } : {}),
      },
    });

    const otherByCmd = new Map<number, number>();
    for (const g of allOther.values()) {
      otherByCmd.set(g.cmdId, (otherByCmd.get(g.cmdId) ?? 0) + g.frames);
    }
    const otherList = [...otherByCmd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`\nRX other cmdIds (top): ${otherList.map(([cmdId, n]) => `${cmdId}:${n}`).join(" ") || "(none)"}`);

    return {
      target,
      expectedMsgNum,
      expectedStreamType,
      ...(expectedGroup ? { expectedGroup } : {}),
    };
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
      traceNativeStream: true,
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
    const { nativeStreams } = (await api.buildVideoStreamOptions({ channel, onNvr: true })) as {
      nativeStreams: ReolinkSupportedStream[];
    };
    const nativeRtp = nativeStreams.filter((s) => s.container === "rtp");

    const wideMain = nativeRtp.find((s) => s.lens === "wide" && s.profile === "main" && s.nativeVariant === undefined);
    const wideSub = nativeRtp.find((s) => s.lens === "wide" && s.profile === "sub" && s.nativeVariant === undefined);

    // Tele lens behind NVR can be exposed as autotrack OR telephoto depending on firmware.
    const desiredTeleVariant = (process.env.NVR_TELE_VARIANT ?? "autotrack") as "autotrack" | "telephoto";
    const teleMain =
      nativeRtp.find((s) => s.lens === "telephoto" && s.profile === "main" && s.nativeVariant === desiredTeleVariant) ??
      nativeRtp.find((s) => s.lens === "telephoto" && s.profile === "main" && s.nativeVariant !== undefined);
    const teleSub =
      nativeRtp.find((s) => s.lens === "telephoto" && s.profile === "sub" && s.nativeVariant === desiredTeleVariant) ??
      nativeRtp.find((s) => s.lens === "telephoto" && s.profile === "sub" && s.nativeVariant !== undefined);

    console.log("\n================================================================================");
    console.log("STREAM OPTIONS (native rtp, filtered for test)");
    console.log("================================================================================");
    for (const s of nativeRtp) {
      console.log(
        `  id=${s.id} lens=${s.lens ?? "-"} profile=${s.profile} nativeVariant=${s.nativeVariant ?? "default"} url=${s.url}`,
      );
    }

    const targets: TargetStream[] = [
      {
        id: must(wideMain, "Missing wide main native stream option").id,
        lens: "wide",
        profile: "main",
        variant: "default",
      },
      {
        id: must(wideSub, "Missing wide sub native stream option").id,
        lens: "wide",
        profile: "sub",
        variant: "default",
      },
      {
        id: must(teleMain, "Missing tele main native stream option").id,
        lens: "telephoto",
        profile: "main",
        variant: (teleMain?.nativeVariant ?? "autotrack") as NativeVariant,
      },
      {
        id: must(teleSub, "Missing tele sub native stream option").id,
        lens: "telephoto",
        profile: "sub",
        variant: (teleSub?.nativeVariant ?? "autotrack") as NativeVariant,
      },
    ];

    const durationMs = Number(process.env.NVR_STREAM_DURATION_MS ?? 3500);
    const captured: CapturedTarget[] = [];
    for (const t of targets) {
      captured.push(await captureSingle({ api, channel, durationMs, target: t }));
      await sleepMs(250);
    }

    const byId = new Map<string, CapturedTarget>(captured.map((c) => [c.target.id, c]));
    const wideMainCap = must(byId.get(targets[0]!.id), "missing capture wide main");
    const wideSubCap = must(byId.get(targets[1]!.id), "missing capture wide sub");
    const teleMainCap = must(byId.get(targets[2]!.id), "missing capture tele main");
    const teleSubCap = must(byId.get(targets[3]!.id), "missing capture tele sub");

    for (const c of [wideMainCap, wideSubCap, teleMainCap, teleSubCap]) {
      const g = c.expectedGroup;
      if (!g) {
        throw new Error(`No expected cmdId=3 group resolved for ${c.target.id} (streamType=${c.expectedStreamType})`);
      }
      if (g.frames < 3) {
        throw new Error(`Too few frames for ${c.target.id}: frames=${g.frames}`);
      }
      if (!g.samplePayloadSha1_4k) {
        throw new Error(`Missing sample payload fingerprint for ${c.target.id} (frames=${g.frames} payloadBytes=${g.payloadBytes})`);
      }
    }

    // Sanity: ensure we see all 4 expected streamTypes.
    const types = new Set([wideMainCap.expectedStreamType, wideSubCap.expectedStreamType, teleMainCap.expectedStreamType, teleSubCap.expectedStreamType]);
    const expectedTypes = new Set([0, 1, 2, 3]);
    const missingTypes = [...expectedTypes].filter((t) => !types.has(t));
    if (missingTypes.length > 0) {
      throw new Error(`Missing expected streamTypes: ${missingTypes.join(",")} (got=${[...types].join(",")})`);
    }

    // Content fingerprints: if tele aliases to wide, these hashes will match.
    if (sameHash(wideMainCap.expectedGroup?.samplePayloadSha1_4k, teleMainCap.expectedGroup?.samplePayloadSha1_4k)) {
      throw new Error(`tele main appears identical to wide main (sampleSha1_4k matches)`);
    }
    if (sameHash(wideSubCap.expectedGroup?.samplePayloadSha1_4k, teleSubCap.expectedGroup?.samplePayloadSha1_4k)) {
      throw new Error(`tele sub appears identical to wide sub (sampleSha1_4k matches)`);
    }
    if (sameHash(wideMainCap.expectedGroup?.samplePayloadSha1_4k, wideSubCap.expectedGroup?.samplePayloadSha1_4k)) {
      throw new Error(`wide main appears identical to wide sub (sampleSha1_4k matches)`);
    }
    if (sameHash(teleMainCap.expectedGroup?.samplePayloadSha1_4k, teleSubCap.expectedGroup?.samplePayloadSha1_4k)) {
      throw new Error(`tele main appears identical to tele sub (sampleSha1_4k matches)`);
    }

    console.log("\nOK: wide/tele + main/sub show distinct frame fingerprints.");
  } finally {
    await api.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
