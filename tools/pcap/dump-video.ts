#!/usr/bin/env tsx
/**
 * Pull N seconds of mainStream video from a live camera, decode the Baichuan
 * BcMedia frames into a raw Annex-B H.264/H.265 file, then ask ffmpeg to
 * extract still PNGs for visual inspection.
 *
 * This is the bench used to verify whether Motion Marks (the on-screen
 * bounding rectangles drawn by Reolink in Clear/High mode) are part of the
 * encoded pixels or shipped as separate metadata.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve as pathResolve, join as pathJoin } from "node:path";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { BaichuanClient } from "../../src/client/BaichuanClient";
import { BaichuanVideoStream } from "../../src/baichuan/stream/BaichuanVideoStream";

interface Args {
  host: string;
  user: string;
  password: string;
  durationMs: number;
  profile: "main" | "sub" | "ext";
  outDir: string;
}

function parseArgs(): Args {
  const env = loadEnv();
  let host = env.TCP_HOST ?? "";
  let user = env.TCP_USERNAME ?? "admin";
  let password = env.TCP_PASSWORD ?? "";
  let durationMs = 15_000;
  let profile: Args["profile"] = "main";
  let outDir = "out/video-dump";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") host = argv[++i];
    else if (a === "--user") user = argv[++i];
    else if (a === "--password") password = argv[++i];
    else if (a === "--duration") durationMs = Number(argv[++i]) * 1000;
    else if (a === "--profile") {
      const v = argv[++i];
      if (v !== "main" && v !== "sub" && v !== "ext") die(`bad --profile: ${v}`);
      profile = v;
    } else if (a === "--out") outDir = argv[++i];
    else die(`unknown flag: ${a}`);
  }
  if (!host) die("--host required");
  if (!password) die("--password required");
  return { host, user, password, durationMs, profile, outDir };
}

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const path = pathResolve(process.cwd(), ".env");
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  mkdirSync(args.outDir, { recursive: true });

  process.stdout.write(
    `Connecting to ${args.host}, profile=${args.profile}, duration=${args.durationMs / 1000}s\n`,
  );

  const api = new ReolinkBaichuanApi({
    host: args.host,
    username: args.user,
    password: args.password,
  });
  const client = api["client"] as BaichuanClient;

  await client.connect();
  await client.login("full_aes");
  process.stdout.write(`login OK\n`);

  const stream = new BaichuanVideoStream({
    client,
    api,
    channel: 0,
    profile: args.profile,
  });

  const nalChunks: Buffer[] = [];
  let videoType: "H264" | "H265" | undefined;
  let iframeCount = 0;
  let pframeCount = 0;
  let bytesWritten = 0;

  stream.on("videoAccessUnit", (au) => {
    videoType = au.videoType;
    if (au.isKeyframe) iframeCount += 1;
    else pframeCount += 1;
    nalChunks.push(au.data);
    bytesWritten += au.data.length;
  });
  stream.on("error", (err) => {
    process.stderr.write(`stream error: ${err.message}\n`);
  });

  await stream.start();
  process.stdout.write(`stream ${args.profile} started — recording ${args.durationMs / 1000}s …\n`);

  await new Promise<void>((r) => setTimeout(r, args.durationMs));

  await stream.stop();
  await api.close();

  if (!videoType) die("no video frames captured");
  process.stdout.write(
    `\nCaptured ${iframeCount} I-frames + ${pframeCount} P-frames (${bytesWritten} bytes ${videoType})\n\n`,
  );

  const ext = videoType === "H264" ? "h264" : "h265";
  const rawPath = pathJoin(args.outDir, `stream.${ext}`);
  writeFileSync(rawPath, Buffer.concat(nalChunks));
  process.stdout.write(`Wrote raw ${ext.toUpperCase()} → ${rawPath}\n`);

  // Use ffmpeg to extract the first few keyframes as PNGs we can eyeball.
  const ffmpegOk = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  if (!ffmpegOk) {
    process.stdout.write("ffmpeg not on PATH — install it to auto-decode the frames.\n");
    return;
  }
  const pngPattern = pathJoin(args.outDir, `frame-%03d.png`);
  const r = spawnSync(
    "ffmpeg",
    [
      "-loglevel", "warning",
      "-f", ext,
      "-i", rawPath,
      "-frames:v", "10",
      "-y",
      pngPattern,
    ],
    { stdio: "inherit" },
  );
  if (r.status === 0) {
    process.stdout.write(`\nDecoded PNGs in ${args.outDir}/frame-001.png … frame-010.png\n`);
    process.stdout.write(`Open them and look for blue rectangles around moving objects.\n`);
  } else {
    process.stdout.write("ffmpeg decode failed — raw stream is in place, try manually.\n");
  }
}

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${msg}\n`);
  if (process.env.DEBUG && err instanceof Error && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
