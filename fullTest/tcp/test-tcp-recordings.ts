#!/usr/bin/env node
/**
 * Test: list recordings + optional download via Baichuan FileInfoList.
 *
 * Env:
 * - TCP_HOST / TCP_USERNAME / TCP_PASSWORD (required)
 * - TCP_UID (optional, recommended). If missing, falls back to Baichuan GetDevInfo serialNumber.
 * - DOWNLOAD_FIRST=1 to download the first returned recording.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
// @ts-expect-error - Path resolution at runtime
import { ReolinkCgiApi } from "../../index.js";
import { config } from "../env.js";
import * as fs from "node:fs";
import * as path from "node:path";

function die(msg: string): never {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

async function main() {
  if (!config.tcp.host) die("Missing TCP_HOST in .env");
  if (!config.tcp.password) die("Missing TCP_PASSWORD in .env");

  const api = new ReolinkBaichuanApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
    transport: "tcp",
    debug: (process.env.DEBUG ?? "").trim() === "1",
  });

  const extractUidLike = (value: unknown): string | undefined => {
    const seen = new Set<unknown>();
    const walk = (v: unknown): string | undefined => {
      if (v == null) return undefined;
      if (typeof v === "string") {
        const s = v.trim();
        // Typical Reolink UID: uppercase alnum, ~16 chars (e.g. 9527000HZ56U1ORU)
        if (/^[0-9A-Z]{12,24}$/.test(s) && /[A-Z]/.test(s)) return s;
        return undefined;
      }
      if (typeof v !== "object") return undefined;
      if (seen.has(v)) return undefined;
      seen.add(v);

      if (Array.isArray(v)) {
        for (const it of v) {
          const r = walk(it);
          if (r) return r;
        }
        return undefined;
      }

      for (const vv of Object.values(v as Record<string, unknown>)) {
        const r = walk(vv);
        if (r) return r;
      }
      return undefined;
    };
    return walk(value);
  };

  try {
    await api.login();

    const info = await api.getInfo();
    const serial = info.serialNumber ?? "";

    let uid = (process.env.TCP_UID ?? "").trim();
    if (!uid) {
      // Try to discover via HTTP CGI API.
      try {
        const cgi = new ReolinkCgiApi({
          host: config.tcp.host,
          username: config.tcp.username,
          password: config.tcp.password,
          // leave defaults for port/scheme
        });
        await cgi.login();

        // Known from reolink_aio: GetP2p returns the host UID.
        try {
          const p2p = await cgi.call("GetP2p", {});
          uid = extractUidLike(p2p) ?? uid;
        } catch {
          // ignore
        }

        const devInfo = await cgi.GetDevInfo();
        uid = extractUidLike(devInfo) ?? uid;

        if (!uid) {
          const ch = await cgi.GetChannelstatus();
          uid = extractUidLike(ch) ?? uid;
        }

        await cgi.logout().catch(() => undefined);
      } catch {
        // ignore and fallback
      }
    }

    if (!uid) {
      // Try via Baichuan directly (reolink_aio: cmdId=114 maps to GetP2p).
      try {
        const p2pXml = await api.sendXml({ cmdId: 114, timeoutMs: 10_000 });
        uid = extractUidLike(p2pXml) ?? uid;
      } catch {
        // ignore
      }
    }

    // Last resort: use serialNumber (some firmwares accept it as uid).
    if (!uid) uid = serial.trim();

    console.log("\n=== TCP RECORDINGS TEST ===");
    console.log(`host: ${config.tcp.host}`);
    console.log(`dev serialNumber: ${serial}`);
    console.log(`uid used: ${uid || "(missing)"}`);

    if (!uid) {
      die("No UID available. Set TCP_UID in .env (camera UID) and retry.");
    }

    const end = new Date();
    const daysBack = Number.parseInt((process.env.RECORDINGS_DAYS_BACK ?? "2").trim(), 10);
    const days = Number.isFinite(daysBack) && daysBack > 0 ? daysBack : 2;
    // Anchor to local midnight to avoid missing recordings near the rolling boundary.
    const start = new Date(end);
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);

    console.log(`\nListing recordings: ${start.toISOString()} -> ${end.toISOString()}`);

    const files = await api.listRecordings({
      channel: 0,
      uid,
      start,
      end,
      streamType: "mainStream",
      maxIterations: 50,
    });

    console.log(`\nFound ${files.length} recordings`);
    for (const f of files.slice(0, 10)) {
      const size = f.sizeBytes != null ? ` (${f.sizeBytes} bytes)` : "";
      console.log(`- ${f.fileName}${size}`);
    }
    if (files.length > 10) console.log(`... (${files.length - 10} more)`);

    if (files.length === 0) {
      console.log("\n[DIAG] No recordings returned; probing raw FileInfoList responses...");

      const tryOnce = async (label: string, channel: number, uidValue: string, channelIdOverride?: number) => {
        try {
          const openXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<uid>${uidValue}</uid>
<searchAITrack>1</searchAITrack>
<channelId>${channel}</channelId>
<logicChnBitmap>255</logicChnBitmap>
<streamType>mainStream</streamType>
<recordType>manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package</recordType>
<startTime><year>${start.getFullYear()}</year><month>${start.getMonth() + 1}</month><day>${start.getDate()}</day><hour>${start.getHours()}</hour><minute>${start.getMinutes()}</minute><second>${start.getSeconds()}</second></startTime>
<endTime><year>${end.getFullYear()}</year><month>${end.getMonth() + 1}</month><day>${end.getDate()}</day><hour>${end.getHours()}</hour><minute>${end.getMinutes()}</minute><second>${end.getSeconds()}</second></endTime>
</FileInfo>
</FileInfoList>
</body>`;

          const openResp = await api.sendXml({
            cmdId: 14,
            channel,
            ...(channelIdOverride != null ? { channelIdOverride } : {}),
            payloadXml: openXml,
            timeoutMs: 15_000,
          });
          const handle = (openResp.match(/<handle>([^<]+)<\/handle>/)?.[1] ?? "").trim();
          console.log(`\n[DIAG] ${label} (channel=${channel} uid=${uidValue})`);
          console.log(`open handle: ${handle || "(missing)"}`);
          console.log(`open snippet: ${openResp.slice(0, 240).replaceAll("\n", " ")}`);

          if (!handle) return;

          const pageXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FileInfoList version="1.1">
<FileInfo>
<channelId>${channel}</channelId>
<uid>${uidValue}</uid>
<searchAITrack>1</searchAITrack>
<handle>${handle}</handle>
</FileInfo>
</FileInfoList>
</body>`;

          const getResp = await api.sendXml({
            cmdId: 15,
            channel,
            ...(channelIdOverride != null ? { channelIdOverride } : {}),
            payloadXml: pageXml,
            timeoutMs: 15_000,
          });
          const bFinished = (getResp.match(/<bFinished>([^<]+)<\/bFinished>/)?.[1] ?? "").trim();
          const fileName = (getResp.match(/<fileName>([^<]+)<\/fileName>/)?.[1] ?? "").trim();
          console.log(`get bFinished: ${bFinished || "(missing)"}`);
          console.log(`get first fileName: ${fileName || "(none)"}`);
          console.log(`get snippet: ${getResp.slice(0, 240).replaceAll("\n", " ")}`);
        } catch (e) {
          console.log(`\n[DIAG] ${label} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      };

      // Probe common layouts:
      // - channel 0 with plain uid
      // - channels 1..3 with suffixed uid (dual-lens / multi-sensor models)
      for (const ch of [0, 1, 2, 3]) {
        const uidValue = ch === 0 ? uid : `${uid}_${ch}`;
        await tryOnce("default header channelId", ch, uidValue, undefined);
      }
    }

    const doDownload = (process.env.DOWNLOAD_FIRST ?? "").trim() === "1";
    if (doDownload && files[0]) {
      const first = files[0];
      console.log(`\nDownloading first recording: ${first.fileName}`);

      const buf = await api.downloadRecording({
        channel: 0,
        uid,
        fileName: first.fileName,
        fallbackToHttp: false,
        timeoutMs: Number.parseInt((process.env.DOWNLOAD_TIMEOUT_MS ?? "120000").trim(), 10) || 120_000,
      });

      console.log(`Downloaded ${buf.length} bytes`);
      const outDir = path.join(process.cwd(), "test", "recordings", "tcp");
      fs.mkdirSync(outDir, { recursive: true });
      const safeName = first.fileName.replaceAll("/", "_").replaceAll("\\\\", "_");
      const outPath = path.join(outDir, `${safeName}_${Date.now()}.bin`);
      fs.writeFileSync(outPath, buf);
      console.log(`Saved to ${outPath}`);
    } else if (doDownload) {
      console.log("\nNo recordings returned; skipping download.");
    } else {
      console.log("\nSet DOWNLOAD_FIRST=1 to download the first recording.");
    }
  } finally {
    await api.close().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
