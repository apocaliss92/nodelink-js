#!/usr/bin/env node

// @ts-expect-error - Path resolution at runtime
import { ReolinkCgiApi } from "../../index.js";
import { config } from "../env.js";

function safeParseInt(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

async function main(): Promise<void> {
  const { host, username, password } = config.nvr;
  if (!host) throw new Error("Missing NVR_HOST in .env");
  if (!username) throw new Error("Missing NVR_USERNAME in .env");
  if (!password) throw new Error("Missing NVR_PASSWORD in .env");

  const channel = safeParseInt(process.env.NVR_CHANNEL) ?? 0;

  const cgi = new ReolinkCgiApi({
    host,
    username,
    password,
    // Keep output minimal; enable trace only if you want to see prepare requests.
    debugConfig: {
      general: false,
      debugRtsp: false,
      traceNativeStream: false,
      traceRecordings: process.env.TRACE_RECORDINGS === "1",
      traceEvents: false,
      traceTalk: false,
      dumpEnabled: false,
      dumpDir: "",
      dumpBcMedia: false,
      dumpNals: false,
    },
  });

  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

  console.log(`[download-url] host=${host} channel=${channel}`);
  console.log(`[download-url] range start=${start.toISOString()} end=${end.toISOString()}`);

  const recordings = await cgi.listNvrRecordings({
    channel,
    start,
    end,
    streamType: "main",
    autoSearchByDay: true,
    bypassCache: true,
    fetchStreamUrls: false,
  });

  if (!recordings.length) {
    console.log("[download-url] No recordings found in range.");
    await cgi.logout();
    return;
  }

  const r = recordings[0];
  console.log(`[download-url] sample fileName=${r.fileName}`);
  console.log(`[download-url] sample start=${new Date(r.startTimeMs).toISOString()} end=${new Date(r.endTimeMs).toISOString()}`);

  // Build a Download URL from fileName + explicit times (what external integrations typically have).
  // The important behavior we want: for NVR/Hub, Download should prepare-by-default (NvrDownload)
  // so that the resulting `source=` matches what `cmd=Download` expects.
  const downloadUrl = await cgi.getVodUrl(r.fileName, channel, {
    requestType: "Download",
    videoStreamType: "main",
    startTimeObj: new Date(r.startTimeMs),
    endTimeObj: new Date(r.endTimeMs),
    // NOTE: we intentionally do NOT set `prepare: true` here.
  });

  const parsed = new URL(downloadUrl);
  const source = parsed.searchParams.get("source") ?? "";

  console.log(`[download-url] url=${downloadUrl}`);
  console.log(`[download-url] source(param)=${source}`);

  // Also compute what prepareNvrVodDownload returns for the same time window.
  // (Internal helper is private; we access it for test purposes only.)
  const dateToReolinkTime = (cgi as any).dateToReolinkTime?.bind(cgi) as undefined | ((d: Date) => any);
  if (dateToReolinkTime) {
    try {
      const prepared = await cgi.prepareNvrVodDownload(
        channel,
        dateToReolinkTime(new Date(r.startTimeMs)),
        dateToReolinkTime(new Date(r.endTimeMs)),
        "main",
      );
      console.log(`[download-url] prepared(fileName)=${prepared}`);
      console.log(`[download-url] matchesPrepared=${prepared === source}`);
    } catch (e) {
      console.log(
        `[download-url] NOTE: prepareNvrVodDownload failed (device may not support NvrDownload). error=${e instanceof Error ? e.message : String(e)}`
      );
      console.log(`[download-url] matchesPrepared=false`);
    }
  } else {
    console.log("[download-url] NOTE: dateToReolinkTime not accessible; skipping prepared comparison.");
  }

  await cgi.logout();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
