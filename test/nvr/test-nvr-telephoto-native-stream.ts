#!/usr/bin/env node
/**
 * NVR test: TrackMix / multifocal native telephoto stream investigation.
 *
 * Goal:
 * - Connect to NVR (Baichuan TCP) using NVR_HOST/NVR_USERNAME/NVR_PASSWORD
 * - On channel 2 (0-based by default), start native stream variants:
 *   - default (wide)
 *   - telephoto
 *   - autotrack
 * - Analyze incoming cmd_id=3 push frames (headers + payload heuristics)
 * - Extract H.264 SPS (when available) to estimate resolution and fingerprint (hash)
 * - Probe likely RTSP paths for telephoto/sub variants (best-effort, no Digest auth)
 *
 * Env:
 * - NVR_HOST, NVR_USERNAME, NVR_PASSWORD (required)
 * - NVR_CHANNEL (optional, default 2)
 * - NVR_PROFILE (optional, main|sub, default main)
 * - NVR_STREAM_DURATION_MS (optional, default 6000)
 * - BAICHUAN_MAX_ENC (optional, none|bc|aes|full_aes)
 * - NVR_RTSP_PORT (optional, default 554)
 */

import net from "node:net";
import { createHash } from "node:crypto";

// @ts-expect-error - resolved at runtime from dist output (ESM .js)
import { ReolinkBaichuanApi, BaichuanVideoStream, type BaichuanFrame, splitAnnexBToNalPayloads } from "../../index.js";
import { config } from "../env.js";

interface H264SpsInfo {
  width: number;
  height: number;
  profileIdc: number;
  levelIdc: number;
  spsId: number;
}

function die(msg: string): never {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBasicAuth(user: string, pass: string): string {
  return Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
}

function parseRtspHeaders(raw: string): { statusLine: string; statusCode: number | null; headers: Record<string, string> } {
  const lines = raw.split(/\r?\n/);
  const statusLine = lines[0] ?? "";
  const m = statusLine.match(/RTSP\/[0-9.]+\s+(\d+)/i);
  const statusCode = m ? Number(m[1]) : null;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    if (k) headers[k] = v;
  }
  return { statusLine, statusCode, headers };
}

async function rtspDescribe(params: {
  host: string;
  port: number;
  path: string;
  username: string;
  password: string;
  timeoutMs: number;
}): Promise<{ ok: true; statusLine: string; statusCode: number | null; headers: Record<string, string> } | { ok: false; error: string }> {
  const { host, port, path, username, password, timeoutMs } = params;

  return await new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let raw = "";
    let done = false;

    const finish = (v: any) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(v);
    };

    const t = setTimeout(() => {
      finish({ ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    socket.once("error", (e) => {
      clearTimeout(t);
      finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });

    socket.on("data", (buf) => {
      raw += buf.toString("utf8");
      // First RTSP response headers end at \r\n\r\n
      if (raw.includes("\r\n\r\n") || raw.includes("\n\n")) {
        clearTimeout(t);
        const head = raw.split(/\r?\n\r?\n/)[0] ?? raw;
        const parsed = parseRtspHeaders(head);
        finish({ ok: true, ...parsed });
      }
    });

    socket.once("connect", () => {
      const auth = toBasicAuth(username, password);
      const url = `rtsp://${host}:${port}${path}`;
      const req =
        `DESCRIBE ${url} RTSP/1.0\r\n` +
        `CSeq: 1\r\n` +
        `User-Agent: reolink-baichuan-js-test\r\n` +
        `Accept: application/sdp\r\n` +
        `Authorization: Basic ${auth}\r\n` +
        `\r\n`;
      socket.write(req);
    });
  });
}

// --- Minimal H.264 SPS parsing (width/height) ---
function removeEmulationPreventionBytes(rbsp: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < rbsp.length; i++) {
    if (i >= 2 && rbsp[i] === 0x03 && rbsp[i - 1] === 0x00 && rbsp[i - 2] === 0x00) continue;
    out.push(rbsp[i]!);
  }
  return Buffer.from(out);
}

class BitReader {
  private readonly b: Buffer;
  private bitPos = 0;
  constructor(buf: Buffer) {
    this.b = buf;
  }
  readBits(n: number): number | null {
    if (n <= 0) return 0;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const bytePos = this.bitPos >> 3;
      if (bytePos >= this.b.length) return null;
      const bitInByte = 7 - (this.bitPos & 7);
      const bit = (this.b[bytePos]! >> bitInByte) & 1;
      v = (v << 1) | bit;
      this.bitPos++;
    }
    return v >>> 0;
  }
  readUE(): number | null {
    let zeros = 0;
    while (true) {
      const bit = this.readBits(1);
      if (bit == null) return null;
      if (bit === 0) zeros++;
      else break;
      if (zeros > 31) return null;
    }
    const rest = zeros ? this.readBits(zeros) : 0;
    if (rest == null) return null;
    return ((1 << zeros) - 1 + rest) >>> 0;
  }
  readSE(): number | null {
    const ue = this.readUE();
    if (ue == null) return null;
    const k = (ue + 1) >> 1;
    return (ue & 1) === 0 ? -k : k;
  }
}

function skipScalingList(r: BitReader, count: number): boolean {
  let lastScale = 8;
  let nextScale = 8;
  for (let j = 0; j < count; j++) {
    if (nextScale !== 0) {
      const delta = r.readSE();
      if (delta == null) return false;
      nextScale = (lastScale + delta + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
  return true;
}

function parseH264SpsInfoFromNal(nalPayload: Buffer): H264SpsInfo | null {
  // nalPayload includes nal header byte
  if (nalPayload.length < 4) return null;
  const nalType = (nalPayload[0] ?? 0) & 0x1f;
  if (nalType !== 7) return null;

  const rbsp = removeEmulationPreventionBytes(nalPayload.subarray(1));
  const r = new BitReader(rbsp);

  const profileIdc = r.readBits(8);
  if (profileIdc == null) return null;
  if (r.readBits(8) == null) return null; // constraint flags + reserved
  const levelIdc = r.readBits(8);
  if (levelIdc == null) return null;
  const spsId = r.readUE();
  if (spsId == null) return null;

  let chromaFormatIdc = 1;
  const highProfiles = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
  if (highProfiles.has(profileIdc)) {
    const cfi = r.readUE();
    if (cfi == null) return null;
    chromaFormatIdc = cfi;
    if (chromaFormatIdc === 3) {
      if (r.readBits(1) == null) return null; // separate_colour_plane_flag
    }
    if (r.readUE() == null) return null; // bit_depth_luma_minus8
    if (r.readUE() == null) return null; // bit_depth_chroma_minus8
    if (r.readBits(1) == null) return null; // qpprime_y_zero_transform_bypass_flag
    const scaling = r.readBits(1);
    if (scaling == null) return null;
    if (scaling === 1) {
      const count = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < count; i++) {
        const present = r.readBits(1);
        if (present == null) return null;
        if (present === 1) {
          const sz = i < 6 ? 16 : 64;
          if (!skipScalingList(r, sz)) return null;
        }
      }
    }
  }

  if (r.readUE() == null) return null; // log2_max_frame_num_minus4
  const pocType = r.readUE();
  if (pocType == null) return null;
  if (pocType === 0) {
    if (r.readUE() == null) return null; // log2_max_pic_order_cnt_lsb_minus4
  } else if (pocType === 1) {
    if (r.readBits(1) == null) return null; // delta_pic_order_always_zero_flag
    if (r.readSE() == null) return null; // offset_for_non_ref_pic
    if (r.readSE() == null) return null; // offset_for_top_to_bottom_field
    const n = r.readUE();
    if (n == null) return null;
    for (let i = 0; i < n; i++) {
      if (r.readSE() == null) return null;
    }
  }

  if (r.readUE() == null) return null; // max_num_ref_frames
  if (r.readBits(1) == null) return null; // gaps_in_frame_num_value_allowed_flag

  const picWidthInMbsMinus1 = r.readUE();
  const picHeightInMapUnitsMinus1 = r.readUE();
  if (picWidthInMbsMinus1 == null || picHeightInMapUnitsMinus1 == null) return null;

  const frameMbsOnlyFlag = r.readBits(1);
  if (frameMbsOnlyFlag == null) return null;
  if (frameMbsOnlyFlag === 0) {
    if (r.readBits(1) == null) return null; // mb_adaptive_frame_field_flag
  }
  if (r.readBits(1) == null) return null; // direct_8x8_inference_flag

  const frameCroppingFlag = r.readBits(1);
  if (frameCroppingFlag == null) return null;

  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (frameCroppingFlag === 1) {
    const l = r.readUE();
    const rr = r.readUE();
    const t = r.readUE();
    const b = r.readUE();
    if (l == null || rr == null || t == null || b == null) return null;
    cropLeft = l;
    cropRight = rr;
    cropTop = t;
    cropBottom = b;
  }

  const width = (picWidthInMbsMinus1 + 1) * 16;
  const height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16;

  const cropUnit = (() => {
    if (chromaFormatIdc === 0) return { x: 1, y: 2 - frameMbsOnlyFlag };
    if (chromaFormatIdc === 1) return { x: 2, y: 2 * (2 - frameMbsOnlyFlag) };
    if (chromaFormatIdc === 2) return { x: 2, y: 1 * (2 - frameMbsOnlyFlag) };
    return { x: 1, y: 1 * (2 - frameMbsOnlyFlag) };
  })();

  const croppedWidth = width - (cropLeft + cropRight) * cropUnit.x;
  const croppedHeight = height - (cropTop + cropBottom) * cropUnit.y;

  return { width: croppedWidth, height: croppedHeight, profileIdc, levelIdc, spsId };
}

function findH264SpsInAnnexB(accessUnit: Buffer): Buffer | null {
  try {
    const nals = splitAnnexBToNalPayloads(accessUnit);
    for (const nal of nals) {
      const t = (nal[0] ?? 0) & 0x1f;
      if (t === 7) return nal;
    }
  } catch {
    // ignore
  }
  return null;
}

function sha1Hex(b: Buffer): string {
  return createHash("sha1").update(b).digest("hex");
}

type PushKey = `${number}:${number}:${number}:${number}`; // cmdId:msgNum:streamType:channelId

type VariantCaptureResult = {
  channel: number;
  profile: "main" | "sub";
  variant: "default" | "telephoto" | "autotrack";
  elapsedMs: number;
  firstVideoType: string | null;
  spsHash: string | null;
  spsInfo: H264SpsInfo | null;
  byStreamType: Record<string, number>;
  byMsgNumForCmd3: Record<string, number>;
  topGroups: Array<{ key: PushKey; count: number; sample: any }>;
};

function scanBcMediaMagics(buf: Buffer): { score: number; firstOffset: number; hits: number } {
  if (buf.length < 4) return { score: -1, firstOffset: -1, hits: 0 };
  const maxScan = Math.min(64 * 1024, buf.length - 4);
  let count = 0;
  let first = -1;
  for (let i = 0; i <= maxScan; i++) {
    const magic = buf.readUInt32LE(i);
    const isInfoV1 = magic === 0x31303031; // "1001"
    const isInfoV2 = magic === 0x32303031; // "1002"
    const isIFrame = magic >= 0x63643030 && magic <= 0x63643039; // "cd00".."cd09"
    const isPFrame = magic >= 0x63643130 && magic <= 0x63643139; // "cd10".."cd19"
    const isAac = magic === 0x62773530; // "bw50"
    const isAdpcm = magic === 0x62773130; // "bw10"
    if (isInfoV1 || isInfoV2 || isIFrame || isPFrame || isAac || isAdpcm) {
      count++;
      if (first < 0) first = i;
      if (count > 32 && first === 0) break;
    }
  }
  return { score: count * 1000 - (first < 0 ? 50000 : first), firstOffset: first, hits: count };
}

async function runVariantCapture(params: {
  api: ReolinkBaichuanApi;
  channel: number;
  profile: "main" | "sub";
  variant: "default" | "telephoto" | "autotrack";
  durationMs: number;
}): Promise<VariantCaptureResult> {
  const { api, channel, profile, variant, durationMs } = params;

  const seen = new Map<PushKey, { count: number; firstAtMs: number; sample: any }>();

  const onPush = (frame: BaichuanFrame) => {
    const h = frame.header as any;
    const cmdId = Number(h.cmdId);
    const msgNum = Number(h.msgNum);
    const streamType = Number(h.streamType);
    const channelId = Number(h.channelId);

    const key: PushKey = `${cmdId}:${msgNum}:${streamType}:${channelId}`;
    const cur = seen.get(key);

    if (!cur) {
      let dec: Buffer | null = null;
      try {
        dec = api.client.tryDecryptBinary(frame.body, channelId, api.client.enc);
      } catch {
        dec = null;
      }
      const cand = dec ?? frame.body;
      const magic = scanBcMediaMagics(cand);

      seen.set(key, {
        count: 1,
        firstAtMs: Date.now(),
        sample: {
          cmdId,
          msgNum,
          streamType,
          channelId,
          responseCode: Number(h.responseCode),
          bodyLen: frame.body.length,
          decrypted: dec ? true : false,
          bcMediaLike: magic,
          firstBytesHex: cand.subarray(0, Math.min(24, cand.length)).toString("hex"),
        },
      });
    } else {
      cur.count++;
    }
  };

  api.client.on("push", onPush);

  let spsInfo: H264SpsInfo | null = null;
  let spsHash: string | null = null;
  let firstVideoType: string | null = null;

  const vs = new BaichuanVideoStream({ client: api.client as any, api: api as any, channel, profile, variant, logger: console });

  const onAU = (au: any) => {
    if (!firstVideoType) firstVideoType = au.videoType;
    if (au.videoType !== "H264") return;
    if (spsInfo) return;
    const sps = findH264SpsInAnnexB(au.data);
    if (!sps) return;
    spsHash = sha1Hex(sps);
    spsInfo = parseH264SpsInfoFromNal(sps);
  };

  vs.on("videoAccessUnit" as any, onAU as any);

  console.log("\n" + "=".repeat(90));
  console.log(`[NVR telephoto] START variant=${variant} channel=${channel} profile=${profile}`);

  const activeMsgNumBefore = (api as any).getActiveVideoMsgNumWithVariant?.(channel, profile, variant);
  if (activeMsgNumBefore !== undefined) {
    console.log(`[NVR telephoto] Pre-existing active msgNum for this key: ${activeMsgNumBefore}`);
  }

  const startedAt = Date.now();
  await vs.start();

  // Give it a moment to receive parameter sets / keyframe.
  await sleep(durationMs);

  await vs.stop();
  api.client.off("push", onPush);

  const activeMsgNum = (api as any).getActiveVideoMsgNumWithVariant?.(channel, profile, variant);
  const elapsed = Date.now() - startedAt;

  // Summaries
  const keys = [...seen.entries()].sort((a, b) => b[1].count - a[1].count);
  const top = keys.slice(0, 12).map(([k, v]) => ({ key: k, count: v.count, sample: v.sample }));

  const byStreamType: Record<string, number> = {};
  for (const [, v] of keys) {
    const st = String(v.sample.streamType);
    byStreamType[st] = (byStreamType[st] ?? 0) + v.count;
  }

  // Try to focus on cmd_id=3 only
  const byMsgNumForCmd3: Record<string, number> = {};
  for (const [, v] of keys) {
    if (v.sample.cmdId !== 3) continue;
    const mn = String(v.sample.msgNum);
    byMsgNumForCmd3[mn] = (byMsgNumForCmd3[mn] ?? 0) + v.count;
  }

  console.log(`[NVR telephoto] DONE variant=${variant} elapsedMs=${elapsed}`);
  console.log(`[NVR telephoto] Observed streamTypes (all pushes): ${JSON.stringify(byStreamType)}`);
  console.log(`[NVR telephoto] Observed cmd_id=3 frames by msgNum: ${JSON.stringify(byMsgNumForCmd3)}`);
  if (firstVideoType) console.log(`[NVR telephoto] First decoded videoType: ${firstVideoType}`);

  if (spsHash || spsInfo) {
    console.log(`[NVR telephoto] H264 SPS hash: ${spsHash ?? "(none)"}`);
    let spsParsed = "(unparsed)";
    if ((spsInfo as any) !== null) {
      const s = spsInfo as any as H264SpsInfo;
      spsParsed = `${s.width}x${s.height} (profile=${s.profileIdc}, level=${s.levelIdc}, spsId=${s.spsId})`;
    }
    console.log(`[NVR telephoto] H264 SPS parsed: ${spsParsed}`);
  } else {
    console.log(`[NVR telephoto] No H264 SPS detected (maybe H265 or no keyframe in time)`);
  }

  if (activeMsgNum !== undefined) {
    console.log(`[NVR telephoto] Active msgNum after stop (should usually be undefined): ${activeMsgNum}`);
  }

  console.log(`[NVR telephoto] Top push groups (cmdId:msgNum:streamType:channelId):`);
  console.log(JSON.stringify(top, null, 2));

  return {
    channel,
    profile,
    variant,
    elapsedMs: elapsed,
    firstVideoType,
    spsHash,
    spsInfo,
    byStreamType,
    byMsgNumForCmd3,
    topGroups: top,
  };
}

function expectedStreamTypesForVariant(params: { profile: "main" | "sub"; variant: "default" | "telephoto" | "autotrack" }): number[] {
  // Matches ReolinkBaichuanApi.startVideoStream mapping:
  // default: main->0 sub->1
  // variant: main->2 sub->3
  if (params.variant === "default") return [params.profile === "main" ? 0 : 1];
  return [params.profile === "main" ? 2 : 3];
}

function observedStreamTypesSorted(byStreamType: Record<string, number>): number[] {
  return Object.keys(byStreamType)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

function summarizeSps(spsInfo: H264SpsInfo | null, spsHash: string | null): string {
  if (!spsInfo && !spsHash) return "(no H264 SPS)";
  if (!spsInfo) return `hash=${spsHash ?? "?"} (unparsed)`;
  const s = spsInfo as any as H264SpsInfo;
  return `${s.width}x${s.height} profile=${s.profileIdc} level=${s.levelIdc} spsId=${s.spsId} hash=${spsHash ?? "?"}`;
}

function compareCaptures(wide: VariantCaptureResult, tele: VariantCaptureResult): void {
  console.log("\n" + "=".repeat(90));
  console.log(`[NVR telephoto] WIDE vs TELE comparison (channel=${wide.channel}, profile=${wide.profile})`);

  const wideExpected = expectedStreamTypesForVariant({ profile: wide.profile, variant: "default" });
  const teleExpected = expectedStreamTypesForVariant({ profile: tele.profile, variant: tele.variant });

  const wideObs = observedStreamTypesSorted(wide.byStreamType);
  const teleObs = observedStreamTypesSorted(tele.byStreamType);

  const wideOk = wideExpected.some((t) => wideObs.includes(t));
  const teleOk = teleExpected.some((t) => teleObs.includes(t));

  console.log(
    `[WIDE default] expectedStreamType=${JSON.stringify(wideExpected)} observedStreamTypes=${JSON.stringify(wideObs)} ok=${wideOk}`
  );
  console.log(
    `[TELE ${tele.variant}] expectedStreamType=${JSON.stringify(teleExpected)} observedStreamTypes=${JSON.stringify(teleObs)} ok=${teleOk}`
  );

  console.log(`[WIDE default] cmd_id=3 byMsgNum=${JSON.stringify(wide.byMsgNumForCmd3)}`);
  console.log(`[TELE ${tele.variant}] cmd_id=3 byMsgNum=${JSON.stringify(tele.byMsgNumForCmd3)}`);

  console.log(`[WIDE default] SPS: ${summarizeSps(wide.spsInfo, wide.spsHash)}`);
  console.log(`[TELE ${tele.variant}] SPS: ${summarizeSps(tele.spsInfo, tele.spsHash)}`);

  const spsDiff = (wide.spsHash && tele.spsHash && wide.spsHash !== tele.spsHash) ||
    (wide.spsInfo && tele.spsInfo && (wide.spsInfo.width !== tele.spsInfo.width || wide.spsInfo.height !== tele.spsInfo.height));
  console.log(`[NVR telephoto] Distinction signals: streamTypeDiff=${wideObs.join(",") !== teleObs.join(",")} spsDiff=${Boolean(spsDiff)}`);
}

async function listNvrStreams(params: {
  api: ReolinkBaichuanApi;
  channel: number;
}): Promise<void> {
  const { api, channel } = params;
  console.log("\n" + "=".repeat(90));
  console.log(`[NVR telephoto] Listing RTSP/RTMP/native streams via buildVideoStreamOptions(onNvr=true) channel=${channel}`);

  const wide = await api.buildVideoStreamOptions({ channel, onNvr: true, lens: "default" });
  const tele = await api.buildVideoStreamOptions({ channel, onNvr: true, lens: "telephoto" });

  const fmt = (s: any) => ({
    id: s.id,
    profile: s.profile,
    streamName: s.streamName,
    lens: s.lens,
    path: s.path,
    port: s.port,
    url: s.url,
  });

  console.log(`\n[WIDE] RTSP (${wide.rtspStreams.length})`);
  console.log(JSON.stringify(wide.rtspStreams.map(fmt), null, 2));
  console.log(`\n[WIDE] RTMP (${wide.rtmpStreams.length})`);
  console.log(JSON.stringify(wide.rtmpStreams.map(fmt), null, 2));

  console.log(`\n[TELE] RTSP (${tele.rtspStreams.length})`);
  console.log(JSON.stringify(tele.rtspStreams.map(fmt), null, 2));
  console.log(`\n[TELE] RTMP (${tele.rtmpStreams.length})`);
  console.log(JSON.stringify(tele.rtmpStreams.map(fmt), null, 2));
}

async function probeRtspTelephotoPaths(params: {
  host: string;
  port: number;
  username: string;
  password: string;
  channel: number;
}): Promise<void> {
  const { host, port, username, password, channel } = params;
  const ch = String(channel + 1).padStart(2, "0");

  // Candidates seen in the wild (varies by firmware/NVR):
  // - /h264Preview_<NN>_main|sub
  // - /Preview_<NN>_autotrack (no encoding prefix)
  // - sometimes _sub exists, sometimes not
  const candidates = [
    `/h264Preview_${ch}_main`,
    `/h264Preview_${ch}_sub`,
    `/h265Preview_${ch}_main`,
    `/h265Preview_${ch}_sub`,

    `/Preview_${ch}_autotrack`,
    `/Preview_${ch}_autotrack_sub`,
    `/Preview_${ch}_telephoto`,
    `/Preview_${ch}_telephoto_sub`,

    `/h264Preview_${ch}_autotrack`,
    `/h264Preview_${ch}_autotrack_sub`,
    `/h265Preview_${ch}_autotrack`,
    `/h265Preview_${ch}_autotrack_sub`,

    `/h264Preview_${ch}_telephoto`,
    `/h264Preview_${ch}_telephoto_sub`,
    `/h265Preview_${ch}_telephoto`,
    `/h265Preview_${ch}_telephoto_sub`,
  ];

  console.log("\n" + "=".repeat(90));
  console.log(`[NVR telephoto] RTSP probe host=${host}:${port} channel=${channel} (NN=${ch})`);
  console.log(`[NVR telephoto] Note: probe uses Basic auth only; Digest-only servers will show 401.`);

  for (const path of candidates) {
    const res = await rtspDescribe({ host, port, path, username, password, timeoutMs: 2000 });
    if (res.ok) {
      const wa = res.headers["www-authenticate"] ?? "";
      const server = res.headers["server"] ?? "";
      console.log(`${String(res.statusCode ?? "?").padStart(3, " ")}  ${path}  ${server ? `server=${server} ` : ""}${wa ? `auth=${wa.split(",")[0]}` : ""}`.trim());
    } else {
      console.log(`ERR  ${path}  ${res.error}`);
    }
  }
}

async function main() {
  if (!config.nvr.host) die("Missing NVR_HOST in .env");
  if (!config.nvr.password) die("Missing NVR_PASSWORD in .env");

  const channel = Number.parseInt(process.env.NVR_CHANNEL ?? "2", 10);
  const singleProfile = (process.env.NVR_PROFILE ?? "").trim().toLowerCase();
  const profile = (singleProfile || "main") as "main" | "sub";
  const durationMs = Number.parseInt(process.env.NVR_STREAM_DURATION_MS ?? "6000", 10);
  const rtspPort = Number.parseInt(process.env.NVR_RTSP_PORT ?? "554", 10);

  if (!Number.isFinite(channel) || channel < 0) die(`Invalid NVR_CHANNEL: ${process.env.NVR_CHANNEL}`);
  if (singleProfile && profile !== "main" && profile !== "sub") die(`Invalid NVR_PROFILE: ${process.env.NVR_PROFILE} (expected main|sub)`);

  const api = new ReolinkBaichuanApi({
    host: config.nvr.host,
    username: config.nvr.username,
    password: config.nvr.password,
    transport: "tcp",
    debug: false,
  });

  const maxEnc = (process.env.BAICHUAN_MAX_ENC as any) as "none" | "bc" | "aes" | "full_aes" | undefined;

  try {
    console.log("\n" + "=".repeat(90));
    console.log("NVR TEST: TELEPHOTO NATIVE STREAM (packet analysis)");
    console.log("=".repeat(90));
    console.log(`Host: ${config.nvr.host}`);
    console.log(`User: ${config.nvr.username}`);
    console.log(`Channel: ${channel} (0-based)`);
    console.log(`Profile(s): ${singleProfile ? profile : "main, sub"}`);
    console.log(`Duration: ${durationMs}ms`);

    await api.login(maxEnc ?? "aes");

    // Best-effort: if we can detect multifocal model, print it.
    try {
      const info = await api.getInfo(channel, { tags: ["type", "name"] as any });
      console.log(`[NVR telephoto] getInfo(channel) => ${JSON.stringify(info)}`);
    } catch {
      // ignore
    }

    const profiles: Array<"main" | "sub"> = singleProfile ? [profile] : ["main", "sub"];

    for (const p of profiles) {
      // Run variant captures.
      const wide = await runVariantCapture({ api, channel, profile: p, variant: "default", durationMs });
      const telephoto = await runVariantCapture({ api, channel, profile: p, variant: "telephoto", durationMs });
      const autotrack = await runVariantCapture({ api, channel, profile: p, variant: "autotrack", durationMs });

      // Make the distinction explicit (wide vs tele variants).
      compareCaptures(wide, telephoto);
      compareCaptures(wide, autotrack);
    }

    // List which RTSP/RTMP streams the library thinks are available via NVR.
    await listNvrStreams({ api, channel });

    // RTSP probe for telephoto/sub candidates.
    await probeRtspTelephotoPaths({
      host: config.nvr.host,
      port: rtspPort,
      username: config.nvr.username,
      password: config.nvr.password,
      channel,
    });
  } finally {
    try {
      await api.close();
    } catch {
      // ignore
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
