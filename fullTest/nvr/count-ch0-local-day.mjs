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

async function countRange(cgi, label, start, end) {
  const main = await cgi.listNvrRecordings({
    channel: 0,
    start,
    end,
    streamType: "main",
    autoSearchByDay: false,
    bypassCache: true,
  });
  const sub = await cgi.listNvrRecordings({
    channel: 0,
    start,
    end,
    streamType: "sub",
    autoSearchByDay: false,
    bypassCache: true,
  });

  const summarize = (arr) => {
    const byPrefix = new Map();
    const byType = new Map();
    const byMount = new Map();
    for (const r of arr) {
      const name = r.fileName;
      if (typeof name === "string") {
        const mount = name.startsWith("/mnt/") ? name.split("/").slice(0, 3).join("/") : "(unknown)";
        byMount.set(mount, (byMount.get(mount) ?? 0) + 1);

        const base = name.split("/").pop() ?? "";
        const m = base.match(/^(\w+)/);
        const prefix = m?.[1] ?? "(none)";
        byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
      }
      const t = r.recordType ?? "(none)";
      byType.set(t, (byType.get(t) ?? 0) + 1);
    }
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { topPrefixes: top(byPrefix), topTypes: top(byType), topMounts: top(byMount) };
  };

  console.log(`\n${label}`);
  console.log("  start:", start.toString(), "|", start.toISOString());
  console.log("  end  :", end.toString(), "|", end.toISOString());
  console.log("  main :", main.length);
  console.log("  sub  :", sub.length);
  console.log("  sum  :", main.length + sub.length);

  if (main[0]) {
    console.log("  sample main keys:", Object.keys(main[0]).slice(0, 30));
    console.log("  sample main fileName:", main[0].fileName);
    console.log("  sample main recordType:", main[0].recordType);
    console.log("  sample main startTimeMs:", main[0].startTimeMs);
  }

  const mainSum = summarize(main);
  const subSum = summarize(sub);
  console.log("  main prefixes:", JSON.stringify(mainSum.topPrefixes));
  console.log("  sub  prefixes:", JSON.stringify(subSum.topPrefixes));
  console.log("  main types:", JSON.stringify(mainSum.topTypes));
  console.log("  sub  types:", JSON.stringify(subSum.topTypes));
  console.log("  main mounts:", JSON.stringify(mainSum.topMounts));
  console.log("  sub  mounts:", JSON.stringify(subSum.topMounts));

  const chunkSizesSec = [60, 120, 180, 300];
  const chunked = {};
  for (const sec of chunkSizesSec) {
    const sizeMs = sec * 1000;
    let c = 0;
    for (const r of main) {
      const d = typeof r.durationMs === "number" && r.durationMs > 0 ? r.durationMs : 0;
      c += Math.max(1, Math.ceil(d / sizeMs));
    }
    chunked[`${sec}s`] = c;
  }
  console.log("  main chunkedCount (ceil(duration/chunk)):", JSON.stringify(chunked));

  const times = main
    .map((r) => r.startTimeMs)
    .filter((t) => typeof t === "number" && Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length > 0) {
    console.log("  main minStart:", new Date(times[0]).toISOString());
    console.log("  main maxStart:", new Date(times[times.length - 1]).toISOString());
  }
}

const cgi = new ReolinkCgiApi({ host, username, password, timeoutMs: 30000 });
await cgi.login();

const now = new Date();
const startToday = dayStartLocal(now);
const startYesterday = new Date(startToday.getTime() - 24 * 60 * 60 * 1000);
const endYesterday = startToday;

await countRange(cgi, "TODAY (local 00:00 -> now)", startToday, now);
await countRange(cgi, "YESTERDAY (local full day)", startYesterday, endYesterday);

await cgi.logout().catch(() => {});
