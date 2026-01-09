import { ReolinkBaichuanApi, DUAL_LENS_MODELS } from "./baichuan/ReolinkBaichuanApi";
import type { BaichuanClientOptions } from "../client/BaichuanClient";
import type { ReolinkDeviceInfo } from "./types";
import type { Logger } from "../debug/DebugConfig";

export type BaichuanTransport = "tcp" | "udp";

export type AutoDetectInputs = {
  host: string;
  username: string;
  password: string;
  uid?: string;
  logger?: Logger;
  debugOptions?: BaichuanClientOptions["debugOptions"];
  /**
   * Optional override for BCUDP discovery method.
   * If omitted, autodetect will try `local`, then `remote`, then `relay`, then `map`.
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

  // Ping the host first to verify it's reachable
  logger?.log?.(`[AutoDetect] Pinging ${host}...`);
  const isReachable = await pingHost(host);
  if (!isReachable) {
    logger?.log?.(`[AutoDetect] Host ${host} is not reachable via ping, but continuing with connection attempt...`);
  } else {
    logger?.log?.(`[AutoDetect] Host ${host} is reachable`);
  }

  // Try TCP first
  let tcpApi: ReolinkBaichuanApi | undefined;
  try {
    logger?.log?.(`[AutoDetect] Trying TCP connection to ${host}...`);
    tcpApi = createBaichuanApi(inputs, "tcp");
    await tcpApi.login();

    // Get device info to check device type
    const deviceInfo = await tcpApi.getInfo();
    const capabilities = await tcpApi.getDeviceCapabilities();
    const channelNum = capabilities?.support?.channelNum ?? 1;
    const model = deviceInfo.type?.trim();

    logger?.log?.(`[AutoDetect] TCP connection successful. channelNum=${channelNum}, model=${model ?? "unknown"}`);

    // Check if it's a multi-focal device using the dual lens model map or channelNum fallback
    const normalizedModel = model ? model.trim() : undefined;
    const isMultifocalByModel = normalizedModel ? DUAL_LENS_MODELS.has(normalizedModel) : false;

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
        uid: uid || "",
        deviceInfo,
        channelNum,
        api: tcpApi,
      };
    }

    // If channelNum > 1, it's likely an NVR
    if (channelNum > 1) {
      logger?.log?.(`[AutoDetect] Detected NVR (${channelNum} channels)`);
      // Don't close the API, return it for continued use
      return {
        type: "nvr",
        transport: "tcp",
        uid: uid || "",
        deviceInfo,
        channelNum,
        api: tcpApi,
      };
    }

    // Single channel device - regular camera
    logger?.log?.(`[AutoDetect] Detected regular camera (single channel)`);
    // Don't close the API, return it for continued use
    return {
      type: "camera",
      transport: "tcp",
      uid: uid || "",
      deviceInfo,
      channelNum: 1,
      api: tcpApi,
    };
  } catch (tcpError) {
    // TCP failed, try UDP (battery camera)
    if (tcpApi) {
      try {
        await tcpApi.close();
      } catch {
        // ignore
      }
    }

    if (!isTcpFailureThatShouldFallbackToUdp(tcpError)) {
      // Not a transport error, rethrow
      throw tcpError;
    }

    logger?.log?.(`[AutoDetect] TCP failed, trying UDP (battery camera)...`);
    const normalizedUid = normalizeUid(uid);
    if (!normalizedUid) {
      throw new Error(
        `TCP connection failed and device likely requires UDP/BCUDP. UID is required for battery cameras (ip=${host}).`
      );
    }

    try {
      const detectOverUdpApi = async (
        udpApi: ReolinkBaichuanApi,
        udpDiscoveryMethod: NonNullable<BaichuanClientOptions["udpDiscoveryMethod"]>,
      ): Promise<AutoDetectResult> => {
        const deviceInfo = await udpApi.getInfo();
        const capabilities = await udpApi.getDeviceCapabilities();
        const channelNum = capabilities?.support?.channelNum ?? 1;
        const model = deviceInfo.type?.trim();

        // Check if it's a multi-focal device using the dual lens model map or channelNum fallback
        // Multi-focal devices can also be UDP (battery multi-focal cameras)
        const normalizedModel = model ? model.trim() : undefined;
        const isMultifocalByModel = normalizedModel ? DUAL_LENS_MODELS.has(normalizedModel) : false;

        // Also check if channelNum suggests dual lens (2-3 channels)
        // Handle both number and string types for channelNum
        const channelNumValue = typeof channelNum === "string" ? Number.parseInt(channelNum, 10) : channelNum;
        const hasDualLensChannelCount = (channelNumValue === 2 || channelNumValue === 3) && Number.isFinite(channelNumValue);

        // Consider it dual lens if model matches OR if channelNum suggests it
        const isMultifocal = isMultifocalByModel || hasDualLensChannelCount;

        if (isMultifocal) {
          const detectionMethod = isMultifocalByModel ? "model match" : "channelNum fallback";
          logger?.log?.(`[AutoDetect] UDP connection successful. Detected multi-focal device (${detectionMethod}: model=${normalizedModel ?? "unknown"}, channelNum=${channelNum}).`);
          return {
            type: "multifocal",
            transport: "udp",
            uid: normalizedUid,
            udpDiscoveryMethod,
            deviceInfo,
            channelNum,
            api: udpApi,
          };
        }

        // Regular battery camera
        logger?.log?.(`[AutoDetect] UDP connection successful. Detected battery camera.`);
        return {
          type: "battery-cam",
          transport: "udp",
          uid: normalizedUid,
          udpDiscoveryMethod,
          deviceInfo,
          channelNum: 1,
          api: udpApi,
        };
      };

      const methodsToTry: Array<NonNullable<BaichuanClientOptions["udpDiscoveryMethod"]>> =
        inputs.udpDiscoveryMethod ? [inputs.udpDiscoveryMethod] : ["local", "remote", "relay", "map"];

      const udpErrors: string[] = [];
      for (const m of methodsToTry) {
        let udpApi: ReolinkBaichuanApi | undefined;
        try {
          logger?.log?.(`[AutoDetect] Trying UDP discovery method: ${m}...`);
          udpApi = createBaichuanApi({ ...inputs, uid: normalizedUid, udpDiscoveryMethod: m }, "udp");
          await udpApi.login();
          return await detectOverUdpApi(udpApi, m);
        } catch (e) {
          const msg = (e as any)?.message || (e as any)?.toString?.() || String(e);
          udpErrors.push(`${m}: ${msg}`);
          try {
            await udpApi?.close();
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

