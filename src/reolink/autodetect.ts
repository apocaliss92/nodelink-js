import type { BaichuanClientOptions } from "../client/BaichuanClient";
import type { Logger } from "../debug/DebugConfig";
import { DUAL_LENS_MODELS, isDualLenseModel, ReolinkBaichuanApi } from "./baichuan/ReolinkBaichuanApi";
import { discoverViaUdpBroadcast, discoverViaUdpDirect } from "./discovery";
import type { ReolinkDeviceInfo } from "./types";

export type BaichuanTransport = "tcp" | "udp";

export type AutoDetectMode = "auto" | BaichuanTransport;

export type AutoDetectInputs = {
  host: string;
  username: string;
  password: string;
  uid?: string;
  logger?: Logger;
  debugOptions?: BaichuanClientOptions["debugOptions"];
  /**
   * Force a specific transport mode.
   * - `auto` (default): try TCP first, then fallback to UDP when the error looks like a transport failure.
   * - `tcp`: only attempt TCP.
   * - `udp`: only attempt UDP (will try to discover UID if missing).
   */
  mode?: AutoDetectMode;
  /**
   * Maximum number of retries for each phase (TCP login and each UDP method).
   * NOTE: BaichuanClient.login() may still have its own internal retry/backoff.
   */
  maxRetries?: number;
  /**
   * Optional override for BCUDP discovery method.
   * If omitted, autodetect will try `local-direct`, then `local-broadcast`, then `remote`, then `relay`, then `map`.
   */
  udpDiscoveryMethod?: BaichuanClientOptions["udpDiscoveryMethod"];
};

export type DeviceType = "camera" | "battery-cam" | "nvr" | "multifocal";

export type AutoDetectResult = {
  type: DeviceType;
  transport: BaichuanTransport;
  uid: string;
  /** If `transport === "udp"`, the UDP discovery method that succeeded. */
  udpDiscoveryMethod?: BaichuanClientOptions["udpDiscoveryMethod"];
  deviceInfo?: Partial<ReolinkDeviceInfo>;
  /**
   * Best-effort host network info (from Baichuan).
   * Typically includes ip/mac and sometimes link type.
   */
  hostNetworkInfo?: {
    ip?: string;
    mac?: string;
    /** Active link / link type when available (varies by firmware). */
    activeLink?: string;
  };
  channelNum?: number;
  api: ReolinkBaichuanApi; // The API instance that was successfully used for detection
};

/**
 * Normalize UID string (trim and return undefined if empty).
 */
export function normalizeUid(uid?: string): string | undefined {
  const v = uid?.trim();
  return v ? v : undefined;
}

/**
 * Mask UID for logging (show first 4 and last 4 characters).
 */
export function maskUid(uid: string): string {
  const v = uid.trim();
  if (v.length <= 8) return v;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

async function resolveHostToIp(host: string): Promise<string | undefined> {
  try {
    // Avoid pulling in dns for plain IPv4/IPv6 literals.
    // Quick heuristic: if it contains letters, it's likely a hostname.
    if (!/[a-z]/i.test(host)) return host;
    const { lookup } = await import("node:dns/promises");
    const res = await lookup(host);
    return res?.address ?? host;
  } catch {
    return host;
  }
}

async function discoverUidForHost(host: string, logger?: Logger): Promise<string | undefined> {
  try {
    const ip = await resolveHostToIp(host);
    const directTarget = ip ?? host;

    // 1) Try UDP unicast (local-direct style). This can work even when broadcast is filtered.
    try {
      const directDevices = await discoverViaUdpDirect(directTarget, {
        enableUdpDiscovery: true,
        udpBroadcastTimeoutMs: 1200,
        ...(logger ? { logger } : {}),
      });
      const directMatch = directDevices.find((d) => d.host === directTarget);
      const directUid = normalizeUid(directMatch?.uid);
      if (directUid) {
        logger?.log?.(`[AutoDetect] UID discovered via UDP direct: ${maskUid(directUid)}`);
        return directUid;
      }
    } catch {
      // ignore
    }

    // 2) Fallback to UDP broadcast.
    const options = {
      enableUdpDiscovery: true,
      udpBroadcastTimeoutMs: 1500,
      ...(logger ? { logger } : {}),
    };
    const devices = await discoverViaUdpBroadcast(options);
    const match = devices.find((d) => d.host === ip || d.host === host);
    const uid = normalizeUid(match?.uid);
    if (uid) {
      logger?.log?.(`[AutoDetect] UID discovered via UDP broadcast: ${maskUid(uid)}`);
      return uid;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Check if a TCP error should trigger UDP fallback.
 * Only transport/connection errors should fallback, not authentication errors.
 */
export function isTcpFailureThatShouldFallbackToUdp(e: unknown): boolean {
  const message = (e as any)?.message || (e as any)?.toString?.() || "";
  if (typeof message !== "string") return false;

  // Fallback only on transport/connection style failures.
  // Wrong credentials won't be fixed by switching to UDP.
  return (
    message.includes("ECONNREFUSED") ||
    message.includes("ETIMEDOUT") ||
    message.includes("EHOSTUNREACH") ||
    message.includes("ENETUNREACH") ||
    message.includes("socket hang up") ||
    message.includes("TCP connection timeout") ||
    message.includes("Baichuan socket closed")
  );
}

/**
 * Simple ping check to verify IP is reachable.
 */
async function pingHost(host: string, timeoutMs: number = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const { exec } = require("child_process");
    const platform = process.platform;
    const pingCmd =
      platform === "win32"
        ? `ping -n 1 -w ${timeoutMs} ${host}`
        : `ping -c 1 -W ${Math.floor(timeoutMs / 1000)} ${host}`;

    exec(pingCmd, (error: any) => {
      resolve(!error);
    });
  });
}

/**
 * Create a Baichuan API instance with error handling.
 */
function createBaichuanApi(
  inputs: AutoDetectInputs,
  transport: BaichuanTransport,
): ReolinkBaichuanApi {
  const base: BaichuanClientOptions = {
    host: inputs.host,
    username: inputs.username,
    password: inputs.password,
    ...(inputs.logger !== undefined ? { logger: inputs.logger } : {}),
    debugOptions: inputs.debugOptions ?? {},
  };

  if (transport === "tcp") {
    const api = new ReolinkBaichuanApi({
      ...base,
      transport: "tcp",
    });
    attachErrorHandler(api, transport, inputs);
    return api;
  }

  const uid = normalizeUid(inputs.uid);
  if (!uid) {
    throw new Error("UID is required for battery cameras (BCUDP)");
  }

  const api = new ReolinkBaichuanApi({
    ...base,
    transport: "udp",
    uid,
    ...(inputs.udpDiscoveryMethod ? { udpDiscoveryMethod: inputs.udpDiscoveryMethod } : {}),
    idleDisconnect: true,
  });
  attachErrorHandler(api, transport, inputs);
  return api;
}

/**
 * Attach error handler to BaichuanClient to prevent uncaught exceptions.
 */
function attachErrorHandler(api: ReolinkBaichuanApi, transport: BaichuanTransport, inputs: AutoDetectInputs): void {
  try {
    api.client.on("error", (err: unknown) => {
      if (!inputs.logger) return;
      const msg = (err as any)?.message || (err as any)?.toString?.() || String(err);
      // Only log if it's not a recoverable error to avoid spam
      if (
        typeof msg === "string" &&
        (msg.includes("Baichuan socket closed") ||
          msg.includes("Baichuan UDP stream closed") ||
          msg.includes("Not running"))
      ) {
        // Silently ignore recoverable socket close errors and "Not running" errors
        // "Not running" is common for UDP/battery cameras when sleeping or during initialization
        return;
      }
      inputs.logger?.log?.(`[BaichuanClient] error (${transport}) ${inputs.host}: ${msg}`);
    });

    // Handle 'close' event to prevent unhandled rejections from pending promises
    api.client.on("close", () => {
      // Socket closed - pending promises will be rejected, but we've already handled errors above
      // This handler prevents the close event from causing issues
    });
  } catch {
    // ignore
  }
}

/**
 * Auto-detect device type by trying TCP first, then UDP if needed.
 * - First: Ping the IP to verify it's reachable
 * - TCP success: Check if NVR (multiple channels) or regular camera
 * - TCP failure: Try UDP (always battery camera)
 */
export async function autoDetectDeviceType(inputs: AutoDetectInputs): Promise<AutoDetectResult> {
  const { host, uid, logger } = inputs;

  const mode: AutoDetectMode = (inputs.mode ?? "auto") as AutoDetectMode;
  const maxRetriesRaw = inputs.maxRetries;
  const maxRetries = Math.max(1, Math.min(10, typeof maxRetriesRaw === "number" && Number.isFinite(maxRetriesRaw) ? Math.floor(maxRetriesRaw) : 1));

  const fmtErr = (e: unknown): string => {
    const m = (e as any)?.message || (e as any)?.toString?.() || String(e);
    return typeof m === "string" ? m : String(m);
  };

  const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const shouldRetryTcp = (e: unknown): boolean => {
    const msg = fmtErr(e);
    // Retry on transport errors, negotiation hiccups, or abrupt socket termination.
    return (
      isTcpFailureThatShouldFallbackToUdp(e) ||
      msg.includes("timeout waiting for nonce") ||
      msg.includes("expected encryption info") ||
      msg.includes("Baichuan socket closed") ||
      msg.includes("ECONNRESET") ||
      msg.includes("EPIPE")
    );
  };

  const shouldRetryUdp = (e: unknown): boolean => {
    const msg = fmtErr(e);
    // Battery cams are often flaky/sleepy: retry on common transient signals.
    return (
      msg.includes("Not running") ||
      msg.includes("Baichuan UDP stream closed") ||
      msg.includes("Baichuan socket closed") ||
      msg.includes("ETIMEDOUT") ||
      msg.toLowerCase().includes("timeout")
    );
  };

  const withRetries = async <T>(
    label: string,
    max: number,
    op: (attempt: number) => Promise<T>,
    shouldRetry: (e: unknown) => boolean,
  ): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        if (attempt > 1) {
          logger?.log?.(`[AutoDetect] ${label}: retry ${attempt}/${max}...`);
        }
        return await op(attempt);
      } catch (e) {
        lastErr = e;
        const msg = fmtErr(e);
        const retryable = attempt < max && shouldRetry(e);
        logger?.log?.(`[AutoDetect] ${label} attempt ${attempt}/${max} failed: ${msg}${retryable ? " (will retry)" : ""}`);
        if (!retryable) throw e;
        // Small backoff to avoid tight reconnect loops.
        await sleepMs(350);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? `${label} failed`));
  };

  // Best-effort: discover UID if not provided (useful for BCUDP/battery cams).
  // This is cheap and non-invasive (UDP broadcast).
  // const discoveredUid = uid ? undefined : await discoverUidForHost(host, logger);
  // const effectiveUid = normalizeUid(uid) ?? discoveredUid;
  const effectiveUid = normalizeUid(uid);

  // Ping the host first to verify it's reachable
  logger?.log?.(`[AutoDetect] Pinging ${host}...`);
  const isReachable = await pingHost(host);
  if (!isReachable) {
    logger?.log?.(`[AutoDetect] Host ${host} is not reachable via ping, but continuing with connection attempt...`);
  } else {
    logger?.log?.(`[AutoDetect] Host ${host} is reachable`);
  }

  // Forced UDP mode: skip TCP entirely.
  if (mode === "udp") {
    logger?.log?.(`[AutoDetect] Forced mode=udp, skipping TCP and starting UDP discovery/login...`);
    let normalizedUid = effectiveUid;
    if (!normalizedUid) {
      logger?.log?.(`[AutoDetect] UID not provided; attempting UDP discovery for UID...`);
      const discovered = await discoverUidForHost(host, logger);
      const normalizedDiscovered = normalizeUid(discovered);
      if (!normalizedDiscovered) {
        throw new Error(
          `Forced UDP autodetect requires UID (or successful UDP UID discovery), but none was provided/discovered (ip=${host}).`,
        );
      }
      normalizedUid = normalizedDiscovered;
    }

    const methodsToTry: Array<NonNullable<BaichuanClientOptions["udpDiscoveryMethod"]>> =
      inputs.udpDiscoveryMethod
        ? [inputs.udpDiscoveryMethod]
        : ["local-direct", "local-broadcast", "remote", "relay", "map"];

    const udpErrors: string[] = [];
    for (const m of methodsToTry) {
      try {
        logger?.log?.(`[AutoDetect] Trying UDP discovery method: ${m}...`);
        const udpApi = await withRetries(
          `UDP(${m})`,
          maxRetries,
          async (attempt) => {
            const api = createBaichuanApi({ ...inputs, uid: normalizedUid, udpDiscoveryMethod: m }, "udp");
            try {
              await api.login();
              return api;
            } catch (e) {
              try {
                await api.close({ reason: `autodetect:udp_failed:${m}:attempt_${attempt}` });
              } catch {
                // ignore
              }
              throw e;
            }
          },
          shouldRetryUdp,
        );

        // Reuse the same detection logic used by the fallback path.
        const deviceInfo = await udpApi.getInfo();
        const capabilities = await udpApi.getDeviceCapabilities();
        const hostNetworkInfo = await udpApi.getNetworkInfo(undefined, { timeoutMs: 1200 }).catch(() => undefined);
        const channelNum = capabilities?.support?.channelNum ?? 1;
        const model = deviceInfo.type?.trim();

        const normalizedModel = model ? model.trim() : undefined;
        const isMultifocalByModel = normalizedModel ? isDualLenseModel(normalizedModel) : false;
        const channelNumValue = typeof channelNum === "string" ? Number.parseInt(channelNum, 10) : channelNum;
        const hasDualLensChannelCount = (channelNumValue === 2 || channelNumValue === 3) && Number.isFinite(channelNumValue);
        const isMultifocal = isMultifocalByModel || hasDualLensChannelCount;

        if (isMultifocal) {
          const detectionMethod = isMultifocalByModel ? "model match" : "channelNum fallback";
          logger?.log?.(
            `[AutoDetect] UDP (${m}) connection successful. Detected multi-focal device (${detectionMethod}: model=${normalizedModel ?? "unknown"}, channelNum=${channelNum}).`,
          );
          return {
            type: "multifocal",
            transport: "udp",
            uid: normalizedUid,
            udpDiscoveryMethod: m,
            deviceInfo,
            ...(hostNetworkInfo ? { hostNetworkInfo } : {}),
            channelNum,
            api: udpApi,
          };
        }

        logger?.log?.(`[AutoDetect] UDP (${m}) connection successful. Detected battery camera.`);
        return {
          type: "battery-cam",
          transport: "udp",
          uid: normalizedUid,
          udpDiscoveryMethod: m,
          deviceInfo,
          ...(hostNetworkInfo ? { hostNetworkInfo } : {}),
          channelNum: 1,
          api: udpApi,
        };
      } catch (e) {
        const msg = fmtErr(e);
        udpErrors.push(`${m}: ${msg}`);
        // (best-effort) resources are already closed inside the retry wrapper.
        logger?.log?.(`[AutoDetect] UDP (${m}) failed: ${msg}`);
      }
    }

    throw new Error(`Forced UDP autodetect failed for all methods. ${udpErrors.join(" | ")}`);
  }

  // Try TCP first
  let tcpApi: ReolinkBaichuanApi | undefined;
  try {
    logger?.log?.(`[AutoDetect] Trying TCP connection to ${host}...`);
    tcpApi = await withRetries(
      "TCP",
      maxRetries,
      async (attempt) => {
        // Create a fresh API for each attempt to avoid stale socket state.
        const api = createBaichuanApi(inputs, "tcp");
        try {
          await api.login();
          return api;
        } catch (e) {
          try {
            await api.close({ reason: `autodetect:tcp_failed:attempt_${attempt}` });
          } catch {
            // ignore
          }
          throw e;
        }
      },
      shouldRetryTcp,
    );

    // Get device info to check device type
    const api = tcpApi;
    if (!api) throw new Error("AutoDetect internal error: TCP API not initialized after successful login");
    const deviceInfo = await api.getInfo();
    const capabilities = await api.getDeviceCapabilities();
    // const hostNetworkInfo = await tcpApi.getNetworkInfo(undefined, { timeoutMs: 1200 }).catch(() => undefined);
    const channelNum = capabilities?.support?.channelNum ?? 1;
    const model = deviceInfo.type?.trim();

    logger?.log?.(`[AutoDetect] TCP connection successful. channelNum=${channelNum}, model=${model ?? "unknown"}`);

    // Check if it's a multi-focal device using the dual lens model map or channelNum fallback
    const normalizedModel = model ? model.trim() : undefined;
    const isMultifocalByModel = normalizedModel ? isDualLenseModel(normalizedModel) : false;

    // Also check if channelNum suggests dual lens (2-3 channels)
    // Handle both number and string types for channelNum
    const channelNumValue = typeof channelNum === "string" ? Number.parseInt(channelNum, 10) : channelNum;
    const hasDualLensChannelCount = (channelNumValue === 2 || channelNumValue === 3) && Number.isFinite(channelNumValue);

    // Consider it dual lens if model matches OR if channelNum suggests it
    const isMultifocal = isMultifocalByModel || hasDualLensChannelCount;

    if (isMultifocal) {
      const detectionMethod = isMultifocalByModel ? "model match" : "channelNum fallback";
      logger?.log?.(`[AutoDetect] Detected multi-focal device (${detectionMethod}: model=${normalizedModel ?? "unknown"}, channelNum=${channelNum})`);
      // Don't close the API, return it for continued use
      return {
        type: "multifocal",
        transport: "tcp",
        uid: effectiveUid || uid || "",
        deviceInfo,
        // ...(hostNetworkInfo ? { hostNetworkInfo } : {}),
        channelNum,
        api,
      };
    }

    // If channelNum > 1, it's likely an NVR
    if (channelNum > 1) {
      logger?.log?.(`[AutoDetect] Detected NVR (${channelNum} channels)`);
      // Don't close the API, return it for continued use
      return {
        type: "nvr",
        transport: "tcp",
        uid: effectiveUid || uid || "",
        deviceInfo,
        // ...(hostNetworkInfo ? { hostNetworkInfo } : {}),
        channelNum,
        api,
      };
    }

    // Single channel device - regular camera
    logger?.log?.(`[AutoDetect] Detected regular camera (single channel)`);
    // Don't close the API, return it for continued use
    return {
      type: "camera",
      transport: "tcp",
      uid: effectiveUid || uid || "",
      deviceInfo,
      // ...(hostNetworkInfo ? { hostNetworkInfo } : {}),
      channelNum: 1,
      api,
    };
  } catch (tcpError) {
    if (mode === "tcp") {
      // Forced TCP mode: never fallback.
      throw tcpError;
    }

    // TCP failed, try UDP (battery camera)
    if (tcpApi) {
      try {
        await tcpApi.close({ reason: "autodetect:tcp_failed" });
      } catch {
        // ignore
      }
    }

    if (!isTcpFailureThatShouldFallbackToUdp(tcpError)) {
      // Not a transport error, rethrow
      throw tcpError;
    }

    logger?.log?.(`[AutoDetect] TCP failed, trying UDP (battery camera)...`);
    let normalizedUid = effectiveUid;
    if (!normalizedUid) {
      logger?.log?.(`[AutoDetect] UID not provided; attempting UDP broadcast discovery for UID...`);
      const discovered = await discoverUidForHost(host, logger);
      if (!discovered) {
        throw new Error(
          `TCP connection failed and device likely requires UDP/BCUDP. UID is required for battery cameras (ip=${host}).`
        );
      }
      // Continue with discovered UID.
      const normalizedDiscovered = normalizeUid(discovered);
      if (!normalizedDiscovered) {
        throw new Error(
          `TCP connection failed and device likely requires UDP/BCUDP, but UID discovery returned an empty UID (ip=${host}).`
        );
      }
      normalizedUid = normalizedDiscovered;
    }

    try {
      const detectOverUdpApi = async (
        udpApi: ReolinkBaichuanApi,
        udpDiscoveryMethod: NonNullable<BaichuanClientOptions["udpDiscoveryMethod"]>,
      ): Promise<AutoDetectResult> => {
        const deviceInfo = await udpApi.getInfo();
        const capabilities = await udpApi.getDeviceCapabilities();
        const hostNetworkInfo = await udpApi.getNetworkInfo(undefined, { timeoutMs: 1200 }).catch(() => undefined);
        const channelNum = capabilities?.support?.channelNum ?? 1;
        const model = deviceInfo.type?.trim();

        // Check if it's a multi-focal device using the dual lens model map or channelNum fallback
        // Multi-focal devices can also be UDP (battery multi-focal cameras)
        const normalizedModel = model ? model.trim() : undefined;
        const isMultifocalByModel = normalizedModel ? isDualLenseModel(normalizedModel) : false;

        // Also check if channelNum suggests dual lens (2-3 channels)
        // Handle both number and string types for channelNum
        const channelNumValue = typeof channelNum === "string" ? Number.parseInt(channelNum, 10) : channelNum;
        const hasDualLensChannelCount = (channelNumValue === 2 || channelNumValue === 3) && Number.isFinite(channelNumValue);

        // Consider it dual lens if model matches OR if channelNum suggests it
        const isMultifocal = isMultifocalByModel || hasDualLensChannelCount;

        if (isMultifocal) {
          const detectionMethod = isMultifocalByModel ? "model match" : "channelNum fallback";
          logger?.log?.(
            `[AutoDetect] UDP (${udpDiscoveryMethod}) connection successful. Detected multi-focal device (${detectionMethod}: model=${normalizedModel ?? "unknown"}, channelNum=${channelNum}).`,
          );
          return {
            type: "multifocal",
            transport: "udp",
            uid: normalizedUid,
            udpDiscoveryMethod,
            deviceInfo,
            ...(hostNetworkInfo ? { hostNetworkInfo } : {}),
            channelNum,
            api: udpApi,
          };
        }

        // Regular battery camera
        logger?.log?.(`[AutoDetect] UDP (${udpDiscoveryMethod}) connection successful. Detected battery camera.`);
        return {
          type: "battery-cam",
          transport: "udp",
          uid: normalizedUid,
          udpDiscoveryMethod,
          deviceInfo,
          ...(hostNetworkInfo ? { hostNetworkInfo } : {}),
          channelNum: 1,
          api: udpApi,
        };
      };

      const methodsToTry: Array<NonNullable<BaichuanClientOptions["udpDiscoveryMethod"]>> =
        ["local-direct", "local-broadcast", "remote", "relay", "map"];

      const udpErrors: string[] = [];
      for (const m of methodsToTry) {
        try {
          logger?.log?.(`[AutoDetect] Trying UDP discovery method: ${m}...`);
          const udpApi = await withRetries(
            `UDP(${m})`,
            maxRetries,
            async (attempt) => {
              const api = createBaichuanApi({ ...inputs, uid: normalizedUid, udpDiscoveryMethod: m }, "udp");
              try {
                await api.login();
                return api;
              } catch (e) {
                try {
                  await api.close({ reason: `autodetect:udp_failed:${m}:attempt_${attempt}` });
                } catch {
                  // ignore
                }
                throw e;
              }
            },
            shouldRetryUdp,
          );
          return await detectOverUdpApi(udpApi, m);
        } catch (e) {
          const msg = (e as any)?.message || (e as any)?.toString?.() || String(e);
          udpErrors.push(`${m}: ${msg}`);
          try {
            // ignore (api already closed in retry wrapper)
          } catch {
            // ignore
          }
          logger?.log?.(`[AutoDetect] UDP (${m}) failed: ${msg}`);
        }
      }

      throw new Error(`UDP discovery failed for all methods. ${udpErrors.join(" | ")}`);
    } catch (udpError) {
      logger?.log?.(
        `[AutoDetect] Both TCP and UDP failed. TCP error: ${tcpError}, UDP error: ${udpError}`
      );
      throw new Error(
        `Failed to connect via both TCP and UDP. TCP: ${(tcpError as any)?.message || tcpError}, UDP: ${(udpError as any)?.message || udpError}`
      );
    }
  }
}

