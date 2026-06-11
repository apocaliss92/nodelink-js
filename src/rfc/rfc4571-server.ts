import type net from "node:net";
import netImpl from "node:net";
import type { ReolinkBaichuanApi } from "../reolink/baichuan/ReolinkBaichuanApi";
import type { NativeVideoStreamVariant } from "../reolink/baichuan/types";
import type { StreamProfile } from "../reolink/baichuan/types";
import type { BaichuanClient } from "../client/BaichuanClient";
import { BaichuanVideoStream } from "../baichuan/stream/BaichuanVideoStream";
import {
  CompositeStream,
  type CompositeStreamPipOptions,
} from "../multifocal/compositeStream";
import {
  buildRfc4571Sdp,
  buildAacAudioSpecificConfigHex,
  extractH264ParamSetsFromAccessUnit,
  extractH265ParamSetsFromAccessUnit,
  parseAdtsHeader,
  Rfc4571Muxer,
  type AudioConfig,
  type VideoParamSets,
  type VideoType,
} from "./rfc4571";
// (no RTSP URL helpers needed here: we reuse buildVideoStreamOptions)

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
  getApi?: (
    ctx?: Rfc4571ApiFactoryContext,
  ) => Promise<ReolinkBaichuanApi> | ReolinkBaichuanApi;
  /** Channel number. If undefined, uses composite stream (multifocal cameras). */
  channel?: number;
  /** Stream profile. For composite streams, this selects the tele profile; wider is forced to `sub` (unless `ext`). */
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

  /**
   * Optional identifier for the requested stream. Used to infer composite profile pairing
   * (e.g. "composite-native-default-sub-sub", "composite-rtsp-default-sub-sub").
   */
  requestedId?: string;

  /**
   * Optional AAC hint for when the camera sends raw AAC (no ADTS headers).
   * Many Reolink devices use AAC-LC mono at 8000Hz.
   */
  aacAudioHint?: { sampleRate: number; channels: number };

  /** Optional: dedicated APIs for composite wider/tele streams (recommended on NVR/Hub to avoid stream mixing). */
  compositeApis?: {
    widerApi: ReolinkBaichuanApi;
    teleApi: ReolinkBaichuanApi;
  };

  /** Optional composite API factory (called once) to obtain dedicated wider/tele sessions. */
  getCompositeApis?: () =>
    | Promise<{ widerApi: ReolinkBaichuanApi; teleApi: ReolinkBaichuanApi }>
    | { widerApi: ReolinkBaichuanApi; teleApi: ReolinkBaichuanApi };

  /**
   * External identifier for dedicated socket session.
   * When provided, a dedicated BaichuanClient is created for this deviceId.
   * This allows multiple concurrent streams without interference.
   * The dedicated socket is automatically closed when the stream ends.
   */
  deviceId?: string;
}

export interface Rfc4571TcpServer {
  host: string;
  port: number;
  sdp: string;
  videoType: VideoType;
  audio?: { codec: "aac"; sampleRate: number; channels: number };
  username: string;
  password: string;

  server: net.Server;
  videoStream: BaichuanVideoStream | CompositeStream;

  close: (reason?: unknown) => Promise<void>;
}

export async function createRfc4571TcpServer(
  options: Rfc4571TcpServerOptions,
): Promise<Rfc4571TcpServer> {
  const sharedProcessId =
    typeof process !== "undefined" && typeof process.pid === "number"
      ? process.pid
      : "n/a";
  const sharedInstanceId = (() => {
    try {
      const g = globalThis as any;
      const k = "__nodelink_rfc4571_shared_instance_id__";
      if (!g[k]) {
        g[k] = Math.random().toString(16).slice(2);
      }
      return String(g[k]);
    } catch {
      return "n/a";
    }
  })();

  const sharedLog = (message: string) => {
    try {
      const logger: any = options.logger;
      const prefix = `[native-rfc4571 shared pid=${sharedProcessId} inst=${sharedInstanceId}]`;
      // Scrypted frequently suppresses debug logs; prefer info/log so traces are visible.
      if (logger?.info) logger.info(`${prefix} ${message}`);
      else if (logger?.log) logger.log(`${prefix} ${message}`);
      else if (logger?.debug) logger.debug(`${prefix} ${message}`);
    } catch {
      // ignore
    }
  };

  // For dedicated sockets (deviceId), idleTeardownMs MUST NOT be 0.
  // If the RFC4571 server never tears down, the dedicated Baichuan session is never
  // released and the device accumulates active sessions over time.
  const normalizeDedicatedIdleTeardownMs = (ms: number | undefined): number => {
    if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return ms;
    return 15_000;
  };

  // When deviceId is provided, callers may request the *same* native stream multiple
  // times using different external identifiers. That can lead to duplicate RFC4571
  // servers and therefore duplicate dedicated Baichuan sessions.
  //
  // To prevent this, we share a single RFC4571 server per stable stream identity.
  // Each caller gets a ref-counted handle; the underlying server is closed only when
  // all handles are released.
  const sharedKey = buildSharedRfc4571Key(options);
  if (!sharedKey) {
    sharedLog(
      "disabled (no deviceId); using unshared RFC4571 server for this request",
    );
    return await createRfc4571TcpServerInternal(options);
  }

  sharedLog(
    `request key=${formatSharedKeyForLog(sharedKey)} (requestedId=${options.requestedId ?? "n/a"})`,
  );

  const existing = sharedRfc4571Servers.get(sharedKey);
  if (existing && existing.server.server.listening) {
    sharedLog(
      `reuse existing host=${existing.server.host} port=${existing.server.port} refCount=${existing.refCount}`,
    );
    return acquireSharedRfc4571Handle(sharedKey, existing, sharedLog);
  }
  if (existing) {
    // Stale entry.
    sharedLog(
      `stale entry found; dropping (listening=${existing.server.server.listening})`,
    );
    sharedRfc4571Servers.delete(sharedKey);
  }

  const inFlight = sharedRfc4571Creates.get(sharedKey);
  if (inFlight) {
    sharedLog("awaiting in-flight create");
    await inFlight;
    const created = sharedRfc4571Servers.get(sharedKey);
    if (created) {
      sharedLog(
        `acquiring after in-flight create host=${created.server.host} port=${created.server.port} refCount=${created.refCount}`,
      );
      return acquireSharedRfc4571Handle(sharedKey, created, sharedLog);
    }
    // Fallback: avoid deadlocks.
    sharedLog(
      "in-flight create completed but no entry found; falling back to unshared",
    );
    return await createRfc4571TcpServerInternal(options);
  }

  const createPromise = (async () => {
    const idleTeardownMs = normalizeDedicatedIdleTeardownMs(
      options.idleTeardownMs,
    );
    sharedLog(
      `creating new shared RFC4571 server (idleTeardownMs=${idleTeardownMs})`,
    );
    const server = await createRfc4571TcpServerInternal({
      ...options,
      // Force a sane idle teardown for dedicated sessions so sockets are released.
      idleTeardownMs,
    });

    const entry: SharedRfc4571Entry = {
      server,
      refCount: 0,
    };
    sharedRfc4571Servers.set(sharedKey, entry);
    sharedLog(`created host=${server.host} port=${server.port}`);

    // Best-effort cleanup if the underlying server tears down itself (errors, watchdog).
    server.server.once("close", () => {
      const current = sharedRfc4571Servers.get(sharedKey);
      if (current?.server === server) {
        sharedLog("underlying server closed; evicting shared cache entry");
        sharedRfc4571Servers.delete(sharedKey);
      }
    });
  })().finally(() => {
    sharedRfc4571Creates.delete(sharedKey);
  });

  sharedRfc4571Creates.set(sharedKey, createPromise);
  await createPromise;

  const created = sharedRfc4571Servers.get(sharedKey);
  if (created) return acquireSharedRfc4571Handle(sharedKey, created, sharedLog);
  return await createRfc4571TcpServerInternal(options);
}

interface SharedRfc4571Entry {
  server: Rfc4571TcpServer;
  refCount: number;
}

const sharedRfc4571Servers = new Map<string, SharedRfc4571Entry>();
const sharedRfc4571Creates = new Map<string, Promise<void>>();

const buildSharedRfc4571Key = (
  options: Rfc4571TcpServerOptions,
): string | undefined => {
  // Only share when deviceId is provided (dedicated sockets).
  if (!options.deviceId) return;

  // This key intentionally ignores external identifiers like requestedId.
  // It captures the stream identity that maps to a single Baichuan live stream.
  const channelKey =
    options.channel === undefined ? "composite" : String(options.channel);
  const variantKey = options.variant ?? "default";

  // IMPORTANT: Do NOT include RFC4571 client auth credentials in the key.
  // Callers may generate a new username/password on each request. If we include them,
  // the key becomes unstable and sharing never happens.
  // The shared server will return its own username/password to the caller.
  const requireAuth = Boolean(options.requireAuth);

  // Include payload types because they affect SDP.
  const videoPayloadType = options.videoPayloadType ?? 96;
  const audioPayloadType = options.audioPayloadType ?? 97;

  return [
    "rfc4571",
    `device:${options.deviceId}`,
    `ch:${channelKey}`,
    `profile:${options.profile}`,
    `variant:${variantKey}`,
    `auth:${requireAuth ? "1" : "0"}`,
    `vpt:${videoPayloadType}`,
    `apt:${audioPayloadType}`,
  ].join("|");
};

const formatSharedKeyForLog = (key: string): string => {
  // Redact any unexpected secrets if the format changes in the future.
  // Current key format doesn't include passwords, but keep this defensive.
  return key.replace(/\|pass:[^|]*/g, "|pass:<redacted>");
};

const acquireSharedRfc4571Handle = (
  key: string,
  entry: SharedRfc4571Entry,
  sharedLog?: (message: string) => void,
): Rfc4571TcpServer => {
  entry.refCount++;
  sharedLog?.(`acquire handle key=${key} refCount=${entry.refCount}`);

  let released = false;
  const serverRef = entry.server;

  const close = async (reason?: unknown): Promise<void> => {
    if (released) return;
    released = true;

    const current = sharedRfc4571Servers.get(key);
    // If the server was already replaced/removed, do not interfere.
    if (!current || current.server !== serverRef) return;

    current.refCount = Math.max(0, current.refCount - 1);
    sharedLog?.(
      `release handle key=${key} refCount=${current.refCount} reason=${String(
        (reason as any)?.message ?? reason ?? "n/a",
      )}`,
    );
    if (current.refCount > 0) return;

    sharedRfc4571Servers.delete(key);
    sharedLog?.("refCount reached 0; closing underlying server");
    await serverRef.close(reason ?? "shared handle released");
  };

  // Provide a handle that shares the underlying server but has an independent close().
  return {
    ...serverRef,
    close,
  };
};

async function createRfc4571TcpServerInternal(
  options: Rfc4571TcpServerOptions,
): Promise<Rfc4571TcpServer> {
  const isComposite = options.channel === undefined;

  const parseCompositeFromRequestedId = (
    requestedId: string | undefined,
  ):
    | {
        source: "native" | "rtsp";
        widerProfile?: StreamProfile;
        teleProfile?: StreamProfile;
      }
    | undefined => {
    if (!requestedId) return;
    const id = String(requestedId);

    const asProfile = (v: string | undefined): StreamProfile | undefined =>
      v === "main" || v === "sub" || v === "ext"
        ? (v as StreamProfile)
        : undefined;

    // Explicit source forms:
    // - composite-native-<wider>-<tele>
    // - composite-native-<variant>-<wider>-<tele>
    // - composite-rtsp-<wider>-<tele>
    // - composite-rtsp-<variant>-<wider>-<tele>
    if (
      id.startsWith("composite-native-") ||
      id.startsWith("composite-rtsp-")
    ) {
      const source: "native" | "rtsp" = id.startsWith("composite-rtsp-")
        ? "rtsp"
        : "native";
      const parts = id.split("-").filter(Boolean);
      // parts[0] === 'composite'
      // parts[1] === 'native' | 'rtsp'
      if (parts.length >= 4) {
        const wider = parts.length >= 5 ? parts[3] : parts[2];
        const tele = parts.length >= 5 ? parts[4] : parts[3];
        const widerProfile = asProfile(wider);
        const teleProfile = asProfile(tele);
        return {
          source,
          ...(widerProfile ? { widerProfile } : {}),
          ...(teleProfile ? { teleProfile } : {}),
        };
      }
      return { source };
    }

    return;
  };

  const apiFactoryCtx: Rfc4571ApiFactoryContext = {
    profile: options.profile,
    composite: isComposite,
    ...(options.channel !== undefined ? { channel: options.channel } : {}),
    ...(options.variant !== undefined ? { variant: options.variant } : {}),
  };

  const baseApi = options.api ?? (await options.getApi?.(apiFactoryCtx));
  if (!baseApi) {
    throw new Error("createRfc4571TcpServer: missing api/getApi");
  }

  const resolvedCompositeApis =
    options.compositeApis ?? (await options.getCompositeApis?.());

  const {
    channel,
    profile,
    variant,
    logger,
    expectedVideoType,
    host = "127.0.0.1",
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
    requestedId,
    aacAudioHint,
  } = options;

  // Track dedicated session if deviceId is provided (for auto-release on close)
  let dedicatedSession:
    | {
        client: BaichuanClient;
        release: () => Promise<void>;
      }
    | undefined;

  const apisToClose = new Set<ReolinkBaichuanApi>();
  apisToClose.add(baseApi);
  if (resolvedCompositeApis?.widerApi)
    apisToClose.add(resolvedCompositeApis.widerApi);
  if (resolvedCompositeApis?.teleApi)
    apisToClose.add(resolvedCompositeApis.teleApi);

  // For composite (ffmpeg) streams, avoid over-aggressive restarts: a short burst of
  // backpressure or a long GOP on join can look like "no activity" even though the pipeline is alive.
  const uptimeRestartMs = uptimeRestartMsOpt ?? (isComposite ? 60_000 : 10_000);
  const variantSuffix =
    variant && variant !== "default" ? ` variant=${variant}` : "";
  const logPrefix = isComposite
    ? `[native-rfc4571 composite profile=${profile}${variantSuffix}${requestedId ? ` id=${requestedId}` : ""}]`
    : `[native-rfc4571 ch=${channel} profile=${profile}${variantSuffix}]`;
  const log = (message: string) => {
    try {
      if (logger?.info) {
        logger.info(`${logPrefix} ${message}`);
      } else if (logger?.log) {
        logger.log(`${logPrefix} ${message}`);
      }
    } catch {
      // Ignore logging errors if logger is not properly initialized
    }
  };

  const logSessionsSummary = (action: string) => {
    const summary = baseApi.getDedicatedSessionsSummary();
    log(
      `${action} [sessions: ${summary.count} active${summary.count > 0 ? ` (${summary.keys.join(", ")})` : ""}]`,
    );
  };

  log(
    `starting (host=${host} videoPT=${videoPayloadType} audioPT=${audioPayloadType} expectedVideoType=${expectedVideoType ?? "n/a"} keyframeTimeoutMs=${keyframeTimeoutMs} uptimeRestartMs=${uptimeRestartMs} idleTeardownMs=${idleTeardownMs} composite=${isComposite})`,
  );

  let videoStream: BaichuanVideoStream | CompositeStream;
  let isCompositeStream = false;

  if (isComposite) {
    // Use composite stream for multifocal cameras
    const widerChannel = compositeOptions?.widerChannel ?? 0;
    const teleChannel = compositeOptions?.teleChannel ?? 1;
    const requested = parseCompositeFromRequestedId(requestedId);
    // `options.profile` is the *output* profile requested by the caller.
    // `requestedId` encodes *input* selection (widerProfile + teleProfile).
    const outputProfile: StreamProfile = profile;
    let teleInputProfile: StreamProfile =
      requested?.teleProfile ?? outputProfile;

    // Default wider selection:
    // - If explicitly requested via id: obey.
    // - Otherwise: for tele=main, prefer wider=main only when it's H.264.
    // - Otherwise: wider=sub (keep ext unchanged).
    let widerMainIsH264 = false;
    try {
      const widerApiForProbe = resolvedCompositeApis?.widerApi ?? baseApi;
      const metadata: any =
        await widerApiForProbe.getStreamMetadata(widerChannel);
      const streams: any[] = Array.isArray(metadata)
        ? metadata
        : Array.isArray(metadata?.streams)
          ? metadata.streams
          : [];
      const main = streams.find((s: any) => s?.profile === "main");
      const enc =
        typeof main?.videoEncType === "string"
          ? main.videoEncType.toLowerCase()
          : "";
      widerMainIsH264 = enc.includes("264");
    } catch {
      // ignore
    }

    let widerInputProfile: StreamProfile =
      requested?.widerProfile ??
      (outputProfile === "ext"
        ? "ext"
        : outputProfile === "main" && widerMainIsH264
          ? "main"
          : "sub");

    if (requested?.teleProfile && requested.teleProfile !== outputProfile) {
      log(
        `requestedId overrides tele INPUT profile (requested=${requested.teleProfile} output=${outputProfile})`,
      );
    }
    log(
      `creating composite stream: outputProfile=${outputProfile} ` +
        `wider(ch=${widerChannel}, profile=${widerInputProfile}), tele(ch=${teleChannel}, profile=${teleInputProfile}) ` +
        `source=${requested?.source ?? "native"} widerMainIsH264=${widerMainIsH264}`,
    );

    const widerApi = resolvedCompositeApis?.widerApi ?? baseApi;
    const teleApi = resolvedCompositeApis?.teleApi ?? baseApi;

    // Default behavior: keep `main` untouched (may be H.265), but force H.264 inputs on `sub`.
    // Callers can still override explicitly via compositeOptions.forceH264.
    const forceH264 = compositeOptions?.forceH264;
    const defaultForceH264 = outputProfile === "sub";

    // Optional: RTSP pair inputs (requested via id: composite-rtsp-...)
    let widerRtspUrl: string | undefined;
    let teleRtspUrl: string | undefined;
    if (requested?.source === "rtsp") {
      const onNvr = Boolean(compositeOptions?.onNvr);

      const resolveLensRtspUrl = async (params: {
        channel: number;
        lens: NativeVideoStreamVariant;
        desiredLens: "wide" | "telephoto";
        profile: StreamProfile;
      }): Promise<{ urlWithAuth: string; actualProfile: StreamProfile }> => {
        const { rtspStreams } = await baseApi.buildVideoStreamOptions({
          channel: params.channel,
          onNvr,
          compositeOnly: false,
          lens: params.lens,
        });

        const candidates = rtspStreams.filter(
          (s) =>
            s.container === "rtsp" &&
            s.lens === params.desiredLens &&
            Boolean(s.urlWithAuth),
        );

        const exact = candidates.find((s) => s.profile === params.profile);
        if (exact?.urlWithAuth) {
          return {
            urlWithAuth: exact.urlWithAuth,
            actualProfile: exact.profile,
          };
        }

        // Some NVR/Hub firmwares expose tele RTSP only as `main` (e.g. Preview_XX_autotrack).
        // If `sub` is requested but missing, fall back to `main`.
        if (params.profile === "sub") {
          const fallbackMain = candidates.find((s) => s.profile === "main");
          if (fallbackMain?.urlWithAuth) {
            return {
              urlWithAuth: fallbackMain.urlWithAuth,
              actualProfile: fallbackMain.profile,
            };
          }
        }

        const available = rtspStreams
          .filter(
            (s) => s.container === "rtsp" && s.lens === params.desiredLens,
          )
          .map((s) => `${s.profile}:${s.id}`)
          .join(", ");

        throw new Error(
          `Requested composite RTSP inputs, but no RTSP ${params.desiredLens} stream found for channel=${params.channel} profile=${params.profile} (onNvr=${onNvr}). ` +
            `Available: [${available || "none"}]. ` +
            `Use composite-native-... or choose a different profile.`,
        );
      };

      // Wider lens always uses the default lens variant.
      const widerResolved = await resolveLensRtspUrl({
        channel: widerChannel,
        lens: "default",
        desiredLens: "wide",
        profile: widerInputProfile,
      });

      widerRtspUrl = widerResolved.urlWithAuth;
      widerInputProfile = widerResolved.actualProfile;

      // Tele lens can be on a distinct channel (standalone) or share the same channel (NVR/Hub).
      const teleResolved = await resolveLensRtspUrl({
        channel: teleChannel,
        lens: "telephoto",
        desiredLens: "telephoto",
        profile: teleInputProfile,
      });

      teleRtspUrl = teleResolved.urlWithAuth;
      if (teleResolved.actualProfile !== teleInputProfile) {
        log(
          `tele RTSP profile fallback applied (requested=${teleInputProfile} actual=${teleResolved.actualProfile})`,
        );
      }
      teleInputProfile = teleResolved.actualProfile;
    }

    videoStream = new CompositeStream({
      api: baseApi,
      widerApi,
      teleApi,
      widerChannel,
      teleChannel,
      widerProfile: widerInputProfile,
      teleProfile: teleInputProfile,
      ...(widerRtspUrl && teleRtspUrl ? { widerRtspUrl, teleRtspUrl } : {}),
      ...(compositeOptions?.rtspTransport
        ? { rtspTransport: compositeOptions.rtspTransport }
        : {}),
      pipPosition: compositeOptions?.pipPosition ?? "bottom-right",
      pipSize: compositeOptions?.pipSize ?? 0.25,
      // New default is percent-friendly (1%). Values > 1 are still treated as pixels.
      pipMargin: compositeOptions?.pipMargin ?? 0.01,
      ...(compositeOptions?.onNvr !== undefined
        ? { onNvr: compositeOptions.onNvr }
        : {}),
      ...(forceH264 !== undefined
        ? { forceH264 }
        : defaultForceH264
          ? { forceH264: true }
          : {}),
      ...(compositeOptions?.assumeH264Inputs !== undefined
        ? { assumeH264Inputs: compositeOptions.assumeH264Inputs }
        : {}),
      ...(compositeOptions?.disableTranscode !== undefined
        ? { disableTranscode: compositeOptions.disableTranscode }
        : {}),
      // Propagate ffmpeg binary path — required when the embedder strips
      // PATH (Scrypted on Windows, Electron sandboxes, distroless Docker)
      // and the bundled ffmpeg is at a fixed absolute path only the
      // embedder knows.
      ...(compositeOptions?.ffmpegPath
        ? { ffmpegPath: compositeOptions.ffmpegPath }
        : {}),
      // Encoder tuning knobs — see CompositeStreamPipOptions for the
      // semantic contract on each one. Plumbed verbatim so the
      // CompositeStream layer can apply defaults.
      ...(compositeOptions?.videoEncoder
        ? { videoEncoder: compositeOptions.videoEncoder }
        : {}),
      ...(compositeOptions?.encoderPreset
        ? { encoderPreset: compositeOptions.encoderPreset }
        : {}),
      ...(typeof compositeOptions?.crf === "number"
        ? { crf: compositeOptions.crf }
        : {}),
      ...(typeof compositeOptions?.gopSeconds === "number"
        ? { gopSeconds: compositeOptions.gopSeconds }
        : {}),
      ...(compositeOptions?.extraGlobalArgs
        ? { extraGlobalArgs: compositeOptions.extraGlobalArgs }
        : {}),
      ...(compositeOptions?.extraOutputArgs
        ? { extraOutputArgs: compositeOptions.extraOutputArgs }
        : {}),
      logger,
    });

    isCompositeStream = true;
    await videoStream.start();
    log(
      "composite stream started; waiting for keyframe to extract parameter sets",
    );
  } else {
    // Use regular BaichuanVideoStream
    const ch = channel!;

    // If deviceId is provided, create a dedicated socket session for this stream.
    // This allows multiple concurrent streams without interference.
    // BaichuanVideoStream now passes client to startVideoStream/stopVideoStream,
    // so commands go to the correct socket.
    const deviceId = options.deviceId;
    let streamClient: BaichuanClient;

    if (deviceId) {
      const sessionKey = `live:${deviceId}:ch${ch}:${profile}${variant && variant !== "default" ? `:${variant}` : ""}`;
      dedicatedSession = await baseApi.createDedicatedSession(
        sessionKey,
        logger,
      );
      streamClient = dedicatedSession.client;
      logSessionsSummary(`dedicated session created: ${sessionKey}`);
    } else {
      streamClient = baseApi.client;
    }

    videoStream = new BaichuanVideoStream({
      client: streamClient,
      api: baseApi,
      channel: ch,
      profile,
      variant,
      logger,
    });

    await videoStream.start();
    log(
      `stream started (ch=${ch} profile=${profile}${deviceId ? ` dedicated=${deviceId}` : ""})`,
    );
  }

  const waitForKeyframe = async (): Promise<
    { videoType: VideoType; accessUnit: Buffer } & {
      profileLevelId?: string;
      h264?: { sps: Buffer; pps: Buffer };
      h265?: { vps: Buffer; sps: Buffer; pps: Buffer };
    }
  > => {
    if (isCompositeStream) {
      // For composite stream, wait for first video frame and extract parameter sets
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              `Timeout waiting for keyframe on composite stream profile=${profile}`,
            ),
          );
        }, keyframeTimeoutMs);

        const onError = (e: unknown) => {
          cleanup();
          reject(e instanceof Error ? e : new Error(String(e)));
        };

        const onFrame = (frame: Buffer) => {
          // Composite stream outputs H.264 frames from ffmpeg
          // Extract parameter sets from the first frame
          const videoType: VideoType = "H264"; // Composite stream always outputs H.264

          try {
            const { sps, pps, profileLevelId } =
              extractH264ParamSetsFromAccessUnit(frame);
            if (!sps || !pps) {
              // Not a keyframe yet, wait for next
              return;
            }
            cleanup();
            resolve({
              videoType,
              accessUnit: frame,
              ...(profileLevelId ? { profileLevelId } : {}),
              h264: { sps, pps },
            });
          } catch (e) {
            // If extraction fails, wait for next frame
            return;
          }
        };

        const onClose = () => {
          cleanup();
          reject(
            new Error(
              `Composite stream closed before keyframe (profile=${profile})`,
            ),
          );
        };

        const cleanup = () => {
          clearTimeout(timeout);
          (videoStream as CompositeStream).removeListener(
            "error" as any,
            onError as any,
          );
          (videoStream as CompositeStream).removeListener(
            "videoFrame" as any,
            onFrame as any,
          );
          (videoStream as CompositeStream).removeListener(
            "close" as any,
            onClose as any,
          );
        };

        (videoStream as CompositeStream).on("error" as any, onError as any);
        (videoStream as CompositeStream).on(
          "videoFrame" as any,
          onFrame as any,
        );
        (videoStream as CompositeStream).on("close" as any, onClose as any);
      });
    } else {
      // For regular BaichuanVideoStream
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              `Timeout waiting for keyframe on native stream channel=${channel} profile=${profile}`,
            ),
          );
        }, keyframeTimeoutMs);

        const onError = (e: unknown) => {
          cleanup();
          reject(e instanceof Error ? e : new Error(String(e)));
        };

        const onAu = (au: any) => {
          if (!au?.isKeyframe) return;
          const videoType = au.videoType as VideoType;
          const accessUnit = au.data as Buffer;

          if (videoType === "H264") {
            const { sps, pps, profileLevelId } =
              extractH264ParamSetsFromAccessUnit(accessUnit);
            if (!sps || !pps) return;
            cleanup();
            resolve({
              videoType,
              accessUnit,
              ...(profileLevelId ? { profileLevelId } : {}),
              h264: { sps, pps },
            });
            return;
          }

          const { vps, sps, pps } =
            extractH265ParamSetsFromAccessUnit(accessUnit);
          if (!vps || !sps || !pps) return;
          cleanup();
          resolve({ videoType, accessUnit, h265: { vps, sps, pps } });
        };

        const cleanup = () => {
          clearTimeout(timeout);
          (videoStream as BaichuanVideoStream).removeListener(
            "error" as any,
            onError as any,
          );
          (videoStream as BaichuanVideoStream).removeListener(
            "videoAccessUnit" as any,
            onAu as any,
          );
        };

        (videoStream as BaichuanVideoStream).on("error" as any, onError as any);
        (videoStream as BaichuanVideoStream).on(
          "videoAccessUnit" as any,
          onAu as any,
        );

        // If the camera already rejected the stream request during start()
        // (e.g. response_code 400), the error was stashed because no listener
        // existed yet. Consume it now to fail fast instead of waiting for the
        // full keyframe timeout.
        const pendingErr = (
          videoStream as BaichuanVideoStream
        ).consumePendingStartupError?.();
        if (pendingErr) {
          cleanup();
          reject(pendingErr);
        }
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

    // Release dedicated session if one was created (prevents session leak).
    if (dedicatedSession) {
      try {
        await dedicatedSession.release();
      } catch {
        // ignore
      }
    }

    // When a dedicated session was used, the baseApi is shared with other streams
    // (events, main/sub). Closing or idle-disconnecting it here would cascade-kill
    // unrelated streams. Only release the dedicated session (above) and leave the
    // shared API untouched.
    if (!dedicatedSession) {
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
      } else {
        // For shared connections (common on battery/BCUDP), we cannot force-close the API here.
        // Instead, ask the underlying client to drop the UDP session soon *if* it is truly idle.
        // This reduces the chance of keeping the camera awake while remaining safe.
        const graceMs = isComposite ? 5_000 : 0;
        for (const a of Array.from(apisToClose)) {
          try {
            (a as any)?.client?.requestIdleDisconnectSoon?.(
              "rfc4571_teardown",
              graceMs,
            );
          } catch {
            // ignore
          }
        }
      }
    }

    throw e;
  }
  if (expectedVideoType && keyframe.videoType !== expectedVideoType) {
    log(
      `expectedVideoType mismatch (expected=${expectedVideoType} actual=${keyframe.videoType})`,
    );
  }

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
      // Note: composite FPS should be keyed off the wider input profile, not the tele profile.
      const requested = parseCompositeFromRequestedId(requestedId);
      const effectiveTeleProfile: StreamProfile =
        requested?.teleProfile ?? profile;
      let widerMainIsH264 = false;
      try {
        const main = streams.find((s: any) => s?.profile === "main");
        const enc =
          typeof main?.videoEncType === "string"
            ? main.videoEncType.toLowerCase()
            : "";
        widerMainIsH264 = enc.includes("264");
      } catch {
        // ignore
      }
      const widerProfile: StreamProfile =
        requested?.widerProfile ??
        (effectiveTeleProfile === "ext"
          ? "ext"
          : effectiveTeleProfile === "main" && widerMainIsH264
            ? "main"
            : "sub");
      const stream = streams.find((s: any) => s?.profile === widerProfile);
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

  // Prime audio: prefer ADTS (self-describing), but support raw AAC by using a hint/default config.
  // Note: CompositeStream may forward native audio frames (typically from wider input).
  let audio:
    | {
        sampleRate: number;
        channels: number;
        configHex: string;
        mode: "adts" | "raw";
      }
    | undefined;
  const tryPrimeAudio = async (): Promise<typeof audio> => {
    return await new Promise((resolve) => {
      let sawAnyAudio = false;
      let debugLogsLeft = 3;
      const audioPrimeTimeoutMs = isCompositeStream
        ? Math.min(10_000, keyframeTimeoutMs)
        : 5000;
      const timeout = setTimeout(() => {
        cleanup();
        if (!sawAnyAudio) {
          resolve(undefined);
          return;
        }

        const hint = aacAudioHint ?? { sampleRate: 8000, channels: 1 };
        const configHex = buildAacAudioSpecificConfigHex({
          sampleRate: hint.sampleRate,
          channels: hint.channels,
        });
        if (!configHex) {
          logger.warn(
            `Native audio frames seen but could not derive AAC config (hint sampleRate=${hint.sampleRate} channels=${hint.channels}); cannot advertise audio track.`,
          );
          resolve(undefined);
          return;
        }

        logger.warn(
          `Native audio frames appear to be raw AAC (no ADTS); advertising AAC using hint sampleRate=${hint.sampleRate} channels=${hint.channels}.`,
        );
        resolve({
          sampleRate: hint.sampleRate,
          channels: hint.channels,
          configHex,
          mode: "raw",
        });
      }, audioPrimeTimeoutMs);

      const onAudio = (frame: Buffer) => {
        sawAnyAudio = true;
        const parsed = parseAdtsHeader(frame);
        if (!parsed) {
          if (debugLogsLeft-- > 0) {
            const head = frame
              .subarray(0, Math.min(16, frame.length))
              .toString("hex");
            logger.warn(
              `Native audioFrame not ADTS: len=${frame.length} head=${head}`,
            );
          }
          return;
        }
        cleanup();
        resolve({
          sampleRate: parsed.sampleRate,
          channels: parsed.channels,
          configHex: parsed.configHex,
          mode: "adts",
        });
      };

      const cleanup = () => {
        clearTimeout(timeout);
        (videoStream as any)?.removeListener?.(
          "audioFrame" as any,
          onAudio as any,
        );
      };

      (videoStream as any)?.on?.("audioFrame" as any, onAudio as any);
    });
  };

  audio = await tryPrimeAudio();

  const video: VideoParamSets = {
    videoType: keyframe.videoType,
    payloadType: videoPayloadType,
    ...(keyframe.videoType === "H264"
      ? {
          h264: {
            sps: keyframe.h264!.sps,
            pps: keyframe.h264!.pps,
            ...(keyframe.profileLevelId
              ? { profileLevelId: keyframe.profileLevelId }
              : {}),
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
        codec: "aac",
        payloadType: audioPayloadType,
        sampleRate: audio.sampleRate,
        channels: audio.channels,
        configHex: audio.configHex,
      }
    : undefined;

  const sdp = buildRfc4571Sdp(video, aacAudio);
  const makeMuxer = () =>
    new Rfc4571Muxer(
      logger,
      videoPayloadType,
      aacAudio ? audioPayloadType : undefined,
      fps,
    );
  let muxer = makeMuxer();

  log(
    `ready (video=${keyframe.videoType} fps=${fps}${aacAudio ? ` audio=aac/${aacAudio.sampleRate}/${aacAudio.channels}` : " audio=none"})`,
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
    const tickMs = Math.max(
      250,
      Math.min(1000, Math.floor(uptimeRestartMs / 2)),
    );
    uptimeTimer = setInterval(() => {
      if (tearingDown || restarting) return;
      const idleFor = Date.now() - lastActivityMs;
      if (idleFor < uptimeRestartMs) return;
      restart(
        new Error(
          `No stream activity for ${idleFor}ms (threshold=${uptimeRestartMs}ms)`,
        ),
      ).catch(() => {});
    }, tickMs);
  };

  const scheduleIdleTeardown = (
    closeFn: (reason?: unknown) => Promise<void>,
  ) => {
    if (!idleTeardownMs) return;
    if (idleTeardownTimer) return;
    idleTeardownTimer = setTimeout(() => {
      idleTeardownTimer = undefined;
      if (rfcClients === 0)
        closeFn(new Error("No RFC4571 clients (idle)")).catch(() => {});
    }, idleTeardownMs);
  };

  const server = netImpl.createServer();

  const restart = async (reason?: unknown): Promise<void> => {
    if (tearingDown) return;
    if (restarting) return;
    restarting = true;
    touchActivity();

    cancelIdleTeardown();

    const message =
      (reason as any)?.message || (reason as any)?.toString?.() || reason;
    const address = server.address();
    const addrStr =
      address && typeof address !== "string"
        ? `${address.address}:${address.port}`
        : "unbound";
    if (message)
      log(
        `uptime watchdog: restarting (addr=${addrStr} clients=${rfcClients} reason=${message})`,
      );
    else
      log(
        `uptime watchdog: restarting (addr=${addrStr} clients=${rfcClients})`,
      );

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
    log("uptime watchdog: restart complete");

    // If no clients are connected after restart, keep existing idle teardown behavior.
    if (rfcClients === 0) scheduleIdleTeardown(close);
  };

  const close = async (reason?: unknown): Promise<void> => {
    if (tearingDown) return;
    tearingDown = true;

    stopUptimeMonitor();
    cancelIdleTeardown();
    const reasonStr =
      (reason as any)?.message ||
      (reason as any)?.toString?.() ||
      reason ||
      "requested";

    muxer.close();

    try {
      await videoStream.stop();
    } catch {
      // ignore
    }

    // Release dedicated session if one was created
    if (dedicatedSession) {
      try {
        await dedicatedSession.release();
        logSessionsSummary("dedicated session released");
      } catch {
        // ignore
      }
    }

    // When a dedicated session was used, the baseApi is shared with other streams
    // (events, main/sub). Closing it here would cascade-kill unrelated streams.
    // Only close APIs when no dedicated session was used (API is owned by this server).
    if (closeApiOnTeardown && !dedicatedSession) {
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

    log(`teardown (${reasonStr})`);
  };

  server.on("connection", (socket) => {
    touchActivity();
    const remote = `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? "unknown"}`;

    const setupClient = () => {
      rfcClients++;
      cancelIdleTeardown();
      sockets.add(socket);

      // Track RX from client (RTCP, keepalives, etc).
      socket.on("data", () => touchActivity());

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
      log(`client connected (${remote} total=${rfcClients})`);
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
          const authString = authBuffer.toString("utf8");
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
              socket.removeListener("data", onData);
              socket.on("data", () => touchActivity());

              // Process remaining data if any
              if (remainingData.length > 0) {
                socket.emit("data", remainingData);
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

      socket.on("data", onData);
    }

    let counted = true;
    const dec = () => {
      if (!counted) return;
      counted = false;
      rfcClients = Math.max(0, rfcClients - 1);
      sockets.delete(socket);
      log(`client disconnected (${remote} total=${rfcClients})`);
      if (rfcClients === 0) scheduleIdleTeardown(close);
    };

    socket.once("close", dec);
    socket.once("error", dec);
  });

  // Attach stream forwarding.
  if (isCompositeStream) {
    // Composite stream emits videoFrame (Buffer) - H.264 frames from ffmpeg in Annex-B format
    (videoStream as CompositeStream).on(
      "videoFrame" as any,
      (frame: Buffer) => {
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
          muxer.sendVideoAccessUnit("H264", frame, isKeyframe, undefined);
        } catch (e) {
          close(e).catch(() => {});
        }
      },
    );

    if (aacAudio) {
      (videoStream as CompositeStream).on(
        "audioFrame" as any,
        (frame: Buffer) => {
          touchActivity();
          try {
            if (audio?.mode === "adts") {
              muxer.sendAudioAdtsFrame(frame);
            } else {
              muxer.sendAudioAacRawFrame(frame);
            }
          } catch (e) {
            close(e).catch(() => {});
          }
        },
      );
    }
  } else {
    // BaichuanVideoStream emits videoAccessUnit with metadata
    (videoStream as BaichuanVideoStream).on(
      "videoAccessUnit" as any,
      (au: any) => {
        touchActivity();
        try {
          muxer.sendVideoAccessUnit(
            au.videoType,
            au.data,
            au.isKeyframe,
            au.microseconds,
          );
        } catch (e) {
          close(e).catch(() => {});
        }
      },
    );

    if (aacAudio) {
      (videoStream as BaichuanVideoStream).on(
        "audioFrame" as any,
        (frame: Buffer) => {
          touchActivity();
          try {
            if (audio?.mode === "adts") {
              muxer.sendAudioAdtsFrame(frame);
            } else {
              muxer.sendAudioAacRawFrame(frame);
            }
          } catch (e) {
            close(e).catch(() => {});
          }
        },
      );
    }
  }

  videoStream.on("error" as any, (e: unknown) => {
    if (restarting) return;
    close(e).catch(() => {});
  });
  videoStream.on("close" as any, (e: unknown) => {
    if (restarting) return;
    close(e).catch(() => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind RFC TCP server");
  }
  const port = address.port;
  if (!port) throw new Error("Failed to bind RFC TCP server");

  log(`listening (addr=${host}:${port})`);

  const audioInfo = aacAudio
    ? {
        codec: "aac" as const,
        sampleRate: aacAudio.sampleRate,
        channels: aacAudio.channels,
      }
    : undefined;

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

// =============================================================================
// Recording Replay Server
// =============================================================================

export interface Rfc4571ReplayServerOptions {
  /** Baichuan API session to use for replay. */
  api: ReolinkBaichuanApi;
  /** Channel number (defaults to 0 for standalone cameras). */
  channel?: number;
  /** Recording file name (e.g., "RecM03_20250101_120000_123.264"). */
  fileName: string;
  /** Stream type: mainStream or subStream (inferred from fileName if not specified). */
  streamType?: "mainStream" | "subStream";
  logger: Console;

  host?: string;
  videoPayloadType?: number;
  audioPayloadType?: number;

  /** How long to wait for an IDR/IRAP to extract parameter sets and produce SDP. */
  keyframeTimeoutMs?: number;

  /**
   * External identifier for dedicated socket session.
   * When provided, a dedicated BaichuanClient is created for this deviceId.
   * This allows multiple concurrent replay streams without interference.
   * The dedicated socket is automatically closed when the replay ends.
   */
  deviceId?: string;

  /** If true (default), closes the API when replay ends or server closes. */
  closeApiOnTeardown?: boolean;
  username: string;
  password: string;
  /** If true, requires authentication before allowing stream access. Default: false. */
  requireAuth?: boolean;

  /**
   * Optional AAC hint for when the camera sends raw AAC (no ADTS headers).
   * Many Reolink devices use AAC-LC mono at 8000Hz.
   */
  aacAudioHint?: { sampleRate: number; channels: number };

  /** Force NVR mode (uses id-based XML with UID) or standalone mode (name-based XML). */
  isNvr?: boolean;
}

export interface Rfc4571ReplayServer {
  host: string;
  port: number;
  sdp: string;
  videoType: VideoType;
  audio?: { codec: "aac"; sampleRate: number; channels: number };
  username: string;
  password: string;

  server: net.Server;
  videoStream: BaichuanVideoStream;

  /** Called when replay naturally ends (all data sent). */
  onReplayEnd?: () => void;

  close: (reason?: unknown) => Promise<void>;
}

/**
 * Create an RFC4571 TCP server for streaming a recording replay.
 *
 * This is similar to createRfc4571TcpServer but optimized for playback of recorded files:
 * - Uses startRecordingReplayStream to get native frames
 * - Automatically stops when replay ends
 * - No restart logic (single playback, not continuous like live)
 */
export async function createRfc4571TcpServerForReplay(
  options: Rfc4571ReplayServerOptions,
): Promise<Rfc4571ReplayServer> {
  const {
    api,
    channel = 0,
    fileName,
    logger,
    host = "127.0.0.1",
    videoPayloadType = 96,
    audioPayloadType = 97,
    keyframeTimeoutMs = 15_000,
    closeApiOnTeardown = false,
    username,
    password,
    requireAuth = false,
    aacAudioHint,
    isNvr,
  } = options;

  // Infer streamType from fileName if not provided
  const streamType =
    options.streamType ??
    (fileName.includes("RecS03_") ? "subStream" : "mainStream");

  const deviceId = options.deviceId;

  const log = (msg: string, ...args: unknown[]) =>
    logger.log(
      `[RFC4571-Replay ch=${channel} file=${fileName}] ${msg}`,
      ...args,
    );
  const warn = (msg: string, ...args: unknown[]) =>
    logger.warn(
      `[RFC4571-Replay ch=${channel} file=${fileName}] ${msg}`,
      ...args,
    );

  log(
    `starting replay: streamType=${streamType}${deviceId ? ` deviceId=${deviceId}` : ""}`,
  );

  // Start the recording replay stream
  const replayParams: {
    channel: number;
    fileName: string;
    streamType: "mainStream" | "subStream";
    timeoutMs: number;
    logger: Console;
    isNvr?: boolean;
    deviceId?: string;
  } = {
    channel,
    fileName,
    streamType,
    timeoutMs: keyframeTimeoutMs,
    logger,
  };
  if (isNvr !== undefined) {
    replayParams.isNvr = isNvr;
  }
  if (deviceId !== undefined) {
    replayParams.deviceId = deviceId;
  }

  const { stream: videoStream, stop: stopReplay } =
    await api.startRecordingReplayStream(replayParams);

  // Audio detection
  let audio:
    | {
        sampleRate: number;
        channels: number;
        configHex: string;
        mode: "adts" | "raw";
      }
    | undefined;

  const waitForKeyframe = async (): Promise<
    { videoType: VideoType; accessUnit: Buffer } & {
      profileLevelId?: string;
      h264?: { sps: Buffer; pps: Buffer };
      h265?: { vps: Buffer; sps: Buffer; pps: Buffer };
    }
  > => {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timeout waiting for keyframe in replay (file=${fileName})`,
          ),
        );
      }, keyframeTimeoutMs);

      const onError = (e: unknown) => {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const onAu = (au: any) => {
        if (!au?.isKeyframe) return;
        const videoType = au.videoType as VideoType;
        const accessUnit = au.data as Buffer;

        if (videoType === "H264") {
          const { sps, pps, profileLevelId } =
            extractH264ParamSetsFromAccessUnit(accessUnit);
          if (!sps || !pps) return;
          cleanup();
          resolve({
            videoType,
            accessUnit,
            ...(profileLevelId ? { profileLevelId } : {}),
            h264: { sps, pps },
          });
          return;
        }

        const { vps, sps, pps } =
          extractH265ParamSetsFromAccessUnit(accessUnit);
        if (!vps || !sps || !pps) return;
        cleanup();
        resolve({ videoType, accessUnit, h265: { vps, sps, pps } });
      };

      // Listen for audio to detect format
      const onAudioFrame = (frame: Buffer) => {
        if (audio) return;
        // Try parsing as ADTS
        try {
          const adts = parseAdtsHeader(frame);
          if (adts) {
            audio = {
              sampleRate: adts.sampleRate,
              channels: adts.channels,
              configHex: adts.configHex,
              mode: "adts",
            };
            log(
              `detected audio via ADTS: sr=${audio.sampleRate} ch=${audio.channels}`,
            );
          }
        } catch {
          // Not ADTS, try raw AAC hint
          if (aacAudioHint) {
            const configHex = buildAacAudioSpecificConfigHex({
              sampleRate: aacAudioHint.sampleRate,
              channels: aacAudioHint.channels,
            });
            if (configHex) {
              audio = {
                sampleRate: aacAudioHint.sampleRate,
                channels: aacAudioHint.channels,
                configHex,
                mode: "raw",
              };
              log(
                `using AAC hint: sr=${audio.sampleRate} ch=${audio.channels}`,
              );
            }
          }
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        videoStream.removeListener("error" as any, onError as any);
        videoStream.removeListener("videoAccessUnit" as any, onAu as any);
        videoStream.removeListener("audioFrame" as any, onAudioFrame as any);
      };

      videoStream.on("error" as any, onError as any);
      videoStream.on("videoAccessUnit" as any, onAu as any);
      videoStream.on("audioFrame" as any, onAudioFrame as any);
    });
  };

  let keyframe: Awaited<ReturnType<typeof waitForKeyframe>>;
  try {
    keyframe = await waitForKeyframe();
  } catch (e) {
    try {
      await stopReplay();
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
    throw e;
  }

  log(`video detected: codec=${keyframe.videoType}`);

  const video: VideoParamSets = {
    videoType: keyframe.videoType,
    payloadType: videoPayloadType,
    ...(keyframe.videoType === "H264"
      ? {
          h264: {
            sps: keyframe.h264!.sps,
            pps: keyframe.h264!.pps,
            ...(keyframe.profileLevelId
              ? { profileLevelId: keyframe.profileLevelId }
              : {}),
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
        codec: "aac",
        payloadType: audioPayloadType,
        sampleRate: audio.sampleRate,
        channels: audio.channels,
        configHex: audio.configHex,
      }
    : undefined;

  const sdp = buildRfc4571Sdp(video, aacAudio);
  const fps = 25; // Best-effort default
  const muxer = new Rfc4571Muxer(
    logger,
    videoPayloadType,
    aacAudio ? audioPayloadType : undefined,
    fps,
  );

  log(
    `SDP ready (video=${keyframe.videoType}/90000 pt=${videoPayloadType}${aacAudio ? `, audio=aac/${aacAudio.sampleRate}/${aacAudio.channels} pt=${audioPayloadType}` : ", audio=none"})`,
  );

  let rfcClients = 0;
  const sockets = new Set<net.Socket>();
  let tearingDown = false;
  let replayEnded = false;
  let onReplayEndCallback: (() => void) | undefined;

  const close = async (reason?: unknown): Promise<void> => {
    if (tearingDown) return;
    tearingDown = true;

    const message =
      (reason as any)?.message || (reason as any)?.toString?.() || reason;
    if (message) log(`closing: ${message}`);
    else log("closing");

    try {
      await stopReplay();
    } catch {
      // ignore
    }

    for (const s of sockets) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }
    sockets.clear();

    try {
      server.close();
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
  };

  const server = netImpl.createServer();

  server.on("connection", (socket) => {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    log(`client connected: ${remote}`);

    sockets.add(socket);
    rfcClients++;

    const setupClient = () => {
      muxer.addClient(socket);
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
        if (!authenticated) {
          authBuffer = Buffer.concat([authBuffer, data]);
          const authString = authBuffer.toString("utf8");
          const authMatch = authString.match(/^([^:]+):([^\n]+)\n/);

          if (authMatch) {
            const [, clientUsername, clientPassword] = authMatch;
            if (clientUsername === username && clientPassword === password) {
              authenticated = true;
              clearTimeout(authTimeout);
              setupClient();
              socket.removeListener("data", onData);
            } else {
              log(`client authentication failed (remote=${remote})`);
              socket.destroy();
              return;
            }
          } else if (authBuffer.length > 1024) {
            log(`client authentication buffer overflow (remote=${remote})`);
            socket.destroy();
            return;
          }
        }
      };

      socket.on("data", onData);
    }

    let counted = true;
    const dec = () => {
      if (!counted) return;
      counted = false;
      rfcClients = Math.max(0, rfcClients - 1);
      sockets.delete(socket);
      log(`client disconnected (remote=${remote} clients=${rfcClients})`);

      // If no clients and replay ended, close server
      if (rfcClients === 0 && replayEnded) {
        close("replay ended and no clients").catch(() => {});
      }
    };

    socket.once("close", dec);
    socket.once("error", (e) => {
      warn(`client socket error: ${remote}`, e?.message || String(e));
      dec();
    });
  });

  server.on("error", (e) => {
    warn("server error", e?.message || String(e));
    close(e).catch(() => {});
  });

  // Handle video access units
  videoStream.on("videoAccessUnit" as any, (au: any) => {
    if (tearingDown) return;
    try {
      muxer.sendVideoAccessUnit(
        au.videoType,
        au.data,
        au.isKeyframe,
        au.microseconds,
      );
    } catch (e) {
      close(e).catch(() => {});
    }
  });

  // Handle audio frames
  if (aacAudio) {
    videoStream.on("audioFrame" as any, (frame: Buffer) => {
      if (tearingDown) return;
      try {
        if (audio?.mode === "adts") {
          muxer.sendAudioAdtsFrame(frame);
        } else {
          muxer.sendAudioAacRawFrame(frame);
        }
      } catch (e) {
        close(e).catch(() => {});
      }
    });
  }

  // Handle replay end
  videoStream.on("end" as any, () => {
    log("replay ended naturally");
    replayEnded = true;
    onReplayEndCallback?.();

    // If no clients, close immediately
    if (rfcClients === 0) {
      close("replay ended").catch(() => {});
    }
  });

  videoStream.on("error" as any, (e: unknown) => {
    close(e).catch(() => {});
  });

  videoStream.on("close" as any, (e: unknown) => {
    if (!replayEnded) {
      close(e).catch(() => {});
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind RFC TCP server for replay");
  }
  const port = address.port;
  if (!port) throw new Error("Failed to bind RFC TCP server for replay");

  log(`listening (addr=${host}:${port})`);

  const audioInfo = aacAudio
    ? {
        codec: "aac" as const,
        sampleRate: aacAudio.sampleRate,
        channels: aacAudio.channels,
      }
    : undefined;

  const result: Rfc4571ReplayServer = {
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

  // Allow setting onReplayEnd callback after creation
  Object.defineProperty(result, "onReplayEnd", {
    get: () => onReplayEndCallback,
    set: (fn: (() => void) | undefined) => {
      onReplayEndCallback = fn;
    },
  });

  return result;
}
