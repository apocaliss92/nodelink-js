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

  constructor(
    private readonly api: ReolinkBaichuanApi,
    options?: HlsSessionManagerOptions,
  ) {
    this.logger = options?.logger;
    this.sessionTtlMs = options?.sessionTtlMs ?? 5 * 60 * 1000; // 5 minutes

    // Start cleanup interval
    const cleanupIntervalMs = options?.cleanupIntervalMs ?? 30_000;
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, cleanupIntervalMs);
  }

  /**
   * Handle an HLS request and return the HTTP response.
   *
   * @param params Request parameters
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
  }): Promise<HlsHttpResponse> {
    const { sessionKey, hlsPath, requestUrl, createSession } = params;

    try {
      // Get or create session
      let entry = this.sessions.get(sessionKey);

      if (!entry) {
        this.logger?.log?.(
          `[HlsSessionManager] Creating new session: ${sessionKey}`,
        );

        const sessionParams = await createSession();

        const session = await this.api.createRecordingReplayHlsSession({
          channel: sessionParams.channel,
          fileName: sessionParams.fileName,
          ...(sessionParams.isNvr !== undefined && {
            isNvr: sessionParams.isNvr,
          }),
          ...(this.logger && { logger: this.logger }),
          ...(sessionParams.deviceId && { deviceId: sessionParams.deviceId }),
          transcodeH265ToH264: sessionParams.transcodeH265ToH264 ?? true,
          hlsSegmentDuration: sessionParams.hlsSegmentDuration ?? 4,
        });

        // Wait for first segment to be ready
        await session.waitForReady();

        entry = {
          session,
          createdAt: Date.now(),
          lastAccessAt: Date.now(),
        };
        this.sessions.set(sessionKey, entry);

        this.logger?.log?.(`[HlsSessionManager] Session ready: ${sessionKey}`);
      }

      // Update last access time
      entry.lastAccessAt = Date.now();

      // Handle playlist request
      if (hlsPath === "playlist.m3u8" || hlsPath === "") {
        return this.servePlaylist(entry.session, requestUrl, sessionKey);
      }

      // Handle segment request
      if (hlsPath.endsWith(".ts")) {
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

      // Rewrite segment references in playlist
      playlist = playlist.replace(/^(segment_\d+\.ts)$/gm, (match) => {
        // Build absolute URL: basePath?hls=segment_xxx.ts
        return `${basePath}?hls=${match}`;
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
        "Cache-Control": "no-cache",
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
        headers: { "Content-Type": "text/plain" },
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
        "Cache-Control": "no-cache",
      },
      body: segment,
    };
  }

  /**
   * Cleanup expired sessions.
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.sessions) {
      if (now - entry.lastAccessAt > this.sessionTtlMs) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      const entry = this.sessions.get(key);
      if (entry) {
        this.logger?.debug?.(
          `[HlsSessionManager] Cleaning up expired session: ${key}`,
        );
        this.sessions.delete(key);
        entry.session.stop().catch(() => {});
      }
    }
  }
}

/**
 * Detect if the request is from an iOS device that needs HLS.
 *
 * @param userAgent The User-Agent header from the request
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
 * @param originalUrl The original request URL
 * @returns The URL with ?hls=playlist.m3u8 appended
 */
export function buildHlsRedirectUrl(originalUrl: string): string {
  return `${originalUrl}${originalUrl.includes("?") ? "&" : "?"}hls=playlist.m3u8`;
}
