#!/usr/bin/env tsx
/**
 * Live label probe: opens a substream against the given camera, decodes
 * every BcMedia `additionalHeader` with the new TLV walker, and prints the
 * (type1, type2) tuple + decoded box + label for any non-empty overlay.
 *
 * Use this to verify in real time what (type1, type2) the SDK assigns to
 * boxes for different scene contents (people / vehicles / animals). The hex
 * dump of each box-bearing header is also logged so we can manually diff
 * structure across classes.
 */
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { BaichuanVideoStream } from "../../src/baichuan/stream/BaichuanVideoStream";
import { decodeDetectionHeader } from "../../src/reolink/baichuan/utils/detection";

interface Args {
  host: string;
  user: string;
  password: string;
  profile: "main" | "sub" | "ext";
  durationMs: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  process.stdout.write(
    `Connecting to ${args.host} (${args.user}) profile=${args.profile} for ${args.durationMs / 1000}s\n`,
  );

  const api = new ReolinkBaichuanApi({
    host: args.host,
    username: args.user,
    password: args.password,
  });
  await api.client.connect();
  await api.login();

  const stream = new BaichuanVideoStream({
    client: api["client"],
    api,
    channel: 0,
    profile: args.profile,
  });

  const byLabel = new Map<string, number>();
  const byTuple = new Map<string, number>();
  let total = 0;

  stream.on("additionalHeader", (info) => {
    const decoded = decodeDetectionHeader(info.raw, info.frameType);
    if (decoded.state !== "overlay-decoded") return;
    total += decoded.boxes.length;
    for (const b of decoded.boxes) {
      const label = b.label ?? "(none)";
      byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
    }
    // Print the first 200 distinct (label, raw-prefix) combos for visual
    // diff. We use the first 24 bytes after the marker as a fingerprint —
    // enough to see structural differences between class TLV chains.
    const off = info.frameType === "Iframe" ? 8 : 0;
    const prefix = info.raw.subarray(off + 8, off + 8 + 24).toString("hex");
    const tag = `${decoded.boxes[0]?.label ?? "?"}\t${prefix}`;
    if (!byTuple.has(tag)) {
      byTuple.set(tag, 1);
      const boxesStr = decoded.boxes
        .map((b) => {
          const x1 = Math.round(b.x * (decoded.aiFrameWidth ?? 896));
          const y1 = Math.round(b.y * (decoded.aiFrameHeight ?? 480));
          const x2 = Math.round((b.x + b.width) * (decoded.aiFrameWidth ?? 896));
          const y2 = Math.round((b.y + b.height) * (decoded.aiFrameHeight ?? 480));
          const conf = b.confidence ? Math.round(b.confidence * 100) : 0;
          return `${b.label}@(${x1},${y1})-(${x2},${y2})conf${conf}`;
        })
        .join(" + ");
      process.stdout.write(
        `[${new Date().toISOString().slice(11, 23)}] ${info.frameType} ${info.raw.length}B  ${boxesStr}\n`,
      );
      process.stdout.write(`   raw: ${info.raw.toString("hex")}\n`);
    } else {
      byTuple.set(tag, byTuple.get(tag)! + 1);
    }
  });

  await stream.start();
  process.stdout.write(`Stream started — move things around for ${args.durationMs / 1000}s\n\n`);
  await new Promise<void>((resolve) => setTimeout(resolve, args.durationMs));
  await stream.stop();
  await api.close();

  process.stdout.write(`\n=== Summary ===\n`);
  process.stdout.write(`Total boxes: ${total}\n`);
  process.stdout.write(`By label:\n`);
  for (const [l, n] of [...byLabel.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${l}: ${n}\n`);
  }
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let host = "";
  let user = "admin";
  let password = "";
  let profile: Args["profile"] = "sub";
  let durationMs = 30_000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--host") host = argv[++i]!;
    else if (a === "--user") user = argv[++i]!;
    else if (a === "--password") password = argv[++i]!;
    else if (a === "--profile") profile = argv[++i] as Args["profile"];
    else if (a === "--duration") durationMs = Number(argv[++i]) * 1000;
  }
  if (!host || !password) {
    process.stderr.write(
      "usage: probe-labels.ts --host IP --password PWD [--user admin] [--profile sub|main|ext] [--duration 30]\n",
    );
    process.exit(1);
  }
  return { host, user, password, profile, durationMs };
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
