#!/usr/bin/env tsx
/**
 * pcap-vs-impl — analyze a Baichuan pcap and compare against the library's
 * cmd_id handlers. Emits a markdown triage report.
 *
 * Invoked by the local `pcap-vs-impl` skill (.claude/skills/pcap-vs-impl/).
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  BaichuanFrameParser,
  bcDecrypt,
  aesDecrypt,
  deriveAesKey,
  getXmlText,
} from "../../../../src/index";
import * as constants from "../../../../src/index";

interface Args {
  input: string;
  /** Optional password for `.pcapng` inputs only. JSON exports come decrypted. */
  password?: string;
  out?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { input: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--password") args.password = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (!args.input && !a.startsWith("--")) args.input = a;
  }
  if (!args.input) {
    process.stderr.write(
      "usage: compare.ts <pcap-or-json> [--password <p>] [--out <md>]\n" +
        "\n" +
        "  - .json input: sanitized export from the in-app Capture tool. Bodies are\n" +
        "    already decrypted server-side; --password is ignored.\n" +
        "  - .pcapng input: raw pcap from any tshark capture. Pass --password to\n" +
        "    decrypt bodies on the fly using the nonce embedded in the file.\n",
    );
    process.exit(1);
  }
  if (!existsSync(args.input)) {
    process.stderr.write(`input not found: ${args.input}\n`);
    process.exit(1);
  }
  return args;
}

interface FrameLogEntry {
  idx: number;
  direction: "c2s" | "s2c";
  cmdId: number;
  cmdNames: string[];
  msgNum: number;
  channelId: number;
  responseCode: number;
  messageClass: number;
  payloadOffset: number | undefined;
  bodyLen: number;
  bodyHex: string; // first 64 bytes hex (encrypted on wire)
  bodyDecrypted: string; // "" if not decrypted, "<binary>" for video, otherwise XML
}

const CAMERA_PORT = "9000";

const cmdNames = new Map<number, string[]>();
for (const [name, value] of Object.entries(
  constants as Record<string, unknown>,
)) {
  if (typeof value !== "number") continue;
  if (!name.startsWith("BC_CMD_ID_")) continue;
  const list = cmdNames.get(value);
  if (list) list.push(name);
  else cmdNames.set(value, [name]);
}

async function main(): Promise<void> {
  const args = parseArgs();

  // JSON sanitized export from the in-app Capture tool: bodies are already
  // decrypted server-side (the manager uses the camera's stored credentials
  // during persist). No password needed, no tshark needed.
  if (args.input.endsWith(".json")) {
    const frames = framesFromJsonExport(args.input);
    const handlerMap = await mapCmdIdsToFiles();
    const md = renderReport(args, frames, handlerMap);
    if (args.out) {
      writeFileSync(args.out, md);
      process.stderr.write(`report written to ${args.out}\n`);
    } else {
      process.stdout.write(md);
    }
    return;
  }

  // Phase 1: parse pcap, collect frames + full encrypted bodies (in memory).
  const frames: FrameLogEntry[] = [];
  const fullBodies: Buffer[] = [];
  await new Promise<void>((resolve) => {
    const tsharkArgs = [
      "-r", args.input,
      "-Y", "tcp.port == 9000",
      "-T", "fields",
      "-e", "tcp.srcport",
      "-e", "tcp.dstport",
      "-e", "tcp.payload",
      "-l",
    ];
    const proc = spawn("tshark", tsharkArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const parsers = new Map<string, BaichuanFrameParser>();
    let tail = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      const text = tail + chunk.toString("ascii");
      const lines = text.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) handleLine(line, parsers, frames, fullBodies);
    });
    proc.on("close", () => {
      if (tail.trim()) handleLine(tail, parsers, frames, fullBodies);
      resolve();
    });
    proc.on("error", () => resolve());
  });

  // Phase 2: best-effort decrypt
  if (args.password) {
    decryptBodies(frames, fullBodies, args.password);
  }

  // Phase 3: lookup which source files handle each cmd_id
  const handlerMap = await mapCmdIdsToFiles();

  // Phase 4: emit markdown
  const md = renderReport(args, frames, handlerMap);
  if (args.out) {
    writeFileSync(args.out, md);
    process.stderr.write(`report written to ${args.out}\n`);
  } else {
    process.stdout.write(md);
  }
}

/**
 * Build the same `FrameLogEntry[]` shape we use for live captures, but from
 * the JSON manifest the server already wrote at stop-time. The server has
 * already done the decryption with the camera's stored credentials, so each
 * frame carries `bodyDecrypted` directly.
 */
function framesFromJsonExport(jsonPath: string): FrameLogEntry[] {
  const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
  // The export can be either the SanitizedCaptureExport itself or the wrapping
  // PersistedManifest from /api/capture/:id/export. Detect both.
  const exp = (
    raw.format === "nodelink-baichuan-capture-v1"
      ? raw
      : (raw.sanitizedExport as Record<string, unknown> | undefined)
  ) as Record<string, unknown> | undefined;
  if (!exp || exp.format !== "nodelink-baichuan-capture-v1") {
    throw new Error(
      "input JSON is not a sanitized capture export (missing format=nodelink-baichuan-capture-v1)",
    );
  }
  const rawFrames = (exp.frames as Array<Record<string, unknown>>) ?? [];
  const out: FrameLogEntry[] = [];
  for (let i = 0; i < rawFrames.length; i++) {
    const f = rawFrames[i]!;
    const cmdId = Number(f.cmdId);
    const names = (f.cmdNames as string[] | undefined) ?? cmdNames.get(cmdId) ?? [];
    out.push({
      idx: i,
      direction: (f.direction as "c2s" | "s2c") ?? "c2s",
      cmdId,
      cmdNames: names,
      msgNum: Number(f.msgNum ?? 0),
      channelId: Number(f.channelId ?? 0),
      responseCode: Number(f.responseCode ?? 0),
      messageClass: Number(f.messageClass ?? 0),
      payloadOffset: typeof f.payloadOffset === "number" ? f.payloadOffset : undefined,
      bodyLen: Number(f.bodyLen ?? 0),
      bodyHex: (f.bodyHexPreview as string) ?? "",
      bodyDecrypted: typeof f.bodyDecrypted === "string" ? f.bodyDecrypted : "",
    });
  }
  return out;
}

function handleLine(
  line: string,
  parsers: Map<string, BaichuanFrameParser>,
  frames: FrameLogEntry[],
  fullBodies: Buffer[],
): void {
  if (!line.trim()) return;
  const parts = line.split("\t");
  if (parts.length < 3) return;
  const src = parts[0]?.trim();
  const dst = parts[1]?.trim();
  const hex = (parts[2] ?? "").replace(/[^0-9a-fA-F]/g, "");
  if (!src || !dst || !hex) return;
  const buf = Buffer.from(hex, "hex");
  if (buf.length === 0) return;
  const key = `${src}->${dst}`;
  let parser = parsers.get(key);
  if (!parser) {
    parser = new BaichuanFrameParser();
    parsers.set(key, parser);
  }
  let parsed;
  try { parsed = parser.push(buf); } catch { return; }
  const direction: "c2s" | "s2c" = src === CAMERA_PORT ? "s2c" : "c2s";
  for (const f of parsed) {
    const cmdId = f.header.cmdId;
    const names = cmdNames.get(cmdId) ?? [];
    frames.push({
      idx: frames.length,
      direction,
      cmdId,
      cmdNames: names,
      msgNum: f.header.msgNum,
      channelId: f.header.channelId,
      responseCode: f.header.responseCode,
      messageClass: f.header.messageClass,
      payloadOffset: f.header.payloadOffset,
      bodyLen: f.header.bodyLen,
      bodyHex: f.body && f.body.length > 0
        ? f.body.subarray(0, Math.min(64, f.body.length)).toString("hex")
        : "",
      bodyDecrypted: "",
    });
    fullBodies.push(f.body ?? Buffer.alloc(0));
  }
}

function decryptBodies(
  frames: FrameLogEntry[],
  fullBodies: Buffer[],
  password: string,
): void {
  let nonce: string | undefined;
  let encType: number | undefined;
  let nonceIdx = -1;
  for (let i = 0; i < frames.length; i++) {
    const fr = frames[i]!;
    if (fr.cmdId !== 1) continue;
    if ((fr.responseCode >>> 8) !== 0xdd) continue;
    encType = fr.responseCode & 0xff;
    const body = fullBodies[i]!;
    if (body.length === 0) continue;
    const xml = encType === 0
      ? body.toString("utf8")
      : bcDecrypt(body, fr.channelId).toString("utf8");
    const n = getXmlText(xml, "nonce");
    if (n) {
      nonce = n;
      nonceIdx = i;
      fr.bodyDecrypted = xml;
      break;
    }
  }
  if (!nonce || encType === undefined) return;
  const aesKey = (encType === 0x02 || encType === 0x12)
    ? deriveAesKey(nonce, password)
    : undefined;
  for (let i = 0; i < frames.length; i++) {
    if (i === nonceIdx) continue;
    const fr = frames[i]!;
    const body = fullBodies[i]!;
    if (body.length === 0) { fr.bodyDecrypted = ""; continue; }
    if (fr.cmdId === 1) { fr.bodyDecrypted = "<redacted>"; continue; }
    let pt: string | undefined;
    try {
      if (encType === 0x00) pt = body.toString("utf8");
      else if (encType === 0x01) pt = bcDecrypt(body, fr.channelId).toString("utf8");
      else if (aesKey) pt = aesDecrypt(body, aesKey).toString("utf8");
    } catch { /* noop */ }
    if (!pt) { fr.bodyDecrypted = ""; continue; }
    fr.bodyDecrypted = pt.trim().startsWith("<")
      ? pt
      : `<binary ${body.length} bytes>`;
  }
}

interface HandlerMatch {
  /** Constant name(s) found in src/protocol/constants.ts */
  constants: string[];
  /** util/api files that reference the constant */
  refs: string[];
}

async function mapCmdIdsToFiles(): Promise<Map<number, HandlerMatch>> {
  const map = new Map<number, HandlerMatch>();
  for (const [cmdId, names] of cmdNames) {
    map.set(cmdId, { constants: names, refs: [] });
  }
  // Walk src/reolink/baichuan/ to find which utility files import each
  // cmd constant. Best-effort: simple grep, no AST.
  const root = path.resolve(__dirname, "../../../../src");
  const targetDirs = [
    path.join(root, "reolink", "baichuan"),
    path.join(root, "reolink", "cgi"),
  ];
  const files: string[] = [];
  for (const dir of targetDirs) {
    if (existsSync(dir)) walk(dir, files);
  }
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(file, "utf8");
    for (const [cmdId, match] of map) {
      for (const name of match.constants) {
        if (text.includes(name)) {
          const rel = path.relative(path.resolve(__dirname, "../../../.."), file);
          if (!match.refs.includes(rel)) match.refs.push(rel);
        }
      }
      void cmdId;
    }
  }
  return map;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

function renderReport(
  args: Args,
  frames: FrameLogEntry[],
  handlerMap: Map<number, HandlerMatch>,
): string {
  const total = frames.length;
  const byCmd = new Map<number, FrameLogEntry[]>();
  for (const f of frames) {
    const arr = byCmd.get(f.cmdId);
    if (arr) arr.push(f);
    else byCmd.set(f.cmdId, [f]);
  }
  // Count frames whose body decrypted to something useful — XML, binary
  // placeholder, or even just non-empty. Frames with zero-length bodies
  // naturally have an empty bodyDecrypted and don't count.
  const decryptedFrames = frames.filter(
    (f) =>
      f.bodyDecrypted &&
      f.bodyDecrypted !== "<redacted>" &&
      f.bodyDecrypted.length > 0,
  ).length;
  const totalNonEmpty = frames.filter((f) => f.bodyLen > 0).length;
  const hasAnyDecrypted = decryptedFrames > 0;
  const distinct = byCmd.size;
  const known: number[] = [];
  const unknown: number[] = [];
  for (const cmdId of byCmd.keys()) {
    if ((cmdNames.get(cmdId) ?? []).length > 0) known.push(cmdId);
    else unknown.push(cmdId);
  }
  known.sort((a, b) => (byCmd.get(b)?.length ?? 0) - (byCmd.get(a)?.length ?? 0));
  unknown.sort((a, b) => (byCmd.get(b)?.length ?? 0) - (byCmd.get(a)?.length ?? 0));

  const lines: string[] = [];
  lines.push(`# pcap-vs-impl report`);
  lines.push("");
  lines.push(`- **File:** \`${path.basename(args.input)}\``);
  lines.push(`- **Total Baichuan frames:** ${total}`);
  lines.push(`- **Distinct cmd_ids:** ${distinct} (known ${known.length}, unknown ${unknown.length})`);
  lines.push(
    `- **Decrypted bodies:** ${decryptedFrames} / ${totalNonEmpty}` +
      (hasAnyDecrypted
        ? ""
        : args.input.endsWith(".json")
          ? " (manifest has no decrypted bodies — re-export the capture from a manager that has the camera credentials)"
          : " (no password supplied — pass `--password` to decrypt)"),
  );
  lines.push("");

  lines.push(`## Known commands`);
  lines.push("");
  lines.push(`| cmd_id | name | count | handler files | sample body |`);
  lines.push(`|---|---|---|---|---|`);
  for (const cmdId of known) {
    const items = byCmd.get(cmdId)!;
    const names = cmdNames.get(cmdId)!.join(" / ");
    const handler = handlerMap.get(cmdId)?.refs.slice(0, 3).map((r) => `\`${r}\``).join(", ") ?? "—";
    const sample = pickBodySample(items);
    lines.push(
      `| ${cmdId} | ${names} | ${items.length} | ${handler} | ${escapeMd(sample)} |`,
    );
  }
  lines.push("");

  lines.push(`## Unknown commands`);
  lines.push("");
  if (unknown.length === 0) {
    lines.push(`*All cmd_ids in this capture are recognized.*`);
  } else {
    lines.push(`| cmd_id | count | direction | bodyLen | guess | sample body |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const cmdId of unknown) {
      const items = byCmd.get(cmdId)!;
      const dir = items[0]?.direction ?? "?";
      const bodyLen = items[0]?.bodyLen ?? 0;
      const sample = pickBodySample(items);
      const guess = guessShape(items);
      lines.push(
        `| ${cmdId} | ${items.length} | ${dir} | ${bodyLen} | ${guess} | ${escapeMd(sample)} |`,
      );
    }
  }
  lines.push("");

  lines.push(`## Suggested actions`);
  lines.push("");
  if (unknown.length > 0) {
    lines.push(`### New cmd_ids to map`);
    lines.push("");
    for (const cmdId of unknown) {
      const items = byCmd.get(cmdId)!;
      const guess = guessShape(items);
      const dir = items[0]?.direction ?? "?";
      const sample = pickBodySample(items);
      lines.push(`- **cmd_${cmdId}** (${items.length}× ${dir}, ${guess}) — pick a constant name in \`src/protocol/constants.ts\`. Sample body:`);
      lines.push(`  \`\`\``);
      lines.push(`  ${truncate(sample, 200)}`);
      lines.push(`  \`\`\``);
    }
  }

  // Spot known cmd_ids with no handler reference — they're declared but not
  // wired into a util. Worth confirming the public API uses them.
  const orphans = known.filter((id) => (handlerMap.get(id)?.refs.length ?? 0) === 0);
  if (orphans.length > 0) {
    lines.push("");
    lines.push(`### Known cmd_ids without an obvious handler reference`);
    lines.push("");
    for (const id of orphans) {
      const names = cmdNames.get(id)!.join(" / ");
      lines.push(`- cmd_${id} (\`${names}\`) — declared but no util file references the constant. Check that the API method actually uses it.`);
    }
  }

  // Decrypted-XML structural validation: for every frame with a decrypted
  // XML body, list the root element so the maintainer can spot ones whose
  // root doesn't match what our parser reads.
  if (decryptedFrames > 0) {
    lines.push("");
    lines.push(`### Decrypted XML root elements`);
    lines.push("");
    lines.push(`| cmd_id | name | XML root | sample frame # |`);
    lines.push(`|---|---|---|---|`);
    const seenRoot = new Set<string>();
    for (const f of frames) {
      if (!f.bodyDecrypted.startsWith("<?xml")) continue;
      const root = extractRootElement(f.bodyDecrypted);
      if (!root) continue;
      const dedupKey = `${f.cmdId}|${root}`;
      if (seenRoot.has(dedupKey)) continue;
      seenRoot.add(dedupKey);
      const names = cmdNames.get(f.cmdId)?.join(" / ") ?? "(unknown)";
      lines.push(`| ${f.cmdId} | ${names} | \`<${root}>\` | ${f.idx} |`);
    }
  }

  return lines.join("\n") + "\n";
}

function pickBodySample(items: FrameLogEntry[]): string {
  // Prefer the longest decrypted XML across all frames — most information per
  // line. Skip "<redacted>" (login bodies) and "<binary N bytes>" placeholders.
  let best: string | undefined;
  for (const it of items) {
    if (!it.bodyDecrypted || it.bodyDecrypted === "<redacted>") continue;
    if (it.bodyDecrypted.startsWith("<binary")) continue;
    const cleaned = it.bodyDecrypted.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    if (!best || cleaned.length > best.length) best = cleaned;
  }
  if (best) {
    // Truncate aggressively for table cells but keep the structure-revealing
    // prefix (root + first child).
    return best.length <= 120 ? best : best.slice(0, 120) + "…";
  }
  return items[0]?.bodyHex.slice(0, 64) ?? "(empty)";
}

function guessShape(items: FrameLogEntry[]): string {
  const dir = items[0]?.direction ?? "?";
  const msgNum = items[0]?.msgNum ?? 0;
  const bodyLen = items[0]?.bodyLen ?? 0;
  // Look across every frame for the most informative body. Bodies can be:
  //   - pure XML response (<?xml ... <Root>...</Root></body>)
  //   - Extension wrapper + binary payload (cmd_109 / cmd_345 style: XML
  //     prefix declaring channelId then raw bytes after the payloadOffset)
  //   - all-binary (video frames)
  //   - empty (ack / push)
  for (const it of items) {
    if (!it.bodyDecrypted) continue;
    if (it.bodyDecrypted.startsWith("<?xml")) {
      const root = extractRootElement(it.bodyDecrypted);
      // Differentiate <Extension>... + trailing binary from a pure XML body.
      const hasTrailingBinary =
        it.bodyDecrypted.includes("</Extension>") &&
        it.bodyLen >
          (it.bodyDecrypted.indexOf("</Extension>") + "</Extension>".length + 8);
      if (root === "Extension" && hasTrailingBinary) {
        return "Extension XML + binary payload";
      }
      return root ? `XML \`<${root}>\`` : "XML";
    }
  }
  if (bodyLen === 0 && msgNum === 0 && dir === "s2c") return "push event (no body)";
  if (bodyLen === 0) return "ack / heartbeat";
  if (bodyLen > 1000) return "binary blob";
  return "encrypted payload";
}

function extractRootElement(xml: string): string | undefined {
  // Skip the <?xml ... ?> declaration if present.
  const stripped = xml.replace(/^\s*<\?xml[^?]*\?>\s*/, "");
  const m = stripped.match(/^\s*<([a-zA-Z_][\w-]*)/);
  return m?.[1];
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

main().catch((e: unknown) => {
  process.stderr.write(
    `error: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
});
