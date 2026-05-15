#!/usr/bin/env tsx
/**
 * Baichuan pcap analyzer.
 *
 * Usage:
 *   npx tsx tools/pcap/analyzer.ts frames   <pcap>
 *   npx tsx tools/pcap/analyzer.ts login    <pcap>
 *   npx tsx tools/pcap/analyzer.ts analyze  <pcap> [--password P]
 *   npx tsx tools/pcap/analyzer.ts cmd <id> <pcap> [--password P]
 *   npx tsx tools/pcap/analyzer.ts dump  <out-dir> <pcap> [--password P]
 *   npx tsx tools/pcap/analyzer.ts groups   <pcap> [--password P]
 *
 * Passwords are auto-loaded from `.env` (every `*_PASSWORD` entry) and tried
 * in order. Pass `--password X` to force a single candidate.
 *
 * Flags accepted by every subcommand:
 *   --password, -p   Single password override
 *   --port           TCP port to filter (default 9000)
 *   --stream N       Restrict to a single tcp.stream id
 *   --dir c2s|s2c    Restrict to a single direction
 *   --no-xml         Skip XML printing (header only)
 *   --hex            Show raw hex preview of body
 *   --json           Emit JSON instead of human output (where supported)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { extractBaichuanPayloads } from "./tshark";
import {
  analyzePcap,
  type AnnotatedFrame,
  type SessionSummary,
} from "./decrypt";
import { describeCmdId } from "./cmd-names";
import { formatFrame, formatHeaderLine } from "./format";
import { scanMediaStream } from "./media";
import { runCapture } from "./capture";
import { buildSummary } from "./summary";

interface CommonOpts {
  passwords: string[];
  port: number;
  streamFilter?: number;
  dirFilter?: "c2s" | "s2c";
  showXml: boolean;
  showHex: boolean;
  json: boolean;
  /** `summary` only: also scrub IPs / MAC / serials in addition to credentials. */
  stripNetwork?: boolean;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printHelp();
    process.exit(0);
  }
  const sub = argv.shift()!;

  // `capture` has its own flag set (no `--password`, no `--stream`, etc.)
  // Handle it before invoking the analysis arg parser to avoid spurious
  // "unknown flag" errors on its dedicated options.
  if (sub === "capture") {
    await runCapture(parseCaptureFlags(argv));
    return;
  }

  const { positional, opts } = parseArgs(argv);

  switch (sub) {
    case "frames":
      await runFrames(requirePcap(positional, sub), opts);
      break;
    case "login":
      await runLogin(requirePcap(positional, sub), opts);
      break;
    case "analyze":
      await runAnalyze(requirePcap(positional, sub), opts);
      break;
    case "cmd": {
      const cmdId = Number(positional.shift());
      if (!Number.isFinite(cmdId)) die("`cmd` requires <id> <pcap>");
      await runCmdFilter(cmdId, requirePcap(positional, sub), opts);
      break;
    }
    case "dump": {
      const outDir = positional.shift();
      if (!outDir) die("`dump` requires <out-dir> <pcap>");
      await runDump(outDir, requirePcap(positional, sub), opts);
      break;
    }
    case "groups":
      await runGroups(requirePcap(positional, sub), opts);
      break;
    case "media":
      await runMedia(requirePcap(positional, sub), opts);
      break;
    case "summary":
      await runSummary(requirePcap(positional, sub), opts, positional);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      die(`Unknown subcommand: ${sub}`);
  }
}

function requirePcap(positional: string[], sub: string): string {
  const pcap = positional.shift();
  if (!pcap) die(`\`${sub}\` requires a <pcap> path`);
  if (!fs.existsSync(pcap)) die(`pcap not found: ${pcap}`);
  return pcap;
}

function parseArgs(argv: string[]): { positional: string[]; opts: CommonOpts } {
  const positional: string[] = [];
  const opts: CommonOpts = {
    passwords: loadPasswordsFromEnv(),
    port: 9000,
    showXml: true,
    showHex: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--password" || a === "-p") {
      opts.passwords = [argv[++i]];
    } else if (a === "--port") {
      opts.port = Number(argv[++i]);
    } else if (a === "--stream") {
      opts.streamFilter = Number(argv[++i]);
    } else if (a === "--dir") {
      const v = argv[++i];
      if (v !== "c2s" && v !== "s2c") die(`--dir must be c2s or s2c, got ${v}`);
      opts.dirFilter = v;
    } else if (a === "--no-xml") {
      opts.showXml = false;
    } else if (a === "--hex") {
      opts.showHex = true;
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--strip-network") {
      opts.stripNetwork = true;
    } else if (a.startsWith("-")) {
      die(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

/** Read all `*_PASSWORD=` entries from the project's `.env`. */
function loadPasswordsFromEnv(): string[] {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return [];
  const raw = fs.readFileSync(envPath, "utf8");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]*PASSWORD)\s*=\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const val = m[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (val && !seen.has(val)) {
      seen.add(val);
      out.push(val);
    }
  }
  return out;
}

async function loadAndAnalyze(
  pcapPath: string,
  opts: CommonOpts,
): Promise<{ frames: AnnotatedFrame[]; summaries: SessionSummary[] }> {
  const payloads = await extractBaichuanPayloads(pcapPath, { port: opts.port });
  const filtered = payloads.filter((p) => {
    if (opts.streamFilter !== undefined && p.streamId !== opts.streamFilter) return false;
    if (opts.dirFilter && p.direction !== opts.dirFilter) return false;
    return true;
  });
  const { frames, summaries } = analyzePcap(filtered, { passwords: opts.passwords });
  return { frames, summaries };
}

async function runFrames(pcap: string, opts: CommonOpts): Promise<void> {
  const { frames, summaries } = await loadAndAnalyze(pcap, opts);
  printSessionHeader(summaries);
  for (const af of frames) {
    console.log(formatHeaderLine(af));
  }
  printFrameCount(frames);
  void opts;
}

async function runLogin(pcap: string, opts: CommonOpts): Promise<void> {
  const { summaries } = await loadAndAnalyze(pcap, opts);
  if (opts.json) {
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }
  for (const s of summaries) {
    console.log(`Stream ${s.streamId}: c2s=${s.c2sFrames} s2c=${s.s2cFrames}`);
    console.log(`  encType: ${s.loginEncType ?? "(unknown)"}`);
    if (s.loginNonce) console.log(`  nonce:   ${s.loginNonce}`);
    if (s.resolvedPassword) console.log(`  password: ${maskPassword(s.resolvedPassword)}`);
    if (s.loginXmlPreview) console.log(`  loginXmlPreview: ${s.loginXmlPreview.replace(/\s+/g, " ")}`);
    console.log("");
  }
}

async function runAnalyze(pcap: string, opts: CommonOpts): Promise<void> {
  const { frames, summaries } = await loadAndAnalyze(pcap, opts);
  printSessionHeader(summaries);
  for (const af of frames) {
    console.log(formatFrame(af, { showXml: opts.showXml, showHex: opts.showHex }));
    console.log("");
  }
  printFrameCount(frames);
}

async function runCmdFilter(cmdId: number, pcap: string, opts: CommonOpts): Promise<void> {
  const { frames, summaries } = await loadAndAnalyze(pcap, opts);
  printSessionHeader(summaries);
  const matching = frames.filter((af) => af.frame.header.cmdId === cmdId);
  console.log(`# cmd_id=${cmdId} (${describeCmdId(cmdId)}) — ${matching.length} frame(s)\n`);
  for (const af of matching) {
    console.log(formatFrame(af, { showXml: opts.showXml, showHex: opts.showHex }));
    console.log("");
  }
}

async function runGroups(pcap: string, opts: CommonOpts): Promise<void> {
  const { frames, summaries } = await loadAndAnalyze(pcap, opts);
  printSessionHeader(summaries);

  type Group = { cmdId: number; c2s: number; s2c: number; firstFrame: number; lastFrame: number };
  const groups = new Map<number, Group>();
  for (const af of frames) {
    const id = af.frame.header.cmdId;
    let g = groups.get(id);
    if (!g) {
      g = { cmdId: id, c2s: 0, s2c: 0, firstFrame: af.pcap.frameNumber, lastFrame: af.pcap.frameNumber };
      groups.set(id, g);
    }
    if (af.pcap.direction === "c2s") g.c2s += 1;
    else g.s2c += 1;
    g.lastFrame = af.pcap.frameNumber;
  }
  const sorted = Array.from(groups.values()).sort((a, b) => b.c2s + b.s2c - (a.c2s + a.s2c));
  if (opts.json) {
    console.log(JSON.stringify(sorted.map((g) => ({ ...g, name: describeCmdId(g.cmdId) })), null, 2));
    return;
  }
  console.log("cmd_id  c2s  s2c  first  last   name");
  console.log("------  ---  ---  -----  -----  ----");
  for (const g of sorted) {
    console.log(
      `${pad(g.cmdId, 6)}  ${pad(g.c2s, 3)}  ${pad(g.s2c, 3)}  ${pad(g.firstFrame, 5)}  ${pad(g.lastFrame, 5)}  ${describeCmdId(g.cmdId)}`,
    );
  }
}

async function runMedia(pcap: string, opts: CommonOpts): Promise<void> {
  const payloads = await extractBaichuanPayloads(pcap, { port: opts.port });
  const filtered = payloads.filter((p) => {
    if (opts.streamFilter !== undefined && p.streamId !== opts.streamFilter) return false;
    if (opts.dirFilter && p.direction !== opts.dirFilter) return false;
    return true;
  });
  const { frames, sessions, summaries } = analyzePcapInternal(filtered, opts);
  printSessionHeader(summaries);
  const entries = scanMediaStream(frames, sessions);

  // Aggregate counts per magic to make unknown types obvious at a glance.
  const counts = new Map<string, { type: string; magic: number; ascii: string; n: number; firstFrame: number; firstPreview: string }>();
  for (const e of entries) {
    const key = `${e.magic.toString(16).padStart(8, "0")}:${e.type}`;
    let c = counts.get(key);
    if (!c) {
      c = { type: e.type, magic: e.magic, ascii: e.magicAscii, n: 0, firstFrame: e.frameNumber, firstPreview: e.preview };
      counts.set(key, c);
    }
    c.n += 1;
  }
  const sorted = Array.from(counts.values()).sort((a, b) => b.n - a.n);
  if (opts.json) {
    console.log(JSON.stringify(sorted, null, 2));
    return;
  }
  console.log("magic     ascii  type       count   firstFrame  preview");
  console.log("--------  -----  ---------  ------  ----------  -------");
  for (const c of sorted) {
    console.log(
      `${c.magic.toString(16).padStart(8, "0")}  ${c.ascii.padEnd(5, " ")}  ${c.type.padEnd(9, " ")}  ${pad(c.n, 6)}  ${pad(c.firstFrame, 10)}  ${c.firstPreview.slice(0, 80)}`,
    );
  }
}

function analyzePcapInternal(
  filtered: Awaited<ReturnType<typeof extractBaichuanPayloads>>,
  opts: CommonOpts,
): ReturnType<typeof analyzePcap> {
  return analyzePcap(filtered, { passwords: opts.passwords });
}

async function runDump(outDir: string, pcap: string, opts: CommonOpts): Promise<void> {
  const { frames, summaries } = await loadAndAnalyze(pcap, opts);
  printSessionHeader(summaries);
  fs.mkdirSync(outDir, { recursive: true });

  let written = 0;
  for (const af of frames) {
    const h = af.frame.header;
    const dir = af.pcap.direction;
    const idx = String(af.pcap.frameNumber).padStart(5, "0");
    const namePart = describeCmdId(h.cmdId).split(" | ")[0].replace(/^BC_CMD_ID_/, "");
    const safeName = namePart.toLowerCase();
    const filename = `${idx}_${dir}_s${af.pcap.streamId}_cmd${h.cmdId}_${safeName}.xml`;
    const filepath = path.join(outDir, filename);
    const ext = af.decryptedExtensionXml ? `<!-- extension -->\n${af.decryptedExtensionXml}\n` : "";
    const body = af.decryptedXml ?? "<!-- undecryptable -->";
    const header = `<!-- frame #${af.pcap.frameNumber} ${dir} cmd=${h.cmdId} ch=${h.channelId} msg#${h.msgNum} rc=0x${h.responseCode.toString(16)} encAs=${af.decryptedAs ?? "raw"} -->\n`;
    fs.writeFileSync(filepath, header + ext + body);
    written += 1;
  }
  console.log(`Wrote ${written} files to ${outDir}`);
}

async function runSummary(
  pcap: string,
  opts: CommonOpts,
  positional: string[],
): Promise<void> {
  const { frames } = await loadAndAnalyze(pcap, opts);
  const digest = buildSummary(frames, {
    stripAuth: true,
    stripNetwork: opts.stripNetwork === true,
  });
  // Optional positional: output file path. Otherwise stdout.
  const outFile = positional.shift();
  if (outFile) {
    fs.writeFileSync(outFile, digest, "utf8");
    console.error(`# wrote ${digest.length} bytes to ${outFile}`);
  } else {
    process.stdout.write(digest);
  }
}

function printSessionHeader(summaries: SessionSummary[]): void {
  for (const s of summaries) {
    const enc = s.loginEncType ?? "?";
    const pw = s.resolvedPassword ? ` pw=${maskPassword(s.resolvedPassword)}` : "";
    const nonce = s.loginNonce ? ` nonce=${s.loginNonce}` : "";
    console.log(`# stream=${s.streamId} c2s=${s.c2sFrames} s2c=${s.s2cFrames} enc=${enc}${nonce}${pw}`);
  }
  console.log("");
}

function printFrameCount(frames: AnnotatedFrame[]): void {
  console.log(`\n# total frames: ${frames.length}`);
}

function maskPassword(pw: string): string {
  if (pw.length <= 2) return "*".repeat(pw.length);
  return pw[0] + "*".repeat(Math.max(1, pw.length - 2)) + pw[pw.length - 1];
}

function pad(n: number | string, width: number): string {
  return String(n).padStart(width, " ");
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/**
 * `capture` does not share the analysis flag set — it has its own knobs.
 * Parse them here so it stays independent of `parseArgs`.
 */
function parseCaptureFlags(argv: string[]): import("./capture").CaptureOpts {
  const opts: import("./capture").CaptureOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host" || a === "--ip") opts.host = argv[++i];
    else if (a === "--iface" || a === "-i") opts.iface = argv[++i];
    else if (a === "--output" || a === "-o") opts.output = argv[++i];
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--bundle") opts.bundle = true;
    else if (a === "--label") opts.label = argv[++i];
    else if (a === "--non-interactive") opts.nonInteractive = true;
    else if (a === "--auto") opts.auto = true;
    else if (a === "--all-traffic") opts.allTraffic = true;
    else die(`unknown flag for capture: ${a}`);
  }
  return opts;
}

function printHelp(): void {
  console.log(
    [
      "Baichuan pcap analyzer",
      "",
      "Subcommands:",
      "  frames   <pcap>                 List frames (header-only)",
      "  login    <pcap>                 Show login flow per stream",
      "  analyze  <pcap>                 Full decrypt + XML per frame",
      "  cmd <id> <pcap>                 Filter only frames with cmd_id=id",
      "  groups   <pcap>                 Frequency table grouped by cmd_id",
      "  dump <dir> <pcap>               Write one XML per frame to <dir>",
      "  summary  <pcap> [out.txt]       Single shareable digest (no auth, no credentials).",
      "                                  Pair request+response per cmd_id in capture order.",
      "                                  Add --strip-network to also scrub IPs/MAC/serials.",
      "  capture  [--host IP] [--iface NAME] [--bundle]",
      "                                  Interactive live capture, walks you through",
      "                                  picking the right interface, pings the camera,",
      "                                  saves a pcapng, optionally bundles it for an issue.",
      "",
      "Flags (all subcommands):",
      "  --password X   single password override (else uses every *_PASSWORD in .env)",
      "  --port N       TCP port to filter (default 9000)",
      "  --stream N     restrict to tcp.stream id N",
      "  --dir c2s|s2c  restrict to a single direction",
      "  --no-xml       header lines only",
      "  --hex          show raw-hex preview of body",
      "  --json         emit JSON (login/groups)",
    ].join("\n"),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
