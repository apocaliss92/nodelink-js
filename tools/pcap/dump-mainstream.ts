#!/usr/bin/env tsx
/**
 * Pull the camera's mainStream over Baichuan, decode BcMedia into Annex-B
 * H.264/H.265, and save it raw to disk. Use this to verify whether
 * Reolink Motion Marks are burnt into the video pixels (visible in `ffplay`)
 * or are rendered client-side by the Reolink app (file looks clean).
 *
 * Usage:
 *   npx tsx tools/pcap/dump-mainstream.ts --duration 15 [--profile main]
 *   ffplay /tmp/mainstream.h264
 */
import { writeFileSync, appendFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { readFileSync } from "node:fs";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { BaichuanVideoStream } from "../../src/baichuan/stream/BaichuanVideoStream";
import type { BaichuanClient } from "../../src/client/BaichuanClient";
import { BC_CMD_ID_VIDEO } from "../../src/protocol/constants";

interface Args {
  host: string;
  user: string;
  password: string;
  durationMs: number;
  profile: "main" | "sub";
  output: string;
}

function parseArgs(): Args {
  const env = loadEnv();
  let host = env.TCP_HOST ?? "";
  let user = env.TCP_USERNAME ?? "admin";
  let password = env.TCP_PASSWORD ?? "";
  let durationMs = 15_000;
  let profile: "main" | "sub" = "main";
  let output = "/tmp/mainstream.h264";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") host = argv[++i];
    else if (a === "--user") user = argv[++i];
    else if (a === "--password") password = argv[++i];
    else if (a === "--duration") durationMs = Number(argv[++i]) * 1000;
    else if (a === "--profile") {
      const v = argv[++i];
      if (v !== "main" && v !== "sub") {
        process.stderr.write(`--profile must be main|sub, got ${v}\n`);
        process.exit(2);
      }
      profile = v;
    } else if (a === "--out") output = argv[++i];
    else {
      process.stderr.write(`unknown flag: ${a}\n`);
      process.exit(2);
    }
  }
  if (!host || !password) {
    process.stderr.write("error: TCP_HOST and TCP_PASSWORD required (env or flags)\n");
    process.exit(2);
  }
  return { host, user, password, durationMs, profile, output };
}

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(pathResolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {/* no .env */}
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  process.stdout.write(
    `Connecting to ${args.host} profile=${args.profile} duration=${args.durationMs / 1000}s\n`,
  );

  const api = new ReolinkBaichuanApi({
    host: args.host,
    username: args.user,
    password: args.password,
  });

  // Open a dedicated client for streaming so the main client stays free for
  // metadata requests if we want to mix later.
  const { client, release } = await api.createDedicatedSession(
    `live:${args.host}:dump-mainstream`,
  );
  const dedicated = client as BaichuanClient;
  await dedicated.connect();
  await dedicated.login("full_aes");

  // Subscribe to push frames matching our msgNum so BaichuanVideoStream
  // receives them as it expects.
  const msgNum = 0;
  dedicated.subscribeVideoStream(BC_CMD_ID_VIDEO, msgNum);

  writeFileSync(args.output, Buffer.alloc(0));
  let bytes = 0;
  let frames = 0;

  const stream = new BaichuanVideoStream({
    client: dedicated,
    channel: 0,
    profile: args.profile,
    variant: "default",
    cmdId: BC_CMD_ID_VIDEO,
    msgNum,
    acceptAnyStreamType: false,
  });

  stream.on("videoFrame", (annexB: Buffer) => {
    appendFileSync(args.output, annexB);
    bytes += annexB.length;
    frames += 1;
  });
  stream.on("error", (err: Error) => {
    process.stderr.write(`stream error: ${err.message}\n`);
  });

  await stream.start();
  process.stdout.write(`stream started, dumping → ${args.output}\n`);

  await new Promise<void>((resolve) => setTimeout(resolve, args.durationMs));

  await stream.stop();
  release();
  await api.close();

  process.stdout.write(`\nWrote ${frames} access units = ${(bytes / 1024).toFixed(1)} KB\n`);
  process.stdout.write(`Inspect:  ffplay ${args.output}\n`);
  process.stdout.write(`          ffprobe -hide_banner ${args.output}\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${msg}\n`);
  process.exit(1);
});
