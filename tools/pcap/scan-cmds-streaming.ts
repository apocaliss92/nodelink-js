/**
 * Streaming variant of scan-cmds-summary that pipes tshark stdout into a
 * BaichuanFrameParser line-by-line, so we can scan multi-hundred-megabyte
 * pcaps without exhausting Node's exec buffer.
 */
import { spawn } from "node:child_process";
import { BaichuanFrameParser } from "../../src/index";
import * as constants from "../../src/index";

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: scan-cmds-streaming.ts <file.pcapng>\n");
  process.exit(1);
}

const cmdNames = new Map<number, string[]>();
for (const [name, value] of Object.entries(constants as Record<string, unknown>)) {
  if (typeof value !== "number") continue;
  if (!name.startsWith("BC_CMD_ID_")) continue;
  const list = cmdNames.get(value);
  if (list) list.push(name);
  else cmdNames.set(value, [name]);
}

const parsers = new Map<string, BaichuanFrameParser>();
const seen = new Map<
  number,
  { count: number; sample: { msgNum: number; respCode: number; bodyLen: number; bodyPreview: string } }
>();
let total = 0;

const args = [
  "-r", file,
  "-Y", "tcp.port == 9000",
  "-T", "fields",
  "-e", "tcp.srcport",
  "-e", "tcp.dstport",
  "-e", "tcp.payload",
  "-l",
];
const proc = spawn("tshark", args, { stdio: ["ignore", "pipe", "pipe"] });
let buf = "";
proc.stdout.on("data", (chunk: Buffer) => {
  const text = buf + chunk.toString("ascii");
  const lines = text.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) handleLine(line);
});
proc.stderr.on("data", (b: Buffer) => process.stderr.write(b));
proc.on("close", () => {
  if (buf.trim()) handleLine(buf);
  printReport();
});

function handleLine(line: string): void {
  const parts = line.split("\t");
  if (parts.length < 3) return;
  const src = parts[0]!.trim();
  const dst = parts[1]!.trim();
  const hex = (parts[2] ?? "").replace(/[^0-9a-fA-F]/g, "");
  if (!hex) return;
  const buffer = Buffer.from(hex, "hex");
  const key = `${src}->${dst}`;
  let parser = parsers.get(key);
  if (!parser) {
    parser = new BaichuanFrameParser();
    parsers.set(key, parser);
  }
  let frames;
  try { frames = parser.push(buffer); } catch { return; }
  for (const f of frames) {
    total++;
    const c = f.header.cmdId;
    const e = seen.get(c);
    if (e) e.count++;
    else seen.set(c, {
      count: 1,
      sample: {
        msgNum: f.header.msgNum,
        respCode: f.header.responseCode,
        bodyLen: f.header.bodyLen,
        bodyPreview: f.body && f.body.length > 0
          ? f.body.subarray(0, Math.min(48, f.body.length)).toString("hex")
          : "",
      },
    });
  }
}

function printReport(): void {
  process.stdout.write(`Total Baichuan frames: ${total}\nDistinct cmd_ids: ${seen.size}\n`);
  const known: { id: number; n: string[]; count: number }[] = [];
  const unknown: typeof known = [];
  for (const [id, v] of seen) {
    const names = cmdNames.get(id);
    if (names && names.length > 0) known.push({ id, n: names, count: v.count });
    else unknown.push({ id, n: [], count: v.count });
  }
  known.sort((a, b) => b.count - a.count);
  unknown.sort((a, b) => b.count - a.count);
  process.stdout.write(`\n--- KNOWN (${known.length}) ---\n`);
  for (const k of known) process.stdout.write(`  cmd_${k.id}\t${k.count}\t${k.n.join("|")}\n`);
  process.stdout.write(`\n--- UNKNOWN (${unknown.length}) ---\n`);
  for (const u of unknown) {
    const s = seen.get(u.id)!.sample;
    process.stdout.write(
      `  cmd_${u.id}\t${u.count}\tmsgNum=${s.msgNum} respCode=${s.respCode} bodyLen=${s.bodyLen} preview=${s.bodyPreview}\n`,
    );
  }
}
