import type net from 'node:net';
import netImpl from 'node:net';
import type { ReolinkBaichuanApi, NativeVideoStreamVariant } from '../reolink/baichuan/ReolinkBaichuanApi';
import type { StreamProfile } from '../reolink/baichuan/types';
import { BaichuanVideoStream } from '../baichuan/stream/BaichuanVideoStream';
import { CompositeStream, type CompositeStreamPipOptions } from '../multifocal/compositeStream';
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

export interface Rfc4571ApiFactoryContext {
  channel?: number;
  profile: StreamProfile;
  variant?: NativeVideoStreamVariant;
  composite: boolean;
}

export interface Rfc4571TcpServerOptions {
  /**
   * Base Baichuan API session.
   * Prefer using `getApi` when the caller wants lazy creation and/or to ensure distinct sessions.
   */
  api?: ReolinkBaichuanApi;

  /**
   * Optional API factory. If provided, `createRfc4571TcpServer` will call it once to obtain the base API.
   * This is useful when the caller wants to defer login/session creation until stream startup.
   */
  getApi?: (ctx?: Rfc4571ApiFactoryContext) =>
    | Promise<ReolinkBaichuanApi>
    | ReolinkBaichuanApi;
  /** Channel number. If undefined, uses composite stream (multifocal cameras). */
  channel?: number;
  /** Stream profile. For composite streams, this is used for both wider and tele streams. */
  profile: StreamProfile;
  /** Native-only: TrackMix tele/autotrack variants (usually on NVR/Hub). */
  variant?: NativeVideoStreamVariant;
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
  username: string;
  password: string;
  /** If true, requires authentication before allowing stream access. Default: false. */
  requireAuth?: boolean;

  /** Composite stream options (only used when channel is undefined) */
  compositeOptions?: CompositeStreamPipOptions;

  /** Optional: dedicated APIs for composite wider/tele streams (recommended on NVR/Hub to avoid stream mixing). */
  compositeApis?: {
    widerApi: ReolinkBaichuanApi;
    teleApi: ReolinkBaichuanApi;
  };

  /** Optional composite API factory (called once) to obtain dedicated wider/tele sessions. */
  getCompositeApis?: () =>
    | Promise<{ widerApi: ReolinkBaichuanApi; teleApi: ReolinkBaichuanApi }>
    | { widerApi: ReolinkBaichuanApi; teleApi: ReolinkBaichuanApi };
}

export interface Rfc4571TcpServer {
  host: string;
  port: number;
  sdp: string;
  videoType: VideoType;
  audio?: { codec: 'aac'; sampleRate: number; channels: number };
  username: string;
  password: string;

  server: net.Server;
  videoStream: BaichuanVideoStream | CompositeStream;

  close: (reason?: unknown) => Promise<void>;
}

export async function createRfc4571TcpServer(
  options: Rfc4571TcpServerOptions,
): Promise<Rfc4571TcpServer> {
  const isComposite = options.channel === undefined;

  const apiFactoryCtx: Rfc4571ApiFactoryContext = {
    profile: options.profile,
    composite: isComposite,
    ...(options.channel !== undefined ? { channel: options.channel } : {}),
    ...(options.variant !== undefined ? { variant: options.variant } : {}),
  };

  const baseApi =
    options.api ??
    (await options.getApi?.(apiFactoryCtx));
  if (!baseApi) {
    throw new Error('createRfc4571TcpServer: missing api/getApi');
  }

  const resolvedCompositeApis = options.compositeApis ?? (await options.getCompositeApis?.());

  const {
    channel,
    profile,
    variant,
    logger,
    expectedVideoType,
    host = '127.0.0.1',
    videoPayloadType = 96,
    audioPayloadType = 97,
    keyframeTimeoutMs = 5000,
    uptimeRestartMs: uptimeRestartMsOpt,
    idleTeardownMs = 2500,
    closeApiOnTeardown = true,
    username,
    password,
    requireAuth = false,
    compositeOptions,
  } = options;

  const apisToClose = new Set<ReolinkBaichuanApi>();
  apisToClose.add(baseApi);
  if (resolvedCompositeApis?.widerApi) apisToClose.add(resolvedCompositeApis.widerApi);
  if (resolvedCompositeApis?.teleApi) apisToClose.add(resolvedCompositeApis.teleApi);

  // For composite (ffmpeg) streams, avoid over-aggressive restarts: a short burst of
  // backpressure or a long GOP on join can look like "no activity" even though the pipeline is alive.
  const uptimeRestartMs = uptimeRestartMsOpt ?? (isComposite ? 60_000 : 10_000);
  const variantSuffix = variant && variant !== 'default' ? ` variant=${variant}` : '';
  const logPrefix = isComposite 
    ? `[native-rfc4571 composite profile=${profile}${variantSuffix}]`
    : `[native-rfc4571 ch=${channel} profile=${profile}${variantSuffix}]`;
  const log = (message: string) => {
    try {
      if (logger?.warn) {
        logger.warn(`${logPrefix} ${message}`);
      } else if (logger?.log) {
        logger.log(`${logPrefix} ${message}`);
      }
    } catch {
      // Ignore logging errors if logger is not properly initialized
    }
  };

  log(
    `starting (host=${host} videoPT=${videoPayloadType} audioPT=${audioPayloadType} expectedVideoType=${expectedVideoType ?? 'n/a'} keyframeTimeoutMs=${keyframeTimeoutMs} uptimeRestartMs=${uptimeRestartMs} idleTeardownMs=${idleTeardownMs} composite=${isComposite})`,
  );

  let videoStream: BaichuanVideoStream | CompositeStream;
  let isCompositeStream = false;

  if (isComposite) {
    // Use composite stream for multifocal cameras
    const widerChannel = compositeOptions?.widerChannel ?? 0;
    const teleChannel = compositeOptions?.teleChannel ?? 1;
    // Profile is used for both wider and tele streams
    const widerProfile = profile;
    const teleProfile = profile;

    log(`creating composite stream: wider(ch=${widerChannel}, profile=${widerProfile}), tele(ch=${teleChannel}, profile=${teleProfile})`);

    const widerApi = resolvedCompositeApis?.widerApi ?? baseApi;
    const teleApi = resolvedCompositeApis?.teleApi ?? baseApi;

    // Default behavior: keep `main` untouched (may be H.265), but force H.264 inputs on `sub`.
    // Callers can still override explicitly via compositeOptions.forceH264.
    const forceH264 = compositeOptions?.forceH264;
    const defaultForceH264 = profile === 'sub';

    videoStream = new CompositeStream({
      api: baseApi,
      widerApi,
      teleApi,
      widerChannel,
      teleChannel,
      widerProfile,
      teleProfile,
      pipPosition: compositeOptions?.pipPosition ?? "bottom-right",
      pipSize: compositeOptions?.pipSize ?? 0.25,
      pipMargin: compositeOptions?.pipMargin ?? 10,
      ...(compositeOptions?.onNvr !== undefined ? { onNvr: compositeOptions.onNvr } : {}),
      ...(forceH264 !== undefined ? { forceH264 } : (defaultForceH264 ? { forceH264: true } : {})),
      logger,
    });

    isCompositeStream = true;
    await videoStream.start();
    log('composite stream started; waiting for keyframe to extract parameter sets');
  } else {
    // Use regular BaichuanVideoStream
    const ch = channel!;
    videoStream = new BaichuanVideoStream({
      client: baseApi.client,
      api: baseApi,
      channel: ch,
      profile,
      variant,
      logger,
    });

    await videoStream.start();
    log('baichuan stream started; waiting for keyframe to extract parameter sets');
  }

  const waitForKeyframe = async (): Promise<
    { videoType: VideoType; accessUnit: Buffer } &
      { profileLevelId?: string; h264?: { sps: Buffer; pps: Buffer }; h265?: { vps: Buffer; sps: Buffer; pps: Buffer } }
  > => {
    if (isCompositeStream) {
      // For composite stream, wait for first video frame and extract parameter sets
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timeout waiting for keyframe on composite stream profile=${profile}`));
        }, keyframeTimeoutMs);

        const onError = (e: unknown) => {
          cleanup();
          reject(e instanceof Error ? e : new Error(String(e)));
        };

        const onFrame = (frame: Buffer) => {
          // Composite stream outputs H.264 frames from ffmpeg
          // Extract parameter sets from the first frame
          const videoType: VideoType = 'H264'; // Composite stream always outputs H.264
          
          try {
            const { sps, pps, profileLevelId } = extractH264ParamSetsFromAccessUnit(frame);
            if (!sps || !pps) {
              // Not a keyframe yet, wait for next
              return;
            }
            cleanup();
            resolve({ videoType, accessUnit: frame, ...(profileLevelId ? { profileLevelId } : {}), h264: { sps, pps } });
          } catch (e) {
            // If extraction fails, wait for next frame
            return;
          }
        };

        const onClose = () => {
          cleanup();
          reject(new Error(`Composite stream closed before keyframe (profile=${profile})`));
        };

        const cleanup = () => {
          clearTimeout(timeout);
          (videoStream as CompositeStream).removeListener('error' as any, onError as any);
          (videoStream as CompositeStream).removeListener('videoFrame' as any, onFrame as any);
          (videoStream as CompositeStream).removeListener('close' as any, onClose as any);
        };

        (videoStream as CompositeStream).on('error' as any, onError as any);
        (videoStream as CompositeStream).on('videoFrame' as any, onFrame as any);
        (videoStream as CompositeStream).on('close' as any, onClose as any);
      });
    } else {
      // For regular BaichuanVideoStream
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
          (videoStream as BaichuanVideoStream).removeListener('error' as any, onError as any);
          (videoStream as BaichuanVideoStream).removeListener('videoAccessUnit' as any, onAu as any);
        };

        (videoStream as BaichuanVideoStream).on('error' as any, onError as any);
        (videoStream as BaichuanVideoStream).on('videoAccessUnit' as any, onAu as any);
      });
    }
  };

  let keyframe: Awaited<ReturnType<typeof waitForKeyframe>>;
  try {
    keyframe = await waitForKeyframe();
  } catch (e) {
    // IMPORTANT: if we fail before returning a server handle, no teardown will run.
    // Stop the native/composite stream pipeline here to avoid leaving watchdogs running.
    try {
      await videoStream.stop();
    } catch {
      // ignore
    }

    if (closeApiOnTeardown) {
      await Promise.allSettled(
        Array.from(apisToClose).map(async (a) => {
          try {
            await a.close();
          } catch {
            // ignore
          }
        }),
      );
    }

    throw e;
  }
  if (expectedVideoType && keyframe.videoType !== expectedVideoType) {
    log(`expectedVideoType mismatch (expected=${expectedVideoType} actual=${keyframe.videoType})`);
  }

  log(`video detected: codec=${keyframe.videoType} (primed via keyframe)`);

  // Best-effort framerate for raw elementary-stream input.
  let fps = 25;
  try {
    if (isComposite) {
      // For composite stream, get framerate from wider stream
      const widerChannel = compositeOptions?.widerChannel ?? 0;
      const widerApi = resolvedCompositeApis?.widerApi ?? baseApi;
      const metadata: any = await widerApi.getStreamMetadata(widerChannel);
      const streams: any[] = Array.isArray(metadata)
        ? metadata
        : Array.isArray(metadata?.streams)
          ? metadata.streams
          : [];
      const stream = streams.find((s: any) => s?.profile === profile);
      const fr = Number(stream?.frameRate);
      if (Number.isFinite(fr) && fr > 0) fps = fr;
    } else {
      const metadata: any = await baseApi.getStreamMetadata(channel!);
      const streams: any[] = Array.isArray(metadata)
        ? metadata
        : Array.isArray(metadata?.streams)
          ? metadata.streams
          : [];
      const stream = streams.find((s: any) => s?.profile === profile);
      const fr = Number(stream?.frameRate);
      if (Number.isFinite(fr) && fr > 0) fps = fr;
    }
  } catch {
    // ignore
  }

  log(`video framerate hint: ${fps} fps`);

  // Prime audio: detect ADTS and extract AudioSpecificConfig.
  // Note: CompositeStream doesn't emit audio frames (ffmpeg handles audio internally if needed)
  let audio: { sampleRate: number; channels: number; configHex: string } | undefined;
  const tryPrimeAudio = async (): Promise<typeof audio> => {
    if (isCompositeStream) {
      // Composite stream doesn't emit audio frames separately
      // Audio would need to be extracted from the wider stream if needed
      return undefined;
    }

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
        (videoStream as BaichuanVideoStream).removeListener('audioFrame' as any, onAudio as any);
      };

      (videoStream as BaichuanVideoStream).on('audioFrame' as any, onAudio as any);
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

    // For composite stream, we need to wait for a new keyframe
    // For BaichuanVideoStream, it will emit videoAccessUnit events automatically
    if (isCompositeStream) {
      // Composite stream will emit videoFrame events automatically after restart
      // No need to wait for keyframe here as we'll get frames from ffmpeg
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
      await Promise.allSettled(
        Array.from(apisToClose).map(async (a) => {
          try {
            await a.close();
          } catch {
            // ignore
          }
        }),
      );
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
    const remote = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 'unknown'}`;
    log(`client connecting (remote=${remote} requireAuth=${requireAuth})`);

    const setupClient = () => {
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
      log(`client connected (remote=${remote} clients=${rfcClients})`);
    };

    if (!requireAuth) {
      // No authentication required, setup client immediately
      setupClient();
    } else {
      // Authentication required: expect "username:password\n" as first message
      let authenticated = false;
      let authBuffer = Buffer.alloc(0);
      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          log(`client authentication timeout (remote=${remote})`);
          socket.destroy();
        }
      }, 5000); // 5 second timeout

      const onData = (data: Buffer) => {
        touchActivity();
        
        if (!authenticated) {
          authBuffer = Buffer.concat([authBuffer, data]);
          const authString = authBuffer.toString('utf8');
          const authMatch = authString.match(/^([^:]+):([^\n]+)\n/);
          
          if (authMatch) {
            const [, clientUsername, clientPassword] = authMatch;
            if (clientUsername === username && clientPassword === password) {
              authenticated = true;
              clearTimeout(authTimeout);
              setupClient();
              
              // Remove auth data from buffer and process remaining data
              const authLineLength = authMatch[0].length;
              const remainingData = authBuffer.subarray(authLineLength);
              
              // Replace data handler
              socket.removeListener('data', onData);
              socket.on('data', () => touchActivity());
              
              // Process remaining data if any
              if (remainingData.length > 0) {
                socket.emit('data', remainingData);
              }
            } else {
              log(`client authentication failed (remote=${remote})`);
              socket.destroy();
              return;
            }
          } else if (authBuffer.length > 1024) {
            // Prevent buffer overflow
            log(`client authentication buffer overflow (remote=${remote})`);
            socket.destroy();
            return;
          }
        }
      };

      socket.on('data', onData);
    }

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
  if (isCompositeStream) {
    // Composite stream emits videoFrame (Buffer) - H.264 frames from ffmpeg in Annex-B format
    (videoStream as CompositeStream).on('videoFrame' as any, (frame: Buffer) => {
      touchActivity();
      try {
        // Composite stream always outputs H.264
        // Detect if it's a keyframe by checking for IDR NAL unit (type 5)
        let isKeyframe = false;
        try {
          // Check for start codes and IDR NAL units
          for (let i = 0; i < frame.length - 4; i++) {
            if (frame[i] === 0x00 && frame[i + 1] === 0x00) {
              let nalStart = -1;
              if (frame[i + 2] === 0x01) {
                nalStart = i + 3;
              } else if (frame[i + 2] === 0x00 && frame[i + 3] === 0x01) {
                nalStart = i + 4;
              }
              
              if (nalStart >= 0 && nalStart < frame.length) {
                const nalType = (frame[nalStart] ?? 0) & 0x1f;
                if (nalType === 5) {
                  // IDR NAL unit - this is a keyframe
                  isKeyframe = true;
                  break;
                }
              }
            }
          }
        } catch {
          // If detection fails, assume it's not a keyframe
        }
        muxer.sendVideoAccessUnit('H264', frame, isKeyframe, undefined);
      } catch (e) {
        close(e).catch(() => {});
      }
    });
  } else {
    // BaichuanVideoStream emits videoAccessUnit with metadata
    (videoStream as BaichuanVideoStream).on('videoAccessUnit' as any, (au: any) => {
      touchActivity();
      try {
        muxer.sendVideoAccessUnit(au.videoType, au.data, au.isKeyframe, au.microseconds);
      } catch (e) {
        close(e).catch(() => {});
      }
    });

    if (aacAudio) {
      (videoStream as BaichuanVideoStream).on('audioFrame' as any, (frame: Buffer) => {
        touchActivity();
        try {
          muxer.sendAudioAdtsFrame(frame);
        } catch (e) {
          close(e).catch(() => {});
        }
      });
    }
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
    username,
    password,
    server,
    videoStream,
    close,
  };
}
