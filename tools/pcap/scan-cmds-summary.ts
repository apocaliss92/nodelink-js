import { execSync } from "node:child_process";
import { BaichuanFrameParser } from "../../src/index";
import * as constants from "../../src/index";

const file = process.argv[2]!;
const out = execSync(
  `tshark -r "${file}" -Y "tcp.port == 9000" -T fields -e tcp.srcport -e tcp.dstport -e tcp.payload`,
  { maxBuffer: 1024 * 1024 * 200 },
).toString();

const cmdNames = new Map<number, string[]>();
for (const [name, value] of Object.entries(constants as Record<string, unknown>)) {
  if (typeof value !== "number") continue;
  if (!name.startsWith("BC_CMD_ID_")) continue;
  const list = cmdNames.get(value);
  if (list) list.push(name);
  else cmdNames.set(value, [name]);
}

const parsers = new Map<string, BaichuanFrameParser>();
const seen = new Map<number, { count: number; sample: { msgNum: number; respCode: number; bodyLen: number; bodyPreview: string } }>();
let total = 0;

for (const line of out.split("\n")) {
  const parts = line.split("\t");
  if (parts.length < 3) continue;
  const src = parts[0]!.trim();
  const dst = parts[1]!.trim();
  const hex = (parts[2] ?? "").replace(/[^0-9a-fA-F]/g, "");
  if (!hex) continue;
  const buf = Buffer.from(hex, "hex");
  const key = `${src}->${dst}`;
  let parser = parsers.get(key);
  if (!parser) {
    parser = new BaichuanFrameParser();
    parsers.set(key, parser);
  }
  let frames;
  try {
    frames = parser.push(buf);
  } catch { continue; }
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
        bodyPreview: f.body && f.body.length > 0 ? f.body.subarray(0, Math.min(48, f.body.length)).toString("hex") : "",
      },
    });
  }
}

console.log(`Total Baichuan frames: ${total}`);
console.log(`Distinct cmd_ids: ${seen.size}`);
const known: { id: number; n: string[]; count: number }[] = [];
const unknown: { id: number; count: number; sample: typeof seen extends Map<any, infer V> ? V["sample"] : never }[] = [];
for (const [id, v] of seen) {
  const names = cmdNames.get(id);
  if (names && names.length > 0) known.push({ id, n: names, count: v.count });
  else unknown.push({ id, count: v.count, sample: v.sample });
}
known.sort((a, b) => b.count - a.count);
unknown.sort((a, b) => b.count - a.count);
console.log(`\n--- KNOWN (${known.length}) ---`);
for (const k of known) console.log(`  cmd_${k.id}\t${k.count}\t${k.n.join("|")}`);
console.log(`\n--- UNKNOWN (${unknown.length}) ---`);
for (const u of unknown) console.log(`  cmd_${u.id}\t${u.count}\tmsgNum=${u.sample.msgNum} respCode=${u.sample.respCode} bodyLen=${u.sample.bodyLen} preview=${u.sample.bodyPreview}`);
