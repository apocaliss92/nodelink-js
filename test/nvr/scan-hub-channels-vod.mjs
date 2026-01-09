import "dotenv/config";
import { ReolinkCgiApi } from "../../dist/index.js";

const host = process.env.NVR_HOST;
const username = process.env.NVR_USERNAME || "admin";
const password = process.env.NVR_PASSWORD;

if (host == null || host === "" || password == null || password === "") {
  throw new Error("Missing NVR_HOST/NVR_PASSWORD");
}

function dayStartLocal(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

const cgi = new ReolinkCgiApi({ host, username, password, timeoutMs: 30000 });
await cgi.login();

const now = new Date();
const startToday = dayStartLocal(now);
const startYesterday = new Date(startToday.getTime() - 24 * 60 * 60 * 1000);
const endYesterday = startToday;

async function countCh(ch, start, end) {
  const main = await cgi.listNvrRecordings({ channel: ch, start, end, streamType: "main", autoSearchByDay: false, bypassCache: true });
  const sub = await cgi.listNvrRecordings({ channel: ch, start, end, streamType: "sub", autoSearchByDay: false, bypassCache: true });
  const sample = main[0]?.fileName;
  const base = typeof sample === "string" ? sample.split("/").pop() : undefined;
  const recPrefix = typeof base === "string" ? base.slice(0, 6) : undefined;
  const cameraFolder = typeof sample === "string" ? sample.split("/")[3] : undefined;
  return { ch, main: main.length, sub: sub.length, sum: main.length + sub.length, samplePrefix: recPrefix, cameraFolder, sample };
}

console.log("Scanning channels 0..7 for TODAY range...");
for (let ch = 0; ch < 8; ch++) {
  const r = await countCh(ch, startToday, now).catch((e) => ({ ch, error: e instanceof Error ? e.message : String(e) }));
  console.log(r);
}

console.log("\nScanning channels 0..7 for YESTERDAY range...");
for (let ch = 0; ch < 8; ch++) {
  const r = await countCh(ch, startYesterday, endYesterday).catch((e) => ({ ch, error: e instanceof Error ? e.message : String(e) }));
  console.log(r);
}

await cgi.logout().catch(() => {});
