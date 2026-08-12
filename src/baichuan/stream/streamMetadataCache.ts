/**
 * Per-profile stream metadata resolution for the RTSP server.
 *
 * Reading stream metadata means issuing a real Baichuan `getEncXml` to the
 * camera. On a battery camera that command **wakes it up**, so it must happen
 * once per stream, not once per client connection.
 *
 * `lazyMetadata` mode defers the initial fetch to the first DESCRIBE
 * specifically to avoid waking a sleeping camera just to bind the RTSP port.
 * The result of that deferred fetch has to be cached, or the option inverts
 * its own purpose: every reconnecting client triggers another fetch and wakes
 * the camera again. With a consumer that reconnects on a timer, that is a
 * permanent wake loop and a flat battery (issue #35).
 *
 * Hence {@link resolveProfileStreamMetadata} reports whether its result is
 * worth caching. Fallbacks are deliberately *not* cacheable: pinning a stream
 * to a guessed 25 fps for the lifetime of the server because the camera
 * happened to be asleep once would be worse than retrying.
 */

/** The subset of stream metadata the RTSP server actually consumes. */
export interface ProfileStreamMetadata {
  frameRate: number;
  width?: number;
  height?: number;
}

/** Shape of one entry in a `getStreamMetadata()` response. */
export interface StreamMetadataEntry {
  profile: string;
  frameRate?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

export interface StreamMetadataResponse {
  streams: ReadonlyArray<StreamMetadataEntry>;
}

export interface ResolveStreamMetadataHooks {
  onWarn?: (message: string) => void;
  onDebug?: (message: string) => void;
}

export interface ResolvedStreamMetadata {
  metadata: ProfileStreamMetadata;
  /**
   * True when `metadata` came from a successful camera read and should be
   * stored so later DESCRIBEs do not hit the camera again. False for cache
   * hits (nothing new) and for fallbacks (must be retried).
   */
  cacheable: boolean;
}

/** Frame rate assumed when the camera cannot be read. */
const FALLBACK_FRAME_RATE = 25;

export async function resolveProfileStreamMetadata(
  cached: ProfileStreamMetadata | null | undefined,
  profile: string,
  fetchMetadata: () => Promise<StreamMetadataResponse>,
  hooks?: ResolveStreamMetadataHooks,
): Promise<ResolvedStreamMetadata> {
  if (cached?.frameRate) {
    return { metadata: cached, cacheable: false };
  }

  try {
    const response = await fetchMetadata();
    const stream = response.streams.find((s) => s.profile === profile);
    if (stream) {
      const metadata: ProfileStreamMetadata = {
        frameRate: stream.frameRate || FALLBACK_FRAME_RATE,
        ...(stream.width === undefined ? {} : { width: stream.width }),
        ...(stream.height === undefined ? {} : { height: stream.height }),
      };
      hooks?.onDebug?.(
        `Fetched metadata for profile ${profile}: ${metadata.frameRate} fps`,
      );
      return { metadata, cacheable: true };
    }
    hooks?.onWarn?.(
      `[BaichuanRtspServer] Stream profile ${profile} missing from metadata; assuming ${FALLBACK_FRAME_RATE} fps`,
    );
  } catch (error) {
    hooks?.onWarn?.(
      `[BaichuanRtspServer] Could not fetch stream metadata: ${error}`,
    );
  }

  return { metadata: { frameRate: FALLBACK_FRAME_RATE }, cacheable: false };
}
