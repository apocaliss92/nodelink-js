#!/usr/bin/env node
/**
 * Test: stream a recording replay (clip playback) over Baichuan socket (cmdId=5) and save raw Annex-B video.
 *
 * Env:
 * - TCP_HOST/TCP_USERNAME/TCP_PASSWORD or TCP265_HOST/TCP265_USERNAME/TCP265_PASSWORD
 * - REPLAY_FILE (required): recording path (e.g. /mnt/sda/Mp4Record/...mp4)
 * - REPLAY_STREAM (optional): mainStream | subStream (default: mainStream)
 * - REPLAY_SECONDS (optional, default: 15): how long to capture before stopping
 * - REPLAY_OUT (optional, default: fullTest/artifacts/replay.h265)
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";
import { mkdirSync, createWriteStream } from "node:fs";
import { dirname } from "node:path";

function die(msg: string): never {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

async function main() {
  let replayFile = (process.env.REPLAY_FILE ?? process.env.VOD_FILE ?? "").trim();

  const streamType = ((process.env.REPLAY_STREAM ?? "mainStream").trim() || "mainStream") as
    | "mainStream"
    | "subStream";

  const secondsRaw = Number.parseInt((process.env.REPLAY_SECONDS ?? "15").trim(), 10);
  const seconds = Number.isFinite(secondsRaw) && secondsRaw > 0 ? secondsRaw : 15;

  const outPath = (process.env.REPLAY_OUT ?? "fullTest/artifacts/replay.h265").trim();
  mkdirSync(dirname(outPath), { recursive: true });

  const use265 = Boolean((config.tcp265.host || "").trim());
  const host = use265 ? config.tcp265.host : config.tcp.host;
  const username = use265 ? config.tcp265.username : config.tcp.username;
  const password = use265 ? config.tcp265.password : config.tcp.password;

  if (!host) die("Missing TCP_HOST (or TCP265_HOST) in .env");
  if (!password) die("Missing TCP_PASSWORD (or TCP265_PASSWORD) in .env");

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    transport: "tcp",
    debug: (process.env.DEBUG ?? "").trim() === "1",
  });

  await api.login();

  if (!replayFile) {
    const lookbackDaysRaw = Number.parseInt((process.env.REPLAY_LOOKBACK_DAYS ?? "2").trim(), 10);
    const lookbackDays = Number.isFinite(lookbackDaysRaw) && lookbackDaysRaw > 0 ? lookbackDaysRaw : 2;
    console.log(`REPLAY_FILE not provided; fetching latest event clip via Baichuan <findAlarmVideo> (lookbackDays=${lookbackDays})...`);
    replayFile = await api.findLatestAlarmEventFileNameViaBaichuan({
      channel: 0,
      lookbackDays,
      streamType,
    });
  }

  if (!replayFile) die("Could not resolve REPLAY_FILE");

  console.log("\n=== REPLAY STREAM TEST (cmdId=5) ===");
  console.log("host:", host);
  console.log("file:", replayFile);
  console.log("stream:", streamType);
  console.log("out:", outPath);
  console.log("seconds:", seconds);

  const ws = createWriteStream(outPath);
  let videoAUs = 0;
  let keyframes = 0;

  const { stream, stop, msgNum } = await api.startRecordingReplayStream({
    channel: 0,
    fileName: replayFile,
    streamType,
  });

  console.log("msgNum:", msgNum);

  stream.on("videoAccessUnit", (au: {
    data: Buffer;
    isKeyframe: boolean;
    videoType: "H264" | "H265";
    microseconds: number;
    time?: number;
  }) => {
    videoAUs++;
    if (au.isKeyframe) keyframes++;
    ws.write(au.data);

    if (videoAUs <= 3 || videoAUs % 60 === 0) {
      console.log(`videoAccessUnit #${videoAUs} keyframes=${keyframes} type=${au.videoType} len=${au.data.length}`);
    }
  });

  stream.on("error", (e: Error) => {
    console.error("stream error:", e);
  });

  await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

  console.log("\nStopping replay...");
  await stop();

  await new Promise<void>((resolve) => ws.end(resolve));
  await api.close();

  console.log("Done.");
  console.log(`Saved Annex-B to: ${outPath}`);
  console.log("Tip: ffprobe -hide_banner -show_streams -i replay.h265");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
