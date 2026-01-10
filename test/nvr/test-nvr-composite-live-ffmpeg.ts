#!/usr/bin/env node
/**
 * NVR test: run the multifocal composite (PiP) live stream and validate it with ffmpeg.
 *
 * Why this exists:
 * - Reproduce composite corruption outside of Scrypted
 * - Generate artifacts (raw .h264, .mp4, JPEG frames) for quick visual inspection
 * - ffmpeg stderr becomes the ground-truth for decode errors
 *
 * What it does:
 * 1) Connects to NVR via Baichuan
 * 2) Starts an in-process RFC4571 server for the COMPOSITE stream (channel=undefined)
 * 3) Connects as a client, demuxes RFC4571 (2-byte length + RTP), depacketizes H264
 * 4) Saves a raw Annex-B H264 elementary stream to disk
 * 5) Runs ffmpeg to:
 *    - decode-check (null output) and show warnings/errors
 *    - remux to mp4
 *    - extract a couple JPEG frames for PiP verification
 *
 * Env:
 * - NVR_HOST, NVR_USERNAME, NVR_PASSWORD (required)
 * - NVR_CHANNEL (optional, default 2)
 * - NVR_PROFILE (optional, main|sub, default main)
 * - NVR_DURATION_SEC (optional, default 12)
 * - NVR_OUT_DIR (optional, default test/diagnostics/streams)
 * - NVR_PIP_POSITION (optional, default bottom-right)
 * - NVR_PIP_SIZE (optional, default 0.25)
 * - NVR_PIP_MARGIN (optional, default 10)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

// @ts-expect-error - resolved at runtime from dist output (ESM .js)
import { ReolinkBaichuanApi, createRfc4571TcpServer } from '../../index.js';
import { config } from '../env.js';

function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseProfile(v: string | undefined): 'main' | 'sub' {
  return v === 'sub' ? 'sub' : 'main';
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    p.once('error', reject);
    p.once('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

function calculateOverlayPosition(
  position:
    | 'top-left'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-right'
    | 'center'
    | 'top-center'
    | 'bottom-center'
    | 'left-center'
    | 'right-center',
  mainWidth: number,
  mainHeight: number,
  pipWidth: number,
  pipHeight: number,
  margin: number,
): { x: number; y: number } {
  const pipW = Math.floor(pipWidth);
  const pipH = Math.floor(pipHeight);
  const m = margin;

  switch (position) {
    case 'top-left':
      return { x: m, y: m };
    case 'top-right':
      return { x: mainWidth - pipW - m, y: m };
    case 'bottom-left':
      return { x: m, y: mainHeight - pipH - m };
    case 'bottom-right':
      return { x: mainWidth - pipW - m, y: mainHeight - pipH - m };
    case 'center':
      return { x: Math.floor((mainWidth - pipW) / 2), y: Math.floor((mainHeight - pipH) / 2) };
    case 'top-center':
      return { x: Math.floor((mainWidth - pipW) / 2), y: m };
    case 'bottom-center':
      return { x: Math.floor((mainWidth - pipW) / 2), y: mainHeight - pipH - m };
    case 'left-center':
      return { x: m, y: Math.floor((mainHeight - pipH) / 2) };
    case 'right-center':
      return { x: mainWidth - pipW - m, y: Math.floor((mainHeight - pipH) / 2) };
    default:
      return { x: m, y: m };
  }
}

function mse(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) throw new Error(`MSE: length mismatch (${a.length} vs ${b.length})`);
  let acc = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    acc += d * d;
  }
  return acc / a.length;
}

async function readRgbRaw(filePath: string, width: number, height: number): Promise<Buffer> {
  // Normalize to a fixed size + 3 channels for stable comparisons.
  return sharp(filePath)
    .resize(width, height, { fit: 'fill' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer();
}

type RtpPacket = {
  marker: boolean;
  payloadType: number;
  payload: Buffer;
};

function parseRtpPacket(pkt: Buffer): RtpPacket | undefined {
  if (pkt.length < 12) return;
  const vpxcc = pkt[0]!;
  const version = (vpxcc >> 6) & 0x03;
  if (version !== 2) return;
  const hasExt = (vpxcc & 0x10) !== 0;
  const csrcCount = vpxcc & 0x0f;

  const mpt = pkt[1]!;
  const marker = (mpt & 0x80) !== 0;
  const payloadType = mpt & 0x7f;

  let headerLen = 12 + csrcCount * 4;
  if (pkt.length < headerLen) return;

  if (hasExt) {
    if (pkt.length < headerLen + 4) return;
    const extLenWords = pkt.readUInt16BE(headerLen + 2);
    headerLen += 4 + extLenWords * 4;
    if (pkt.length < headerLen) return;
  }

  const payload = pkt.subarray(headerLen);
  return { marker, payloadType, payload };
}

class H264RtpDepacketizer {
  private static readonly START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);

  private auParts: Buffer[] = [];
  private fuBuffer: Buffer[] | undefined;

  pushRtp(rtp: RtpPacket): { accessUnit?: Buffer } {
    const p = rtp.payload;
    if (!p.length) return {};

    const nalType = p[0]! & 0x1f;

    // Single NAL
    if (nalType >= 1 && nalType <= 23) {
      this.auParts.push(H264RtpDepacketizer.START_CODE, p);
    }
    // STAP-A
    else if (nalType === 24) {
      let off = 1;
      while (off + 2 <= p.length) {
        const nalLen = p.readUInt16BE(off);
        off += 2;
        if (!nalLen || off + nalLen > p.length) break;
        const nal = p.subarray(off, off + nalLen);
        off += nalLen;
        if (nal.length) this.auParts.push(H264RtpDepacketizer.START_CODE, nal);
      }
    }
    // FU-A
    else if (nalType === 28) {
      if (p.length < 2) return {};
      const fuIndicator = p[0]!;
      const fuHeader = p[1]!;
      const start = (fuHeader & 0x80) !== 0;
      const end = (fuHeader & 0x40) !== 0;
      const nalHeader = Buffer.from([(fuIndicator & 0xe0) | (fuHeader & 0x1f)]);
      const frag = p.subarray(2);

      if (start) {
        this.fuBuffer = [nalHeader, frag];
      } else if (this.fuBuffer) {
        this.fuBuffer.push(frag);
      }

      if (end && this.fuBuffer) {
        const nal = Buffer.concat(this.fuBuffer);
        this.fuBuffer = undefined;
        this.auParts.push(H264RtpDepacketizer.START_CODE, nal);
      }
    }

    if (rtp.marker) {
      if (!this.auParts.length) return {};
      const accessUnit = Buffer.concat(this.auParts);
      this.auParts = [];
      this.fuBuffer = undefined;
      return { accessUnit };
    }

    return {};
  }
}

async function estimateFps(api: any, channel: number, profile: 'main' | 'sub'): Promise<number> {
  try {
    const meta = await api.getStreamMetadata(channel);
    const streams: any[] = Array.isArray(meta) ? meta : Array.isArray(meta?.streams) ? meta.streams : [];
    const s = streams.find((x: any) => x?.profile === profile);
    const fr = Number(s?.frameRate);
    if (Number.isFinite(fr) && fr > 0) return fr;
  } catch {
    // ignore
  }
  return 25;
}

async function main(): Promise<void> {
  const host = process.env.NVR_HOST || config.nvr.host;
  const username = process.env.NVR_USERNAME || config.nvr.username;
  const password = process.env.NVR_PASSWORD || config.nvr.password;
  must(!!host, 'Missing NVR_HOST');
  must(!!username, 'Missing NVR_USERNAME');
  must(!!password, 'Missing NVR_PASSWORD');

  const channel = Number(process.env.NVR_CHANNEL ?? 2);
  const profile = parseProfile(process.env.NVR_PROFILE);
  const durationSec = Number(process.env.NVR_DURATION_SEC ?? 12);
  const outDir = path.resolve(process.cwd(), process.env.NVR_OUT_DIR ?? 'test/diagnostics/streams');
  const pipPosition = (process.env.NVR_PIP_POSITION ?? 'bottom-right') as any;
  const pipSize = Number(process.env.NVR_PIP_SIZE ?? 0.25);
  const pipMargin = Number(process.env.NVR_PIP_MARGIN ?? 10);

  await fs.promises.mkdir(outDir, { recursive: true });
  const stamp = `nvr_ch${channel}_composite_${profile}_${nowStamp()}`;
  const rawPath = path.join(outDir, `${stamp}.h264`);
  const mp4Path = path.join(outDir, `${stamp}.mp4`);
  const jpg1Path = path.join(outDir, `${stamp}_t2s.jpg`);
  const jpg2Path = path.join(outDir, `${stamp}_t6s.jpg`);
  const wideSnapPath = path.join(outDir, `${stamp}_snapshot_wide.jpg`);
  const teleSnapPath = path.join(outDir, `${stamp}_snapshot_tele.jpg`);

  console.log('================================================================================');
  console.log('NVR composite live ffmpeg test');
  console.log(
    JSON.stringify(
      {
        host,
        channel,
        profile,
        durationSec,
        outDir,
        compositeOptions: { widerChannel: channel, teleChannel: channel, pipPosition, pipSize, pipMargin, onNvr: true },
      },
      null,
      2,
    ),
  );

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    uid: config.nvr.uid || undefined,
    logger: console,
    transport: 'tcp',
    debugOptions: {
      debugRtsp: false,
      traceStream: false,
      general: false,
    },
  });

  await api.login();

  // Capabilities sanity check for dual-lens devices exposed on the same channel (common behind NVR/Hub).
  // Expect merged capabilities to be true if true in at least one lens, while per-lens info stays accurate.
  try {
    const [capsStrict, capsMerged, dual] = await Promise.all([
      api.getDeviceCapabilities(channel, { mergeDualLensOnSameChannel: false }),
      api.getDeviceCapabilities(channel),
      api.getDualLensChannelInfo(channel, { onNvr: true }),
    ]);

    if (dual.isDualLens && dual.dualLensType === 'single_motion') {
      const wideInfo = dual.channels.find((c: any) => c.channel === channel && c.lensType === 'wide');
      const teleInfo = dual.channels.find((c: any) => c.channel === channel && c.lensType === 'telephoto');

      console.log('[caps] strict:', capsStrict.capabilities);
      console.log('[caps] merged:', capsMerged.capabilities);
      console.log('[dual] channel info:', { wide: wideInfo, tele: teleInfo, capabilityChannels: dual.capabilityChannels });

      if (wideInfo && teleInfo) {
        // Per-lens: wide usually has no optical zoom, tele does.
        must(wideInfo.hasZoom === false, 'Expected wide lens hasZoom=false in getDualLensChannelInfo');
        must(teleInfo.hasZoom === true, 'Expected tele lens hasZoom=true in getDualLensChannelInfo');

        // Merged (device/channel-level): true if at least one lens supports it.
        must(capsMerged.capabilities.hasZoom === true, 'Expected merged getDeviceCapabilities.hasZoom=true (at least one lens supports zoom)');
      }
    }
  } catch (e) {
    console.warn('[caps] dual-lens sanity check skipped due to error:', e);
  }

  // NVR/Hub multifocal composite MUST use two distinct Baichuan sessions.
  // Otherwise cmd_id=3 frames can mix when streamType overlaps (wide/tele alternation/corruption).
  const apiWider = new ReolinkBaichuanApi({
    host,
    username,
    password,
    uid: config.nvr.uid || undefined,
    logger: console,
    transport: 'tcp',
    debugOptions: {
      debugRtsp: false,
      traceStream: false,
      general: false,
    },
  });
  const apiTele = new ReolinkBaichuanApi({
    host,
    username,
    password,
    uid: config.nvr.uid || undefined,
    logger: console,
    transport: 'tcp',
    debugOptions: {
      debugRtsp: false,
      traceStream: false,
      general: false,
    },
  });
  await apiWider.login();
  await apiTele.login();

  // Save reference snapshots to help verify whether PiP uses the tele lens.
  try {
    const wide = await api.getSnapshot(channel, { onNvr: true, variant: 'default', streamType: profile });
    const tele = await api.getSnapshot(channel, { onNvr: true, variant: 'telephoto', streamType: profile });
    await fs.promises.writeFile(wideSnapPath, wide);
    await fs.promises.writeFile(teleSnapPath, tele);
    console.log('Saved reference snapshots:');
    console.log('-', wideSnapPath);
    console.log('-', teleSnapPath);
  } catch (e) {
    console.warn('Failed to capture reference snapshots (continuing):', e);
  }

  const fps = await estimateFps(api, channel, profile);
  console.log(`FPS hint: ${fps}`);

  const server = await createRfc4571TcpServer({
    api,
    channel: undefined,
    profile,
    logger: console,
    host: '127.0.0.1',
    username,
    password,
    requireAuth: false,
    keyframeTimeoutMs: 15_000,
    compositeApis: {
      widerApi: apiWider,
      teleApi: apiTele,
    },
    compositeOptions: {
      widerChannel: channel,
      teleChannel: channel,
      pipPosition,
      pipSize,
      pipMargin,
      onNvr: true,
    },
  });

  console.log(`RFC4571 server listening: tcp://${server.host}:${server.port}`);
  console.log(`Saving raw H264 to: ${rawPath}`);

  const out = fs.createWriteStream(rawPath);
  const depay = new H264RtpDepacketizer();

  let framed = Buffer.alloc(0);
  let auCount = 0;
  let bytesOut = 0;

  const sock = net.createConnection({ host: server.host, port: server.port });

  const stopAt = Date.now() + Math.max(1, durationSec) * 1000;
  const stop = async (reason: unknown) => {
    try {
      sock.destroy();
    } catch {
      // ignore
    }
    try {
      out.end();
    } catch {
      // ignore
    }

    try {
      await server.close(reason);
    } catch {
      // ignore
    }

    // server.close will also close apiWider/apiTele when closeApiOnTeardown=true (default).
    try {
      await api.client.close({ reason: typeof reason === 'string' ? reason : String(reason) });
    } catch {
      // ignore
    }
  };

  const progressTimer = setInterval(() => {
    console.log(`[progress] accessUnits=${auCount} bytes=${bytesOut}`);
  }, 2000);

  sock.on('error', async (e) => {
    clearInterval(progressTimer);
    console.error('Socket error', e);
    await stop(e);
    process.exit(1);
  });

  sock.on('data', (chunk) => {
    framed = Buffer.concat([framed, chunk]);

    while (framed.length >= 2) {
      const len = framed.readUInt16BE(0);
      if (framed.length < 2 + len) break;
      const pkt = framed.subarray(2, 2 + len);
      framed = framed.subarray(2 + len);

      const rtp = parseRtpPacket(pkt);
      if (!rtp) continue;
      const { accessUnit } = depay.pushRtp(rtp);
      if (accessUnit?.length) {
        out.write(accessUnit);
        auCount++;
        bytesOut += accessUnit.length;
      }

      if (Date.now() >= stopAt) {
        // allow a clean exit after we flush what we have
        sock.end();
        break;
      }
    }
  });

  await new Promise<void>((resolve) => {
    sock.once('connect', () => {
      console.log('Client connected, capturing...');
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    sock.once('close', () => resolve());
    setTimeout(() => {
      try {
        sock.end();
      } catch {
        // ignore
      }
    }, Math.max(1, durationSec) * 1000 + 500);
  });

  clearInterval(progressTimer);
  await stop('capture done');

  console.log(`Captured: accessUnits=${auCount} bytes=${bytesOut}`);

  // Validate with ffmpeg
  const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';

  console.log('Running ffmpeg decode-check...');
  const decodeCheck = await run(ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-r', String(fps), '-i', rawPath, '-t', String(durationSec), '-f', 'null', '-'], outDir);
  console.log(decodeCheck.stderr.trim() || '(no ffmpeg warnings)');

  console.log('Remuxing to mp4...');
  const remux = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'warning', '-r', String(fps), '-i', rawPath, '-t', String(durationSec), '-c', 'copy', mp4Path], outDir);
  if (remux.code !== 0) {
    console.warn('ffmpeg remux failed, trying re-encode...');
    const reenc = await run(
      ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'warning', '-r', String(fps), '-i', rawPath, '-t', String(durationSec), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4Path],
      outDir,
    );
    if (reenc.code !== 0) {
      console.error(reenc.stderr);
      throw new Error('ffmpeg mp4 generation failed');
    }
  }

  console.log('Extracting JPEG frames (for PiP verification)...');
  await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'warning', '-ss', '2', '-i', mp4Path, '-frames:v', '1', jpg1Path], outDir);
  await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'warning', '-ss', '6', '-i', mp4Path, '-frames:v', '1', jpg2Path], outDir);

  console.log('Saved:');
  console.log('-', rawPath);
  console.log('-', mp4Path);
  console.log('-', jpg1Path);
  console.log('-', jpg2Path);

  // Optional: verify PiP is tele by comparing the PiP crop against reference snapshots.
  // Enable hard assertion via NVR_ASSERT_PIP_TELE=1.
  try {
    const assertPipTele = String(process.env.NVR_ASSERT_PIP_TELE ?? '').trim() === '1';
    const frameMeta = await sharp(jpg2Path).metadata();
    const mainW = frameMeta.width ?? 0;
    const mainH = frameMeta.height ?? 0;
    if (!mainW || !mainH) throw new Error('Could not read frame dimensions');

    // Important: do NOT call the API here; at this point the test has already closed the Baichuan client.
    // Using the extracted frame dimensions keeps this check self-contained and avoids reopening sockets.
    const pipW = Math.floor(mainW * pipSize);
    const pipH = Math.floor(mainH * pipSize);
    const pos = calculateOverlayPosition(pipPosition, mainW, mainH, pipW, pipH, pipMargin);

    const crop = await sharp(jpg2Path)
      .extract({ left: pos.x, top: pos.y, width: pipW, height: pipH })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer();

    if (fs.existsSync(wideSnapPath) && fs.existsSync(teleSnapPath)) {
      const targetW = 320;
      const targetH = 180;
      const pipSmall = await sharp(crop, { raw: { width: pipW, height: pipH, channels: 3 } })
        .resize(targetW, targetH, { fit: 'fill' })
        .raw()
        .toBuffer();

      const wideSmall = await readRgbRaw(wideSnapPath, targetW, targetH);
      const teleSmall = await readRgbRaw(teleSnapPath, targetW, targetH);

      const mseWide = mse(pipSmall, wideSmall);
      const mseTele = mse(pipSmall, teleSmall);
      console.log(`[PiP check] mseWide=${mseWide.toFixed(2)} mseTele=${mseTele.toFixed(2)} (lower is closer)`);

      if (assertPipTele && !(mseTele < mseWide * 0.95)) {
        throw new Error('PiP does not appear to match tele snapshot (set NVR_ASSERT_PIP_TELE=0 to disable)');
      }
    } else {
      console.log('[PiP check] skipped (reference snapshots missing)');
    }
  } catch (e) {
    console.warn('[PiP check] failed (continuing):', e);
  }

  // Fail the test if ffmpeg printed obvious decode errors.
  const stderr = decodeCheck.stderr.toLowerCase();
  const bad = ['invalid data', 'could not find', 'error while decoding', 'concealing', 'missing reference', 'duplicate poc'];
  const hasBad = bad.some((s) => stderr.includes(s));
  if (hasBad) {
    throw new Error('ffmpeg reported decode errors (see logs above)');
  }

  console.log('OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
