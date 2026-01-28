/**
 * HLS Session Manager for Reolink recording replay.
 *
 * This module provides a complete HLS streaming solution that manages:
 * - Session caching with TTL
 * - Automatic cleanup of expired sessions
 * - Playlist URL rewriting for absolute paths
 * - HTTP response generation for both playlists and segments
 *
 * Usage:
 * ```ts
 * const manager = new HlsSessionManager(api, { logger });
 *
 * // In your HTTP handler:
 * const result = await manager.handleRequest({
 *   sessionKey: `${deviceId}:${fileId}`,
 *   hlsPath: request.query.hls || "playlist.m3u8",
 *   requestUrl: request.url,
 *   createSession: async () => ({
 *     channel: 0,
 *     fileName: fileId,
 *     isNvr: false,
 *   }),
 * });
 *
 * response.send(result.body, {
 *   code: result.statusCode,
 *   headers: result.headers,
 * });
 * ```
 */

import type { Logger } from "../../logging/logger";
import type { ReolinkBaichuanApi } from "./ReolinkBaichuanApi";

const withTimeout = async <T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        t = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
};

/**
 * HLS session returned by createRecordingReplayHlsSession.
 */
export interface HlsSession {
  /** Get the current HLS playlist content (.m3u8) */
  getPlaylist: () => string;
  /** Get a segment file by name */
  getSegment: (name: string) => Buffer | undefined;
  /** List all available segment names */
  listSegments: () => string[];
  /** Wait for the HLS session to be ready */
  waitForReady: () => Promise<void>;
  /** Stop the HLS session and cleanup */
  stop: () => Promise<void>;
  /** Path to the temporary directory */
  tempDir: string;
}

/**
 * Internal cache entry for HLS sessions.
 */
interface HlsSessionEntry {
  session: HlsSession;
  createdAt: number;
  lastAccessAt: number;
}

/**
 * Parameters for creating a new HLS session.
 */
export interface HlsSessionParams {
  /** Channel number */
  channel: number;
  /** Recording file name/path */
  fileName: string;
  /** Whether this is an NVR recording */
  isNvr?: boolean;
  /** External device ID for dedicated socket */
  deviceId?: string;
  /** Transcode H.265 to H.264 */
  transcodeH265ToH264?: boolean;
  /** HLS segment duration in seconds */
  hlsSegmentDuration?: number;
}

/**
 * HTTP response result.
 */
export interface HlsHttpResponse {
  /** HTTP status code */
  statusCode: number;
  /** Response headers */
  headers: Record<string, string>;
  /** Response body (string for playlist, Buffer for segment) */
  body: string | Buffer;
}

/**
 * Options for HlsSessionManager constructor.
 */
export interface HlsSessionManagerOptions {
  /** Logger instance */
  logger?: Logger;
  /** Session TTL in milliseconds (default: 5 minutes) */
  sessionTtlMs?: number;
  /** Cleanup interval in milliseconds (default: 30 seconds) */
  cleanupIntervalMs?: number;
}

/**
 * Manages HLS sessions with caching, TTL, and HTTP response generation.
 */
export class HlsSessionManager {
  private sessions = new Map<string, HlsSessionEntry>();
  private readonly logger: Logger | undefined;
  private readonly sessionTtlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private creationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly api: ReolinkBaichuanApi,
    options?: HlsSessionManagerOptions,
  ) {
    this.logger = options?.logger;
    this.sessionTtlMs = options?.sessionTtlMs ?? 5 * 60 * 1000; // 5 minutes

    // Start cleanup interval
    const cleanupIntervalMs = options?.cleanupIntervalMs ?? 30_000;
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions();
    }, cleanupIntervalMs);
  }

  /**
   * Handle an HLS request and return the HTTP response.
   *
   * @param params - Request parameters
   * @returns HTTP response ready to be sent
   */
  async handleRequest(params: {
    /** Unique session key (e.g., `${deviceId}:${fileId}`) */
    sessionKey: string;
    /** HLS path: "playlist.m3u8" or segment name like "segment_001.ts" */
    hlsPath: string;
    /** Full request URL for rewriting playlist URLs */
    requestUrl: string;
    /** Function to create session params if session doesn't exist */
    createSession: () => Promise<HlsSessionParams> | HlsSessionParams;
    /**
     * Optional prefix used to ensure only one active HLS session per logical client.
     * When a new session is created, any other sessions whose keys start with this
     * prefix will be stopped. This prevents replay/ffmpeg queue starvation when
     * clients quickly switch clips.
     */
    exclusiveKeyPrefix?: string;
  }): Promise<HlsHttpResponse> {
    const {
      sessionKey,
      hlsPath,
      requestUrl,
      createSession,
      exclusiveKeyPrefix,
    } = params;

    try {
      // Get or create session
      let entry = this.sessions.get(sessionKey);

      const isPlaylist = hlsPath === "playlist.m3u8" || hlsPath === "";
      const isSegment = hlsPath.endsWith(".ts");

      // IMPORTANT: Never create a new session from a segment request.
      // When clients switch clips, they may continue requesting old segments for a while.
      // If we created sessions from those late segment requests, we'd preempt the new clip
      // and cause a deadlock/thrash (devices often allow only one replay stream at a time).
      if (!entry && isSegment) {
        this.logger?.debug?.(
          `[HlsSessionManager] Segment request without session (likely stale after clip switch): ${sessionKey} ${hlsPath}`,
        );
        return {
          statusCode: 404,
          headers: {
            "Content-Type": "text/plain",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            Pragma: "no-cache",
            "Retry-After": "1",
          },
          body: "Segment not found",
        };
      }

      if (!entry) {
        // Only create sessions on playlist requests.
        if (!isPlaylist) {
          return {
            statusCode: 400,
            headers: { "Content-Type": "text/plain" },
            body: "Invalid HLS path",
          };
        }

        // Serialize creation for the same logical client to avoid races during clip switches.
        // iOS can issue multiple playlist requests back-to-back, and without a lock we may end
        // up creating two sessions concurrently (queue starvation / device single-stream limit).
        const lockKey = exclusiveKeyPrefix ?? sessionKey;
        await this.withCreationLock(lockKey, async () => {
          // Re-check under the lock.
          entry = this.sessions.get(sessionKey);
          if (entry) return;

          if (exclusiveKeyPrefix) {
            await this.stopOtherSessionsWithPrefix(
              exclusiveKeyPrefix,
              sessionKey,
            );
          }

          this.logger?.log?.(
            `[HlsSessionManager] Creating new session: ${sessionKey}`,
          );

          this.logger?.debug?.(
            `[HlsSessionManager] createSession(): ${sessionKey}`,
          );
          const sessionParams = await createSession();

          this.logger?.debug?.(
            `[HlsSessionManager] Starting createRecordingReplayHlsSession: ${sessionKey}`,
          );
          const session = await withTimeout(
            this.api.createRecordingReplayHlsSession({
              channel: sessionParams.channel,
              fileName: sessionParams.fileName,
              ...(sessionParams.isNvr !== undefined && {
                isNvr: sessionParams.isNvr,
              }),
              ...(this.logger && { logger: this.logger }),
              ...(sessionParams.deviceId && {
                deviceId: sessionParams.deviceId,
              }),
              transcodeH265ToH264: sessionParams.transcodeH265ToH264 ?? true,
              hlsSegmentDuration: sessionParams.hlsSegmentDuration ?? 4,
            }),
            20_000,
            "createRecordingReplayHlsSession",
          );

          // Wait for first segment to be ready.
          // Never hang the HTTP request indefinitely: iOS will retry playlist/segments.
          try {
            await withTimeout(
              session.waitForReady(),
              12_000,
              "hls waitForReady",
            );
          } catch (e) {
            this.logger?.warn?.(
              `[HlsSessionManager] waitForReady did not complete in time for ${sessionKey}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }

          entry = {
            session,
            createdAt: Date.now(),
            lastAccessAt: Date.now(),
          };
          this.sessions.set(sessionKey, entry);

          this.logger?.log?.(
            `[HlsSessionManager] Session ready: ${sessionKey}`,
          );
        });

        // Ensure the entry is available after creation.
        entry = this.sessions.get(sessionKey);
        if (!entry) {
          return {
            statusCode: 500,
            headers: {
              "Content-Type": "text/plain",
              "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
              Pragma: "no-cache",
            },
            body: "HLS session was not created",
          };
        }
      }

      // Update last access time
      entry.lastAccessAt = Date.now();

      // Handle playlist request
      if (isPlaylist) {
        return this.servePlaylist(entry.session, requestUrl, sessionKey);
      }

      // Handle segment request
      if (isSegment) {
        return this.serveSegment(entry.session, hlsPath, sessionKey);
      }

      // Invalid path
      return {
        statusCode: 400,
        headers: { "Content-Type": "text/plain" },
        body: "Invalid HLS path",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error?.(
        `[HlsSessionManager] Error handling request: ${message}`,
      );

      return {
        statusCode: 500,
        headers: { "Content-Type": "text/plain" },
        body: `HLS error: ${message}`,
      };
    }
  }

  private async withCreationLock(
    lockKey: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const prev = this.creationLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(
      () => current,
      () => current,
    );
    this.creationLocks.set(lockKey, chained);

    await prev.catch(() => {});
    try {
      await fn();
    } finally {
      release();
      if (this.creationLocks.get(lockKey) === chained) {
        this.creationLocks.delete(lockKey);
      }
    }
  }

  /**
   * Check if a session exists for the given key.
   */
  hasSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  /**
   * Stop a specific session.
   */
  async stopSession(sessionKey: string): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (entry) {
      this.logger?.debug?.(
        `[HlsSessionManager] Stopping session: ${sessionKey}`,
      );
      this.sessions.delete(sessionKey);
      await entry.session.stop().catch(() => {});
    }
  }

  /**
   * Stop all sessions and cleanup.
   */
  async stopAll(): Promise<void> {
    this.logger?.debug?.(`[HlsSessionManager] Stopping all sessions`);

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    const stopPromises = Array.from(this.sessions.values()).map((entry) =>
      entry.session.stop().catch(() => {}),
    );
    this.sessions.clear();
    await Promise.all(stopPromises);
  }

  /**
   * Get the number of active sessions.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Serve the HLS playlist with rewritten segment URLs.
   */
  private servePlaylist(
    session: HlsSession,
    requestUrl: string,
    sessionKey: string,
  ): HlsHttpResponse {
    let playlist = session.getPlaylist();

    // Rewrite segment references to use absolute URLs with ?hls= parameter
    // The original playlist has relative refs like "segment_000.ts"
    // We need to rewrite them to full paths with query param

    try {
      const url = new URL(requestUrl, "http://localhost");
      const basePath = url.pathname;

      // Preserve original query params (auth, etc.) but drop existing hls param.
      const baseParams = new URLSearchParams(url.searchParams);
      baseParams.delete("hls");

      // Rewrite segment references in playlist
      playlist = playlist.replace(/^(segment_\d+\.ts)$/gm, (match) => {
        const params = new URLSearchParams(baseParams);
        params.set("hls", match);
        return `${basePath}?${params.toString()}`;
      });
    } catch {
      // If URL parsing fails, keep original playlist
    }

    this.logger?.debug?.(
      `[HlsSessionManager] Serving playlist: ${sessionKey}, length=${playlist.length}`,
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
      },
      body: playlist,
    };
  }

  /**
   * Serve an HLS segment.
   */
  private serveSegment(
    session: HlsSession,
    segmentName: string,
    sessionKey: string,
  ): HlsHttpResponse {
    const segment = session.getSegment(segmentName);

    if (!segment) {
      this.logger?.warn?.(
        `[HlsSessionManager] Segment not found: ${segmentName}`,
      );
      return {
        statusCode: 404,
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          Pragma: "no-cache",
          "Retry-After": "1",
        },
        body: "Segment not found",
      };
    }

    this.logger?.debug?.(
      `[HlsSessionManager] Serving segment: ${segmentName} for ${sessionKey}, size=${segment.length}`,
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "video/mp2t",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
        "Content-Length": String(segment.length),
      },
      body: segment,
    };
  }

  /**
   * Cleanup expired sessions.
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.sessions) {
      if (now - entry.lastAccessAt > this.sessionTtlMs) {
        expiredKeys.push(key);
      }
    }

    if (!expiredKeys.length) return;

    await Promise.allSettled(
      expiredKeys.map(async (key) => {
        const entry = this.sessions.get(key);
        if (!entry) return;

        this.logger?.log?.(
          `[HlsSessionManager] TTL expired: stopping session ${key}`,
        );
        this.sessions.delete(key);

        try {
          await entry.session.stop();
        } catch {
          // ignore
        }
      }),
    );
  }

  private async stopOtherSessionsWithPrefix(
    prefix: string,
    exceptKey: string,
  ): Promise<void> {
    const toStop: string[] = [];
    for (const key of this.sessions.keys()) {
      if (key !== exceptKey && key.startsWith(prefix)) toStop.push(key);
    }

    if (!toStop.length) return;

    this.logger?.log?.(
      `[HlsSessionManager] Switch: stopping ${toStop.length} session(s) for prefix=${prefix}`,
    );

    await Promise.all(
      toStop.map(async (key) => {
        const entry = this.sessions.get(key);
        if (!entry) return;
        this.sessions.delete(key);
        await entry.session.stop().catch(() => {});
      }),
    );
  }
}

/**
 * Detect if the request is from an iOS device that needs HLS.
 *
 * @param userAgent - The User-Agent header from the request
 * @returns Object with iOS detection results
 */
export function detectIosClient(userAgent: string | undefined): {
  isIos: boolean;
  isIosInstalledApp: boolean;
  needsHls: boolean;
} {
  const ua = (userAgent ?? "").toLowerCase();
  const isIos = /iphone|ipad|ipod/.test(ua);
  const isIosInstalledApp = ua.includes("installedapp");

  return {
    isIos,
    isIosInstalledApp,
    // iOS InstalledApp needs HLS for video playback
    needsHls: isIos && isIosInstalledApp,
  };
}

/**
 * Build the HLS redirect URL from the original request URL.
 *
 * @param originalUrl - The original request URL
 * @returns The URL with ?hls=playlist.m3u8 appended
 */
export function buildHlsRedirectUrl(originalUrl: string): string {
  return `${originalUrl}${originalUrl.includes("?") ? "&" : "?"}hls=playlist.m3u8`;
}
