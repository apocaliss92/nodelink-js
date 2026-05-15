#!/usr/bin/env tsx
/**
 * Audio-frame diagnostic probe.
 *
 * Opens a video stream against the camera and counts:
 *   - video access units emitted        (sanity baseline — the stream works)
 *   - audio frames emitted               (BcMedia parser recognized "bw50"/"bw10")
 *   - unknown chunks the BcMediaCodec    (hex prefix of each unique magic, so we
 *     was about to skip                    can extend the parser if needed)
 *
 * Use this to determine whether the camera is silent (no audio frames at all
 * in the BcMedia stream) vs. emitting audio with an undocumented magic the
 * current parser ignores.
 */
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { BaichuanVideoStream } from "../../src/baichuan/stream/BaichuanVideoStream";

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

  // Use a dedicated session like the Rfc4571TcpServer / Scrypted path does.
  // The shared client multiplexes events; native streams need their own socket.
  const sessionKey = `live:audio-probe:ch0:${args.profile}`;
  const dedicated = await api.createDedicatedSession(sessionKey);
  process.stdout.write(`dedicated session acquired: ${sessionKey}\n`);

  const stream = new BaichuanVideoStream({
    client: dedicated.client,
    api,
    channel: 0,
    profile: args.profile,
  });

  let videoCount = 0;
  let audioCount = 0;
  const unknownByMagic = new Map<
    string,
    { count: number; firstPreview: string; totalSkipped: number }
  >();

  stream.on("videoAccessUnit", () => {
    videoCount++;
  });
  stream.on("audioFrame", (data: Buffer) => {
    audioCount++;
    if (audioCount <= 3) {
      const head = data.subarray(0, Math.min(16, data.length)).toString("hex");
      process.stdout.write(`AUDIO #${audioCount} ${data.length}B head=${head}\n`);
    }
  });

  // Hook the BcMediaCodec for unknown-chunk diagnostics. The codec is exposed
  // for diagnostics; in production code we would not reach into it.
  stream._bcMediaCodec.setUnknownChunkListener((info) => {
    const magicHex = info.magic.toString(16).padStart(8, "0");
    const prev = unknownByMagic.get(magicHex);
    if (prev) {
      prev.count++;
      prev.totalSkipped += info.skipped;
    } else {
      unknownByMagic.set(magicHex, {
        count: 1,
        firstPreview: info.preview.toString("hex").slice(0, 64),
        totalSkipped: info.skipped,
      });
    }
  });

  await stream.start();
  process.stdout.write(`Stream started — collecting for ${args.durationMs / 1000}s\n\n`);
  await new Promise<void>((resolve) => setTimeout(resolve, args.durationMs));
  await stream.stop();
  await dedicated.release();
  await api.close();

  process.stdout.write(`\n=== Summary ===\n`);
  process.stdout.write(`Video access units emitted: ${videoCount}\n`);
  process.stdout.write(`Audio frames emitted:       ${audioCount}\n`);
  process.stdout.write(`Unknown chunks: ${unknownByMagic.size} distinct magic(s)\n`);
  for (const [magic, info] of [...unknownByMagic.entries()].sort(
    (a, b) => b[1].count - a[1].count,
  )) {
    // Translate the LE magic to its on-wire byte order so we can read it as ASCII.
    const wire = Buffer.from(magic, "hex").reverse().toString("hex");
    const ascii = Buffer.from(wire, "hex")
      .toString("ascii")
      .replace(/[^\x20-\x7e]/g, ".");
    process.stdout.write(
      `  magic=0x${magic} wire=${wire} ascii="${ascii}" count=${info.count} skipped=${info.totalSkipped}B preview=${info.firstPreview}\n`,
    );
  }
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let host = "";
  let user = "admin";
  let password = "";
  let profile: Args["profile"] = "sub";
  let durationMs = 15_000;
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
      "usage: probe-audio.ts --host IP --password PWD [--user admin] [--profile sub|main|ext] [--duration 15]\n",
    );
    process.exit(1);
  }
  return { host, user, password, profile, durationMs };
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
