/**
 * Helper functions for video streaming and two-way audio integration.
 * Based on implementations from various plugins (wyze, tapo, onvif).
 */

import type { ReolinkBaichuanApi } from "../reolink/baichuan/ReolinkBaichuanApi";
import type { NativeVideoStreamVariant, ReolinkEvent, StreamProfile } from "../reolink/baichuan/types";
import type { BaichuanClient } from "../client/BaichuanClient";
import { buildRtspUrl } from "../rtsp/urls";
import { spawn } from "node:child_process";
import { BaichuanVideoStream } from "../baichuan/stream/BaichuanVideoStream";

/**
 * VideoStream options
 */
export interface VideoStreamOptions {
  channel: number;
  profile: StreamProfile; // "main" | "sub" | "ext"
  api: ReolinkBaichuanApi;
  rtspHost: string;
  rtspPort?: number;
  rtspUsername: string;
  rtspPassword: string;
}

/**
 * MediaStream response
 */
export interface MediaStream {
  url?: string;
  container?: string;
  video?: {
    codec: string;
    width?: number;
    height?: number;
    fps?: number;
  };
  audio?: {
    codec: string;
    sampleRate?: number;
  };
}

/**
 * ResponseMediaStreamOptions - Stream profile metadata
 */
export interface ResponseMediaStreamOptions {
  id: string;
  name: string;
  description?: string;
  video?: {
    codec?: string;
    width?: number;
    height?: number;
    fps?: number;
  };
  audio?: {
    codec?: string;
    sampleRate?: number;
  };
  container?: string;
  tool?: string;
  userConfigurable?: boolean;
}

/**
 * Get video stream metadata and RTSP URL.
 * Similar to wyze getVideoStream implementation.
 * 
 * Returns a MediaStream object with stream information and RTSP URL.
 */
export async function getVideoStream(options: VideoStreamOptions): Promise<MediaStream> {
  const { channel, profile, api, rtspHost, rtspPort, rtspUsername, rtspPassword } = options;

  // Get stream metadata to determine codec and resolution
  const metadata = await api.getStreamMetadata(channel);
  const stream = metadata.streams.find((s) => s.profile === profile);

  if (!stream) {
    throw new Error(`Stream profile ${profile} not available for channel ${channel}`);
  }

  // Build RTSP URL
  const rtspUrl = buildRtspUrl({
    host: rtspHost,
    ...(rtspPort !== undefined ? { port: rtspPort } : {}),
    username: rtspUsername,
    password: rtspPassword,
    channel,
    stream: profile,
  });

  // Map video codec to standard format
  const videoCodecMap: Record<string, string> = {
    "H.264": "h264",
    "H.265": "hevc",
    "MJPEG": "mjpeg",
    "MPEG4": "mpeg4",
  };

  const videoCodec = videoCodecMap[stream.videoEncType] ?? stream.videoEncType.toLowerCase();

  const result: MediaStream = {
    url: rtspUrl,
    container: "rtsp",
    video: {
      codec: videoCodec,
      width: stream.width,
      height: stream.height,
      fps: stream.frameRate,
    },
  };

  // Add audio if enabled
  if (stream.audio === 1) {
    // Reolink typically uses AAC or G.711 for audio
    result.audio = {
      codec: "aac", // Default, may need to be determined from stream metadata
      sampleRate: 8000, // Typical for Reolink, may vary
    };
  }

  return result;
}

/**
 * Get constructed video stream options for all available profiles.
 * 
 * Returns all available stream profiles (main, sub, ext) with their metadata.
 */
export async function getConstructedVideoStreamOptions(
  channel: number,
  api: ReolinkBaichuanApi,
  rtspHost: string,
  rtspPort: number = 554,
  rtspUsername: string = "admin",
  rtspPassword: string = ""
): Promise<ResponseMediaStreamOptions[]> {
  // Get stream metadata for all available profiles
  const metadata = await api.getStreamMetadata(channel);
  const options: ResponseMediaStreamOptions[] = [];

  // Map video codec to standard format
  const videoCodecMap: Record<string, string> = {
    "H.264": "h264",
    "H.265": "hevc",
    "MJPEG": "mjpeg",
    "MPEG4": "mpeg4",
  };

  // Build options for each available stream
  for (const stream of metadata.streams) {
    const videoCodec = videoCodecMap[stream.videoEncType] ?? stream.videoEncType.toLowerCase();
    const profileName = stream.profile.charAt(0).toUpperCase() + stream.profile.slice(1);

    const option: ResponseMediaStreamOptions = {
      id: stream.profile,
      name: `${profileName} Stream`,
      description: `${profileName} stream - ${stream.width}x${stream.height} @ ${stream.frameRate}fps`,
      video: {
        codec: videoCodec,
        width: stream.width,
        height: stream.height,
        fps: stream.frameRate,
      },
      container: "rtsp",
      userConfigurable: true,
    };

    // Add audio info if enabled
    if (stream.audio === 1) {
      option.audio = {
        codec: "aac", // Default, may need to be determined from stream metadata
        sampleRate: 8000, // Typical for Reolink, may vary
      };
    }

    options.push(option);
  }

  return options;
}

/**
 * Two-way audio intercom options
 */
export interface IntercomOptions {
  channel: number;
  api: ReolinkBaichuanApi;
}

/**
 * Intercom - Two-way audio support for Reolink cameras via Baichuan protocol.
 * 
 * Audio Format Requirements (for sending audio TO camera):
 * =========================================================
 * 
 * Reolink Baichuan talk-back expects ADPCM (DVI4/IMA-style) in fixed-size blocks.
 * The exact parameters come from `TalkAbility` (cmd_id=10) and are applied via
 * `TalkConfig` (cmd_id=201). Audio data is then sent as BcMedia ADPCM packets
 * inside Talk (cmd_id=202) payloads.
 *
 * This helper assumes the caller (e.g., ffmpeg) is responsible for producing the correct
 * ADPCM byte stream. No encoding is performed here.
 * 
 * Note: Audio reception is handled via the video stream, not through this intercom interface.
 */
export class Intercom {
  private api: ReolinkBaichuanApi;
  private channel: number;
  private active = false;
  private session: Awaited<ReturnType<ReolinkBaichuanApi["createTalkSession"]>> | undefined;

  constructor(options: IntercomOptions) {
    this.api = options.api;
    this.channel = options.channel;
  }

  /**
   * Start two-way audio session.
   * Similar to tapo startIntercom() and ONVIF intercom.
   */
  async start(): Promise<void> {
    if (this.active) {
      throw new Error("Intercom session already active");
    }

    // `createTalkSession` validates TalkAbility and sends TalkConfig.
    this.session = await this.api.createTalkSession(this.channel);
    this.active = true;
  }

  /**
   * Send audio data to camera.
   * 
   * @param audioData - ADPCM byte stream produced by the caller (e.g., ffmpeg).
   *                    No encoding is performed - data is sent directly to the camera.
   */
  async sendAudio(audioData: Buffer): Promise<void> {
    if (!this.active) {
      throw new Error("Intercom session not active");
    }

    if (!this.session) {
      throw new Error("Intercom session missing (internal state error)");
    }
    await this.session.sendAudio(audioData);
  }

  /**
   * Stop two-way audio session.
   */
  async stop(): Promise<void> {
    if (!this.active) return;

    await this.session?.stop();
    this.session = undefined;
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }
}

/**
 * Event handler for Baichuan events.
 * Subscribes to events and emits them in a standard format.
 */
export class BaichuanEventEmitter {
  private api: ReolinkBaichuanApi;
  private subscribed = false;
  private onEventHandler: ((event: ReolinkEvent) => void) | undefined;

  constructor(api: ReolinkBaichuanApi) {
    this.api = api;
  }

  /**
   * Subscribe to events and start emitting them.
   */
  async subscribe(onEvent: (event: ReolinkEvent) => void): Promise<void> {
    if (this.subscribed) return;

    // Subscribe to events via Baichuan
    await this.api.subscribeEvents();

    // Listen for parsed events
    this.onEventHandler = (event: ReolinkEvent) => onEvent(event);
    this.api.client.on("event", this.onEventHandler);

    this.subscribed = true;
  }

  /**
   * Unsubscribe from events.
   */
  async unsubscribe(): Promise<void> {
    if (!this.subscribed) return;

    await this.api.unsubscribeEvents();
    if (this.onEventHandler) {
      this.api.client.removeListener("event", this.onEventHandler);
      this.onEventHandler = undefined;
    }
    this.subscribed = false;
  }

  isSubscribed(): boolean {
    return this.subscribed;
  }
}

/**
 * Stream frame data for rebroadcast.
 * Similar to Wyze forkAndStream() implementation.
 * 
 * Returns an async generator that yields:
 * - audio: boolean (true for audio, false for video)
 * - data: Buffer (raw frame data)
 * - codec: string | null (audio codec name, null for video)
 * - sampleRate: number | null (audio sample rate, null for video)
 * 
 * Usage example:
 * ```typescript
 * async *forkAndStream(profile: StreamProfile) {
 *   const gen = createNativeStream(this.api, this.channel, profile);
 *   for await (const { audio, data, codec, sampleRate } of gen) {
 *     yield { audio, data, codec, sampleRate };
 *   }
 * }
 * ```
 */
export async function* createNativeStream(
  api: ReolinkBaichuanApi,
  channel: number,
  profile: StreamProfile,
  options?: {
    variant?: NativeVideoStreamVariant;
    /** Optional dedicated BaichuanClient for stream isolation. When omitted, uses api.client (shared). */
    client?: BaichuanClient;
  }
): AsyncGenerator<{
  audio: boolean;
  data: Buffer;
  codec: string | null;
  sampleRate: number | null;
  microseconds: number | null;
  videoType?: "H264" | "H265";
  isKeyframe?: boolean;
}, void, unknown> {
  // When no dedicated client is provided, automatically acquire one from the socket pool.
  // This prevents VIDEO START from being rejected (400) on the shared socket used for events.
  let client = options?.client;
  let dedicatedRelease: (() => Promise<void>) | undefined;
  if (!client) {
    const variantSuffix = options?.variant && options.variant !== "default" ? `:${options.variant}` : "";
    const sessionKey = `native-stream:ch${channel}:${profile}${variantSuffix}`;
    try {
      api.logger?.info?.(`[createNativeStream] acquiring dedicated session  key=${sessionKey}`);
      const session = await api.createDedicatedSession(sessionKey);
      client = session.client;
      dedicatedRelease = session.release;
      api.logger?.info?.(`[createNativeStream] dedicated session acquired  key=${sessionKey}`);
    } catch (e) {
      // Fallback to shared client if pool is unavailable
      api.logger?.warn?.(`[createNativeStream] dedicated session failed, using shared client: ${e instanceof Error ? e.message : e}`);
      client = api.client;
    }
  }

  const videoStream = new BaichuanVideoStream({
    client,
    api,
    channel,
    profile,
    ...(options?.variant !== undefined ? { variant: options.variant } : {}),
    logger: api.logger,
  });

  let videoCodecInfo: { sps: Buffer | null; pps: Buffer | null } | null = null;
  let audioCodec: string | null = null;
  let audioSampleRate: number | null = null;
  let streamStarted = false;
  let closed = false;

  const onError = (_error: Error) => {
    closed = true;
    // Do not throw from an event callback: it can crash the process asynchronously.
    // Consumers will observe stream termination.
    api.logger?.warn?.(
      `[createNativeStream] stream error → closed  channel=${channel} profile=${profile} error=${_error?.message ?? _error}`,
    );
  };

  const onClose = () => {
    closed = true;
    api.logger?.warn?.(
      `[createNativeStream] stream close → closed  channel=${channel} profile=${profile}`,
    );
  };

  try {
    // Handle errors early (start() can fail/timeout asynchronously).
    videoStream.on("error", onError);
    videoStream.on("close", onClose);

    // Start the video stream
    await videoStream.start();

    // Collect video codec info (SPS/PPS for H.264) from first keyframe
    // Similar to Wyze implementation that writes SPS/PPS to ffmpeg
    const videoCodecInfoPromise = new Promise<{ sps: Buffer | null; pps: Buffer | null }>((resolve) => {
      const handler = (unit: { data: Buffer; isKeyframe: boolean; videoType: "H264" | "H265" }) => {
        if (unit.isKeyframe && !videoCodecInfo) {
          // Extract SPS/PPS from H.264 keyframe (if available)
          // For H.265, we'd need VPS/SPS/PPS but for now we'll pass raw data
          // The rebroadcast server will handle codec detection
          videoCodecInfo = { sps: null, pps: null };
          videoStream.removeListener("videoAccessUnit" as any, handler);
          resolve(videoCodecInfo);
        }
      };
      videoStream.on("videoAccessUnit" as any, handler);

      // Timeout after 5 seconds
      setTimeout(() => {
        if (!videoCodecInfo) {
          videoCodecInfo = { sps: null, pps: null };
          videoStream.removeListener("videoAccessUnit" as any, handler);
          resolve(videoCodecInfo);
        }
      }, 5000);
    });

    // Wait for codec info (with timeout)
    await Promise.race([
      videoCodecInfoPromise,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);

    // Stream video and audio frames
    const frameQueue: Array<{
      audio: boolean;
      data: Buffer;
      codec: string | null;
      sampleRate: number | null;
      microseconds: number | null;
      videoType?: "H264" | "H265";
      isKeyframe?: boolean;
    }> = [];

    // Prevent unbounded growth if the consumer pauses or is slower than the camera.
    // Live video streaming can safely drop older frames under backpressure.
    const MAX_FRAME_QUEUE = 200;

    // When we fall behind on inter-frame codecs (H.264/H.265), dropping arbitrary frames
    // can break decoder reference chains (missing refs / duplicate POC). Instead, when
    // we detect sustained backpressure, we resync by discarding queued frames and then
    // dropping non-keyframes until the next keyframe/IDR arrives.
    let needKeyframeResync = false;
    let lastResyncLogAt = 0;

    let frameResolve: (() => void) | null = null;

    // Video frame handler
    videoStream.on("videoAccessUnit", (unit: {
      data: Buffer;
      isKeyframe: boolean;
      videoType: "H264" | "H265";
      microseconds: number;
    }) => {
      if (closed) return;

      if (needKeyframeResync && !unit.isKeyframe) {
        return;
      }

      if (needKeyframeResync && unit.isKeyframe) {
        needKeyframeResync = false;
      }

      frameQueue.push({
        audio: false,
        data: unit.data,
        codec: null,
        sampleRate: null,
        microseconds: unit.microseconds,
        videoType: unit.videoType,
        isKeyframe: unit.isKeyframe,
      });

      if (frameQueue.length > MAX_FRAME_QUEUE) {
        frameQueue.length = 0;
        needKeyframeResync = true;

        const now = Date.now();
        if (now - lastResyncLogAt > 5000) {
          lastResyncLogAt = now;
          api.logger?.warn?.(
            `[createNativeStream] backpressure overflow (channel=${channel} profile=${profile}); resyncing on next keyframe`,
          );
        }
      }

      if (frameResolve) {
        frameResolve();
        frameResolve = null;
      }
    });

    // Audio frame handler
    videoStream.on("audioFrame", (frame: Buffer) => {
      if (closed) return;

      // Default audio codec for Reolink (typically AAC)
      // This could be enhanced to detect actual codec from stream metadata
      if (!audioCodec) {
        audioCodec = "aac"; // Default, may need detection
        audioSampleRate = 8000; // Default, may need detection
      }

      frameQueue.push({
        audio: true,
        data: frame,
        codec: audioCodec,
        sampleRate: audioSampleRate,
        microseconds: null,
      });

      if (frameQueue.length > MAX_FRAME_QUEUE) {
        frameQueue.splice(0, frameQueue.length - MAX_FRAME_QUEUE);
      }

      if (frameResolve) {
        frameResolve();
        frameResolve = null;
      }
    });

    streamStarted = true;

    // Yield frames as they arrive
    while (!closed) {
      if (frameQueue.length > 0) {
        const frame = frameQueue.shift()!;
        yield frame;
      } else {
        // Wait for next frame
        await new Promise<void>((resolve) => {
          frameResolve = resolve;
          // Timeout after 1 second to check if stream is still active
          setTimeout(() => {
            if (frameResolve === resolve) {
              frameResolve = null;
              resolve();
            }
          }, 1000);
        });
      }
    }
  } finally {
    // Cleanup
    closed = true;
    try {
      await videoStream.stop();
    } catch {
      // Ignore stop errors
    }
    videoStream.removeListener("error", onError);
    videoStream.removeListener("close", onClose);
    // Release the dedicated session acquired above
    if (dedicatedRelease) {
      dedicatedRelease().catch(() => { /* ignore */ });
    }
  }
}

