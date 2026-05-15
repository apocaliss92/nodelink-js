#!/usr/bin/env tsx
/**
 * H.265 main-stream diagnostic probe.
 *
 * Opens main stream against the camera, counts H.265 access units and prints
 * the NAL-unit type distribution of the first few frames. Use this to verify
 * the camera is actually emitting H.265 with VPS/SPS/PPS — which the WebRTC
 * server needs before it will forward any frames to the DataChannel.
 */
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { BaichuanVideoStream } from "../../src/baichuan/stream/BaichuanVideoStream";

function getH265NalType(nalUnit: Buffer): number {
  return ((nalUnit[0] ?? 0) >> 1) & 0x3f;
}

function getH264NalType(nalUnit: Buffer): number {
  return (nalUnit[0] ?? 0) & 0x1f;
}

function parseAnnexBNalUnits(annexB: Buffer): Buffer[] {
  const nals: Buffer[] = [];
  let pos = 0;
  while (pos < annexB.length) {
    let startCodeLen = 0;
    if (
      pos + 3 < annexB.length &&
      annexB[pos] === 0 &&
      annexB[pos + 1] === 0 &&
      annexB[pos + 2] === 0 &&
      annexB[pos + 3] === 1
    ) {
      startCodeLen = 4;
    } else if (
      pos + 2 < annexB.length &&
      annexB[pos] === 0 &&
      annexB[pos + 1] === 0 &&
      annexB[pos + 2] === 1
    ) {
      startCodeLen = 3;
    } else {
      pos++;
      continue;
    }
    let next = pos + startCodeLen;
    while (next + 2 < annexB.length) {
      if (
        annexB[next] === 0 &&
        annexB[next + 1] === 0 &&
        (annexB[next + 2] === 1 ||
          (annexB[next + 2] === 0 &&
            next + 3 < annexB.length &&
            annexB[next + 3] === 1))
      )
        break;
      next++;
    }
    if (next + 2 >= annexB.length) next = annexB.length;
    nals.push(annexB.subarray(pos + startCodeLen, next));
    pos = next;
  }
  return nals;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let host = "";
  let password = "";
  let profile: "main" | "sub" | "ext" = "main";
  let durationMs = 15_000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--host") host = argv[++i]!;
    else if (a === "--password") password = argv[++i]!;
    else if (a === "--profile") profile = argv[++i] as any;
    else if (a === "--duration") durationMs = Number(argv[++i]) * 1000;
  }
  if (!host || !password) {
    process.stderr.write(
      "usage: probe-h265.ts --host IP --password PWD [--profile main|sub|ext] [--duration 15]\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `Connecting to ${host} profile=${profile} for ${durationMs / 1000}s\n`,
  );

  const api = new ReolinkBaichuanApi({
    host,
    username: "admin",
    password,
    debugOptions: { general: true, traceNativeStream: true },
  });
  await api.client.connect();
  await api.login();

  const sessionKey = `live:h265-probe:ch0:${profile}`;
  const dedicated = await api.createDedicatedSession(sessionKey);

  const stream = new BaichuanVideoStream({
    client: dedicated.client,
    api,
    channel: 0,
    profile,
  });

  let videoCount = 0;
  let keyframes = 0;
  const nalTypeCounts = new Map<string, number>();
  let firstFrameReported = false;

  stream.on(
    "videoAccessUnit",
    (unit: {
      data: Buffer;
      isKeyframe: boolean;
      videoType: "H264" | "H265";
      microseconds: number;
    }) => {
      videoCount++;
      if (unit.isKeyframe) keyframes++;
      const nals = parseAnnexBNalUnits(unit.data);
      for (const nal of nals) {
        if (nal.length === 0) continue;
        const t =
          unit.videoType === "H265"
            ? getH265NalType(nal)
            : getH264NalType(nal);
        const key = `${unit.videoType}/nal=${t}`;
        nalTypeCounts.set(key, (nalTypeCounts.get(key) ?? 0) + 1);
      }
      if (!firstFrameReported || videoCount <= 3 || unit.isKeyframe) {
        const types = nals
          .filter((n) => n.length > 0)
          .map((n) =>
            unit.videoType === "H265"
              ? getH265NalType(n)
              : getH264NalType(n),
          );
        process.stdout.write(
          `${unit.videoType} #${videoCount} ${unit.data.length}B keyframe=${unit.isKeyframe} nals=[${types.join(",")}]\n`,
        );
        firstFrameReported = true;
      }
    },
  );

  await stream.start();
  process.stdout.write(`Stream started — collecting for ${durationMs / 1000}s\n\n`);
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
  await stream.stop();
  await dedicated.release();
  await api.close();

  process.stdout.write(`\n=== Summary ===\n`);
  process.stdout.write(`Total video access units: ${videoCount}\n`);
  process.stdout.write(`Keyframes:                ${keyframes}\n`);
  process.stdout.write(`NAL type distribution:\n`);
  for (const [k, n] of [...nalTypeCounts.entries()].sort()) {
    process.stdout.write(`  ${k}: ${n}\n`);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
