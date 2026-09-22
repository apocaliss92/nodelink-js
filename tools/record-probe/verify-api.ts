/**
 * Live verification of the NEW typed API against real hardware.
 * Every write is read back and restored.
 */
import * as path from "node:path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { BaichuanRecordConfigError } from "../../src/reolink/baichuan/utils/recordConfig";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const slot = process.argv[2] ?? "TCP";
const channel = Number(process.argv[3] ?? "0");
const api = new ReolinkBaichuanApi({
  host: process.env[`${slot}_HOST`] as string,
  port: 9000,
  username: process.env[`${slot}_USERNAME`] ?? "admin",
  password: process.env[`${slot}_PASSWORD`] ?? "",
  transport: "auto",
  ...(process.env[`${slot}_UID`] ? { uid: process.env[`${slot}_UID`] as string } : {}),
});

await api.login();
const info = await api.getInfo();
console.log(`### ${slot} ch${channel} ${info?.type} ${info?.firmwareVersion}\n`);

console.log("getHddInfo():", JSON.stringify(await api.getHddInfo()));
const limits = await api.getRecordCfgLimits(channel);
console.log("getRecordCfgLimits():", JSON.stringify(limits));

const cfg0 = await api.getRecordCfg(channel);
const rows0 = await api.getRecordScheduleRows(channel);
console.log("baseline cfg:", JSON.stringify(cfg0));
console.log("baseline rows:", rows0.map((r) => (r.index === null ? r.type : `${r.type}[${r.index}]`)).join(","));

const show = (label: string, r: { allApplied: boolean; outcomes: readonly unknown[] }): void =>
  console.log(`\n${label}\n  allApplied=${r.allApplied} ${JSON.stringify(r.outcomes)}`);

// 1. a field the camera honours
show("setRecordCfg packageTime=10", await api.setRecordCfg(channel, { packageTime: 10 }));
show("RESTORE packageTime", await api.setRecordCfg(channel, { packageTime: cfg0.packageTime ?? 5 }));

// 2. THE DEFECT, reproduced: the raw command answers 200 and keeps 10.
const rawBefore = await api.getRecordCfg(channel);
await api.sendXml({
  cmdId: 55,
  channel,
  payloadXml: `<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<RecordCfg version="1.1">\n<channelId>${channel}</channelId>\n<preRecordTime>5</preRecordTime>\n</RecordCfg>\n</body>\n`,
});
const rawAfter = await api.getRecordCfg(channel);
console.log(
  `\nraw cmd 55 preRecordTime=5 (the passthrough a consumer would hand-build)\n  responseCode 200, preRecordTime ${rawBefore.preRecordTime} -> ${rawAfter.preRecordTime}  ${rawAfter.preRecordTime === rawBefore.preRecordTime ? "(SILENTLY DROPPED)" : "(applied)"}`,
);

// 3. the typed setter expresses the same intent honestly
show("setRecordCfg preRecordEnabled=false", await api.setRecordCfg(channel, { preRecordEnabled: false }));
console.log("  read:", JSON.stringify(await api.getRecordCfg(channel)));
show("RESTORE preRecordEnabled=true", await api.setRecordCfg(channel, { preRecordEnabled: true }));
console.log("  read:", JSON.stringify(await api.getRecordCfg(channel)));

// 4. refusals, before the wire
for (const [label, run] of [
  ["cycle=7 (outside cyclelist)", () => api.setRecordCfg(channel, { cycle: 7 })],
  ["mask of 167 chars", () => api.setRecordSchedule(channel, { entries: [{ type: "Normal", valueTable: "1".repeat(167) }] })],
  ["type=bogus", () => api.setRecordSchedule(channel, { entries: [{ type: "bogus", valueTable: "1".repeat(168) }] })],
] as const) {
  try {
    await run();
    console.log(`\nREFUSAL ${label}: !! NOT REFUSED`);
  } catch (e) {
    console.log(`\nREFUSAL ${label}: ${e instanceof BaichuanRecordConfigError ? "refused before the wire" : "UNEXPECTED"} — ${(e as Error).message.slice(0, 120)}`);
  }
}

// 5. a schedule write
const target = rows0.find((r) => r.type === "Normal") ?? rows0[0];
if (target === undefined) throw new Error("no schedule rows");
const normal0 = target.valueTable;
const entryKey = target.index === null ? { type: target.type } : { type: target.type, index: target.index };
show(
  `setRecordSchedule ${target.type} hour0 flipped`,
  await api.setRecordSchedule(channel, { entries: [{ ...entryKey, valueTable: `${normal0[0] === "1" ? "0" : "1"}${normal0.slice(1)}` }] }),
);
show(
  "RESTORE schedule row",
  await api.setRecordSchedule(channel, { entries: [{ ...entryKey, valueTable: normal0 }] }),
);

// 5b. an indexed rule, where the camera has several of one type
const dup = rows0.find(
  (r) => r.index !== null && rows0.filter((o) => o.type === r.type).length > 1 && r.index === 1,
);
if (dup !== undefined) {
  const siblings = () =>
    rows0.filter((r) => r.type === dup.type).map((r) => `${r.index}:${r.valueTable.slice(0, 4)}`).join(" ");
  console.log(`\nindexed rules before: ${dup.type} ${siblings()}`);
  show(
    `setRecordSchedule ${dup.type}[1] hour0 flipped`,
    await api.setRecordSchedule(channel, {
      entries: [{ type: dup.type, index: 1, valueTable: `${dup.valueTable[0] === "1" ? "0" : "1"}${dup.valueTable.slice(1)}` }],
    }),
  );
  const mid = await api.getRecordScheduleRows(channel);
  console.log(
    "  after:",
    mid.filter((r) => r.type === dup.type).map((r) => `${r.index}:${r.valueTable.slice(0, 4)}`).join(" "),
  );
  show(
    `RESTORE ${dup.type}[1]`,
    await api.setRecordSchedule(channel, {
      entries: [{ type: dup.type, index: 1, valueTable: dup.valueTable }],
    }),
  );
}

// 6. final: back to baseline?
const cfgZ = await api.getRecordCfg(channel);
const rowsZ = await api.getRecordScheduleRows(channel);
console.log("\nFINAL cfg == baseline:", JSON.stringify(cfgZ) === JSON.stringify(cfg0), JSON.stringify(cfgZ));
console.log("FINAL rows == baseline:", JSON.stringify(rowsZ) === JSON.stringify(rows0));
process.exit(0);
