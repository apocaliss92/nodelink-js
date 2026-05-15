#!/usr/bin/env tsx
/**
 * Pull a few JPEG snapshots (cmd_id=109) from the camera and save them to disk.
 *
 * Useful as a quick visual test: open the resulting files and see whether
 * Reolink Motion Marks (the box overlay) appear in the snapshot. If they DO,
 * the boxes are part of the encoded mainStream and the issue is downstream
 * (e.g. our libary dropping a sub-feature). If they do NOT, the boxes are
 * rendered client-side by the Reolink app on top of the decoded frames.
 *
 * Usage:
 *   npx tsx tools/pcap/dump-snapshots.ts --count 5 --interval 2
 */
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

interface Args {
  host: string;
  user: string;
  password: string;
  count: number;
  intervalSec: number;
  streamType: "main" | "sub";
  outDir: string;
}

function parseArgs(): Args {
  const env = loadEnv();
  let host = env.TCP_HOST ?? "";
  let user = env.TCP_USERNAME ?? "admin";
  let password = env.TCP_PASSWORD ?? "";
  let count = 5;
  let intervalSec = 2;
  let streamType: "main" | "sub" = "main";
  let outDir = "/tmp/reolink-snaps";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") host = argv[++i];
    else if (a === "--user") user = argv[++i];
    else if (a === "--password") password = argv[++i];
    else if (a === "--count") count = Number(argv[++i]);
    else if (a === "--interval") intervalSec = Number(argv[++i]);
    else if (a === "--stream") {
      const v = argv[++i];
      if (v !== "main" && v !== "sub") {
        process.stderr.write(`--stream must be main|sub, got ${v}\n`);
        process.exit(2);
      }
      streamType = v;
    } else if (a === "--out") outDir = argv[++i];
    else {
      process.stderr.write(`unknown flag: ${a}\n`);
      process.exit(2);
    }
  }
  if (!host || !password) {
    process.stderr.write("error: TCP_HOST and TCP_PASSWORD required\n");
    process.exit(2);
  }
  return { host, user, password, count, intervalSec, streamType, outDir };
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
  const { mkdirSync } = await import("node:fs");
  mkdirSync(args.outDir, { recursive: true });

  process.stdout.write(
    `Capturing ${args.count} snapshots (${args.streamType}Stream) every ${args.intervalSec}s from ${args.host}\n`,
  );

  const api = new ReolinkBaichuanApi({
    host: args.host,
    username: args.user,
    password: args.password,
  });

  for (let i = 0; i < args.count; i++) {
    try {
      const jpeg = await api.getSnapshot(0, { streamType: args.streamType });
      const path = `${args.outDir}/snap-${args.streamType}-${String(i).padStart(2, "0")}.jpg`;
      writeFileSync(path, jpeg);
      process.stdout.write(`  [${i + 1}/${args.count}] ${path} (${jpeg.length} bytes)\n`);
    } catch (err) {
      process.stderr.write(
        `  [${i + 1}/${args.count}] snapshot failed: ${err instanceof Error ? err.message : err}\n`,
      );
    }
    if (i < args.count - 1) await sleep(args.intervalSec * 1000);
  }

  await api.close();
  process.stdout.write(`\nOpen the JPEGs in ${args.outDir} to inspect Motion Marks.\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${msg}\n`);
  process.exit(1);
});
