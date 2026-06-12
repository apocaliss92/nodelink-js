import { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";
import { createSourceLogger } from "./logger.js";

/**
 * Centralised factory for every `ReolinkBaichuanApi` (the Baichuan SDK) the
 * Manager instantiates. Each device should have exactly ONE live SDK instance
 * (the rtsp-manager's owned connection, mirroring the Scrypted plugin's single
 * `ensureClient()`); every other path is expected to reuse it. This factory
 * logs each construction — with a monotonic id, the calling subsystem, the
 * target, an approximate count of still-open instances, and the caller stack —
 * so a duplicate SDK for the same camera is immediately visible in the logs
 * (look for two `NEW ReolinkBaichuanApi` lines with the same host between a
 * disconnect/reconnect).
 */

type BaichuanApiOptions = ConstructorParameters<typeof ReolinkBaichuanApi>[0];

const sdkLogger = createSourceLogger("baichuan-sdk");

let createdCount = 0;
const liveApis = new Set<ReolinkBaichuanApi>();

function approxLiveCount(): number {
  // Lazily prune instances that have been closed since the last creation.
  for (const api of liveApis) {
    if ((api as { isClosed?: boolean }).isClosed) {
      liveApis.delete(api);
    }
  }
  return liveApis.size;
}

function resolveCaller(): string {
  const stack = new Error().stack ?? "";
  return (
    stack
      .split("\n")
      .slice(2)
      .map((line) => line.trim().replace(/^at\s+/, ""))
      .find(
        (line) =>
          line.length > 0 &&
          !line.includes("baichuan-api-factory") &&
          !line.includes("node:internal"),
      ) ?? "unknown"
  );
}

export function createBaichuanApi(
  options: BaichuanApiOptions,
  context: { source: string; cameraId?: string },
): ReolinkBaichuanApi {
  createdCount += 1;
  const id = createdCount;
  const live = approxLiveCount();
  const host = (options as { host?: string })?.host ?? "?";

  sdkLogger.info(
    `NEW ReolinkBaichuanApi sdk#${id} (liveBefore=${live}) source=${context.source}` +
      `${context.cameraId ? ` cameraId=${context.cameraId}` : ""} host=${host} caller=${resolveCaller()}`,
  );

  const api = new ReolinkBaichuanApi(options);
  liveApis.add(api);
  return api;
}
