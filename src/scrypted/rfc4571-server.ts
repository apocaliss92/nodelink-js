import type net from 'node:net';
import netImpl from 'node:net';
import type { ReolinkBaichuanApi } from '../reolink/baichuan/ReolinkBaichuanApi';
import type { StreamProfile } from '../reolink/baichuan/types';
import { BaichuanVideoStream } from '../baichuan/stream/BaichuanVideoStream';
import {
  buildRfc4571Sdp,
  extractH264ParamSetsFromAccessUnit,
  extractH265ParamSetsFromAccessUnit,
  parseAdtsHeader,
  Rfc4571Muxer,
  type AudioConfig,
  type VideoParamSets,
  type VideoType,
} from './rfc4571';

export interface ScryptedRfc4571TcpServerOptions {
  api: ReolinkBaichuanApi;
  channel: number;
  profile: StreamProfile;
  logger: Console;

  host?: string;
  videoPayloadType?: number;
  audioPayloadType?: number;

  /** Used only to sanity-check / early-recreate on mismatched cache in callers. */
  expectedVideoType?: VideoType;

  /** How long to wait for an IDR/IRAP to extract parameter sets and produce SDP. */
  keyframeTimeoutMs?: number;

  /**
   * Stream uptime watchdog: if no packets are sent/received for this long,
   * the server will restart its internal pipeline (drop clients, restart the native stream).
   *
   * Default: 10s. Set to 0 to disable.
   */
  uptimeRestartMs?: number;

  /** Optional: auto-close when no clients are connected for a while. */
  idleTeardownMs?: number;

  /** If true (default), closes the passed API when tearing down. */
  closeApiOnTeardown?: boolean;
}

export interface ScryptedRfc4571TcpServer {
  host: string;
  port: number;
  sdp: string;
  videoType: VideoType;
  audio?: { codec: 'aac'; sampleRate: number; channels: number };

  server: net.Server;
  videoStream: BaichuanVideoStream;

  close: (reason?: unknown) => Promise<void>;
}

export async function createScryptedRfc4571TcpServer(
  options: ScryptedRfc4571TcpServerOptions,
): Promise<ScryptedRfc4571TcpServer> {
  const {
    api,
    channel,
    profile,
    logger,
    expectedVideoType,
    host = '127.0.0.1',
    videoPayloadType = 96,
    audioPayloadType = 97,
    keyframeTimeoutMs = 5000,
    uptimeRestartMs = 10_000,
    idleTeardownMs = 2500,
    closeApiOnTeardown = true,
  } = options;

  const logPrefix = `[native-rfc4571 ch=${channel} profile=${profile}]`;
  const log = (message: string) => logger.warn(`${logPrefix} ${message}`);

  log(
    `starting (host=${host} videoPT=${videoPayloadType} audioPT=${audioPayloadType} expectedVideoType=${expectedVideoType ?? 'n/a'} keyframeTimeoutMs=${keyframeTimeoutMs} uptimeRestartMs=${uptimeRestartMs} idleTeardownMs=${idleTeardownMs})`,
  );

  const videoStream = new BaichuanVideoStream({
    client: api.client,
    api,
    channel,
    profile,
    logger,
  });

  await videoStream.start();

  log('baichuan stream started; waiting for keyframe to extract parameter sets');

  const waitForKeyframe = async (): Promise<
    { videoType: VideoType; accessUnit: Buffer } &
      { profileLevelId?: string; h264?: { sps: Buffer; pps: Buffer }; h265?: { vps: Buffer; sps: Buffer; pps: Buffer } }
  > => {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for keyframe on native stream channel=${channel} profile=${profile}`));
      }, keyframeTimeoutMs);

      const onError = (e: unknown) => {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const onAu = (au: any) => {
        if (!au?.isKeyframe) return;
        const videoType = au.videoType as VideoType;
        const accessUnit = au.data as Buffer;

        if (videoType === 'H264') {
          const { sps, pps, profileLevelId } = extractH264ParamSetsFromAccessUnit(accessUnit);
          if (!sps || !pps) return;
          cleanup();
          resolve({ videoType, accessUnit, ...(profileLevelId ? { profileLevelId } : {}), h264: { sps, pps } });
          return;
        }

        const { vps, sps, pps } = extractH265ParamSetsFromAccessUnit(accessUnit);
        if (!vps || !sps || !pps) return;
        cleanup();
        resolve({ videoType, accessUnit, h265: { vps, sps, pps } });
      };

      const cleanup = () => {
        clearTimeout(timeout);
        videoStream.removeListener('error' as any, onError as any);
        videoStream.removeListener('videoAccessUnit' as any, onAu as any);
      };

      videoStream.on('error' as any, onError as any);
      videoStream.on('videoAccessUnit' as any, onAu as any);
    });
  };

  const keyframe = await waitForKeyframe();
  if (expectedVideoType && keyframe.videoType !== expectedVideoType) {
    log(`expectedVideoType mismatch (expected=${expectedVideoType} actual=${keyframe.videoType})`);
  }

  log(`video detected: codec=${keyframe.videoType} (primed via keyframe)`);

  // Best-effort framerate for raw elementary-stream input.
  let fps = 25;
  try {
    const metadata: any = await api.getStreamMetadata(channel);
    const streams: any[] = Array.isArray(metadata)
      ? metadata
      : Array.isArray(metadata?.streams)
        ? metadata.streams
        : [];
    const stream = streams.find((s: any) => s?.profile === profile);
    const fr = Number(stream?.frameRate);
    if (Number.isFinite(fr) && fr > 0) fps = fr;
  } catch {
    // ignore
  }

  log(`video framerate hint: ${fps} fps`);

  // Prime audio: detect ADTS and extract AudioSpecificConfig.
  let audio: { sampleRate: number; channels: number; configHex: string } | undefined;
  const tryPrimeAudio = async (): Promise<typeof audio> => {
    return await new Promise((resolve) => {
      let sawAnyAudio = false;
      let debugLogsLeft = 3;
      const timeout = setTimeout(() => {
        cleanup();
        if (sawAnyAudio) {
          logger.warn('Native audio frames seen but not ADTS AAC; cannot advertise audio track.');
        }
        resolve(undefined);
      }, 5000);

      const onAudio = (frame: Buffer) => {
        sawAnyAudio = true;
        const parsed = parseAdtsHeader(frame);
        if (!parsed) {
          if (debugLogsLeft-- > 0) {
            const head = frame.subarray(0, Math.min(16, frame.length)).toString('hex');
            logger.warn(`Native audioFrame not ADTS: len=${frame.length} head=${head}`);
          }
          return;
        }
        cleanup();
        resolve({ sampleRate: parsed.sampleRate, channels: parsed.channels, configHex: parsed.configHex });
      };

      const cleanup = () => {
        clearTimeout(timeout);
        videoStream.removeListener('audioFrame' as any, onAudio as any);
      };

      videoStream.on('audioFrame' as any, onAudio as any);
    });
  };

  audio = await tryPrimeAudio();

  if (audio) {
    log(`audio detected: codec=aac sampleRate=${audio.sampleRate} channels=${audio.channels}`);
  } else {
    log('audio not detected/advertised (no ADTS AAC config within timeout)');
  }

  const video: VideoParamSets = {
    videoType: keyframe.videoType,
    payloadType: videoPayloadType,
    ...(keyframe.videoType === 'H264'
      ? {
          h264: {
            sps: keyframe.h264!.sps,
            pps: keyframe.h264!.pps,
            ...(keyframe.profileLevelId ? { profileLevelId: keyframe.profileLevelId } : {}),
          },
        }
      : {
          h265: {
            vps: keyframe.h265!.vps,
            sps: keyframe.h265!.sps,
            pps: keyframe.h265!.pps,
          },
        }),
  };

  const aacAudio: AudioConfig | undefined = audio
    ? {
        codec: 'aac',
        payloadType: audioPayloadType,
        sampleRate: audio.sampleRate,
        channels: audio.channels,
        configHex: audio.configHex,
      }
    : undefined;

  const sdp = buildRfc4571Sdp(video, aacAudio);
  const makeMuxer = () => new Rfc4571Muxer(logger, videoPayloadType, aacAudio ? audioPayloadType : undefined, fps);
  let muxer = makeMuxer();

  log(
    `SDP ready (video=${keyframe.videoType}/90000 pt=${videoPayloadType}${aacAudio ? `, audio=aac/${aacAudio.sampleRate}/${aacAudio.channels} pt=${audioPayloadType}` : ', audio=none'})`,
  );

  let rfcClients = 0;
  const sockets = new Set<net.Socket>();
  let idleTeardownTimer: NodeJS.Timeout | undefined;
  let tearingDown = false;
  let restarting = false;

  // Uptime watchdog: touch this on any observed activity (RX/TX).
  let lastActivityMs = Date.now();
  const touchActivity = () => {
    lastActivityMs = Date.now();
  };

  const cancelIdleTeardown = () => {
    if (!idleTeardownTimer) return;
    clearTimeout(idleTeardownTimer);
    idleTeardownTimer = undefined;
  };

  let uptimeTimer: NodeJS.Timeout | undefined;
  const stopUptimeMonitor = () => {
    if (!uptimeTimer) return;
    clearInterval(uptimeTimer);
    uptimeTimer = undefined;
  };
  const startUptimeMonitor = () => {
    if (!uptimeRestartMs || uptimeRestartMs <= 0) return;
    if (uptimeTimer) return;
    const tickMs = Math.max(250, Math.min(1000, Math.floor(uptimeRestartMs / 2)));
    uptimeTimer = setInterval(() => {
      if (tearingDown || restarting) return;
      const idleFor = Date.now() - lastActivityMs;
      if (idleFor < uptimeRestartMs) return;
      restart(new Error(`No stream activity for ${idleFor}ms (threshold=${uptimeRestartMs}ms)`)).catch(() => {});
    }, tickMs);
  };

  const scheduleIdleTeardown = (closeFn: (reason?: unknown) => Promise<void>) => {
    if (!idleTeardownMs) return;
    if (idleTeardownTimer) return;
    idleTeardownTimer = setTimeout(() => {
      idleTeardownTimer = undefined;
      if (rfcClients === 0) closeFn(new Error('No RFC4571 clients (idle)')).catch(() => {});
    }, idleTeardownMs);
  };

  const server = netImpl.createServer();

  const restart = async (reason?: unknown): Promise<void> => {
    if (tearingDown) return;
    if (restarting) return;
    restarting = true;
    touchActivity();

    cancelIdleTeardown();

    const message = (reason as any)?.message || (reason as any)?.toString?.() || reason;
    const address = server.address();
    const addrStr = address && typeof address !== 'string' ? `${address.address}:${address.port}` : 'unbound';
    if (message) log(`uptime watchdog: restarting (addr=${addrStr} clients=${rfcClients} reason=${message})`);
    else log(`uptime watchdog: restarting (addr=${addrStr} clients=${rfcClients})`);

    // Drop clients first: force reconnect and clear muxer state.
    for (const s of Array.from(sockets)) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }
    sockets.clear();

    try {
      muxer.close();
    } catch {
      // ignore
    }
    muxer = makeMuxer();

    // Restart the native stream pipeline (best-effort).
    try {
      await videoStream.stop();
    } catch {
      // ignore
    }
    try {
      await videoStream.start();
    } catch (e) {
      // If restart fails, escalate to teardown so callers don't hang forever.
      restarting = false;
      close(e).catch(() => {});
      return;
    }

    restarting = false;
    touchActivity();
    log('uptime watchdog: restart complete');

    // If no clients are connected after restart, keep existing idle teardown behavior.
    if (rfcClients === 0) scheduleIdleTeardown(close);
  };

  const close = async (reason?: unknown): Promise<void> => {
    if (tearingDown) return;
    tearingDown = true;

    stopUptimeMonitor();
    cancelIdleTeardown();
    const message = (reason as any)?.message || (reason as any)?.toString?.() || reason;
    const address = server.address();
    const addrStr = address && typeof address !== 'string' ? `${address.address}:${address.port}` : 'unbound';
    if (message) log(`teardown requested (addr=${addrStr} clients=${rfcClients} reason=${message})`);
    else log(`teardown requested (addr=${addrStr} clients=${rfcClients})`);

    muxer.close();

    try {
      await videoStream.stop();
    } catch {
      // ignore
    }

    if (closeApiOnTeardown) {
      try {
        await api.close();
      } catch {
        // ignore
      }
    }

    try {
      server.close();
    } catch {
      // ignore
    }

    log('teardown complete');
  };

  server.on('connection', (socket) => {
    touchActivity();
    rfcClients++;
    cancelIdleTeardown();

    sockets.add(socket);

    // Track RX from client (RTCP, keepalives, etc).
    socket.on('data', () => touchActivity());

    // Track TX to client by wrapping socket.write (used by muxer).
    try {
      const origWrite = socket.write.bind(socket) as any;
      (socket as any).write = (...args: any[]) => {
        touchActivity();
        return origWrite(...args);
      };
    } catch {
      // ignore
    }

    muxer.addClient(socket);

    const remote = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 'unknown'}`;
    log(`client connected (remote=${remote} clients=${rfcClients})`);

    let counted = true;
    const dec = () => {
      if (!counted) return;
      counted = false;
      rfcClients = Math.max(0, rfcClients - 1);
      sockets.delete(socket);
      log(`client disconnected (remote=${remote} clients=${rfcClients})`);
      if (rfcClients === 0) scheduleIdleTeardown(close);
    };

    socket.once('close', dec);
    socket.once('error', dec);
  });

  // Attach stream forwarding.
  videoStream.on('videoAccessUnit' as any, (au: any) => {
    touchActivity();
    try {
      muxer.sendVideoAccessUnit(au.videoType, au.data, au.isKeyframe, au.microseconds);
    } catch (e) {
      close(e).catch(() => {});
    }
  });

  if (aacAudio) {
    videoStream.on('audioFrame' as any, (frame: Buffer) => {
      touchActivity();
      try {
        muxer.sendAudioAdtsFrame(frame);
      } catch (e) {
        close(e).catch(() => {});
      }
    });
  }

  videoStream.on('error' as any, (e: unknown) => {
    if (restarting) return;
    close(e).catch(() => {});
  });
  videoStream.on('close' as any, (e: unknown) => {
    if (restarting) return;
    close(e).catch(() => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind RFC TCP server');
  }
  const port = address.port;
  if (!port) throw new Error('Failed to bind RFC TCP server');

  log(`listening (addr=${host}:${port})`);

  const audioInfo = aacAudio ? { codec: 'aac' as const, sampleRate: aacAudio.sampleRate, channels: aacAudio.channels } : undefined;

  // If created with no clients, schedule idle teardown.
  scheduleIdleTeardown(close);
  startUptimeMonitor();

  return {
    host,
    port,
    sdp,
    videoType: keyframe.videoType,
    ...(audioInfo ? { audio: audioInfo } : {}),
    server,
    videoStream,
    close,
  };
}
