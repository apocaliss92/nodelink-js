/**
 * Helper functions and snippets for Scrypted integration.
 * Based on Scrypted plugins: wyze (getVideoStream) and tapo (startIntercom).
 * 
 * References:
 * - https://github.com/koush/scrypted/blob/main/plugins/wyze/src/main.py
 * - https://github.com/koush/scrypted/blob/2cc7ab08fd6fc58638dba82e0fd83c4cb7d0bb87/plugins/tapo/src/main.ts
 * - https://github.com/koush/scrypted/blob/2cc7ab08fd6fc58638dba82e0fd83c4cb7d0bb87/plugins/onvif/src/onvif-intercom.ts
 */

import type { ReolinkBaichuanApi } from "../reolink/baichuan/ReolinkBaichuanApi";
import type { ReolinkEvent, StreamProfile } from "../reolink/baichuan/types";
import { buildRtspUrl } from "../rtsp/urls";
import { spawn } from "node:child_process";
import { BaichuanVideoStream } from "../baichuan/stream/BaichuanVideoStream";

/**
 * Scrypted VideoStream options
 */
export interface ScryptedVideoStreamOptions {
  channel: number;
  profile: StreamProfile; // "main" | "sub" | "ext"
  api: ReolinkBaichuanApi;
  rtspHost: string;
  rtspPort?: number;
  rtspUsername: string;
  rtspPassword: string;
}

/**
 * Scrypted MediaStream response
 */
export interface ScryptedMediaStream {
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
 * Scrypted ResponseMediaStreamOptions (similar to Scrypted SDK)
 * Based on Scrypted Reolink plugin implementation
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
 * Get video stream for Scrypted integration.
 * Similar to wyze getVideoStream implementation.
 * 
 * Returns a MediaStream object compatible with Scrypted VideoCamera interface.
 */
export async function getVideoStream(options: ScryptedVideoStreamOptions): Promise<ScryptedMediaStream> {
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

  // Map video codec to Scrypted format
  const videoCodecMap: Record<string, string> = {
    "H.264": "h264",
    "H.265": "hevc",
    "MJPEG": "mjpeg",
    "MPEG4": "mpeg4",
  };

  const videoCodec = videoCodecMap[stream.videoEncType] ?? stream.videoEncType.toLowerCase();

  const result: ScryptedMediaStream = {
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
 * Get constructed video stream options for Scrypted integration.
 * Similar to Scrypted Reolink plugin getConstructedVideoStreamOptions().
 * 
 * Returns all available stream profiles (main, sub, ext) with their metadata.
 * Based on: https://github.com/koush/scrypted/blob/main/plugins/reolink/src/main.ts
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

  // Map video codec to Scrypted format
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
 * Two-way audio intercom options for Scrypted
 */
export interface ScryptedIntercomOptions {
  channel: number;
  api: ReolinkBaichuanApi;
}

/**
 * ScryptedIntercom - Two-way audio support for Reolink cameras via Baichuan protocol.
 * 
 * Audio Format Requirements (for sending audio TO camera):
 * =========================================================
 * 
 * Reolink Baichuan talk-back expects ADPCM (DVI4/IMA-style) in fixed-size blocks.
 * The exact parameters come from `TalkAbility` (cmd_id=10) and are applied via
 * `TalkConfig` (cmd_id=201). Audio data is then sent as BcMedia ADPCM packets
 * inside Talk (cmd_id=202) payloads.
 *
 * This helper assumes Scrypted/ffmpeg is responsible for producing the correct
 * ADPCM byte stream. No encoding is performed here.
 * 
 * Note: Audio reception is handled via the video stream, not through this intercom interface.
 * 
 * Reference: https://github.com/koush/scrypted/blob/2cc7ab08fd6fc58638dba82e0fd83c4cb7d0bb87/plugins/onvif/src/onvif-intercom.ts
 */
export class ScryptedIntercom {
  private api: ReolinkBaichuanApi;
  private channel: number;
  private active = false;
  private session: Awaited<ReturnType<ReolinkBaichuanApi["createTalkSession"]>> | undefined;

  constructor(options: ScryptedIntercomOptions) {
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
   * @param audioData - ADPCM byte stream produced by Scrypted/ffmpeg.
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
 * Event handler for Scrypted integration.
 * Subscribes to events and emits them in Scrypted-compatible format.
 */
export class ScryptedEventEmitter {
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
 * Stream frame data for Scrypted rebroadcast.
 * Similar to Wyze forkAndStream() implementation.
 * 
 * Returns an async generator that yields:
 * - audio: boolean (true for audio, false for video)
 * - data: Buffer (raw frame data)
 * - codec: string | null (audio codec name, null for video)
 * - sampleRate: number | null (audio sample rate, null for video)
 * 
 * Reference: https://github.com/koush/scrypted/blob/main/plugins/wyze/src/main.py#L393
 * 
 * Usage in Scrypted:
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
  profile: StreamProfile
): AsyncGenerator<{
  audio: boolean;
  data: Buffer;
  codec: string | null;
  sampleRate: number | null;
  microseconds: number | null;
  videoType?: "H264" | "H265";
}, void, unknown> {
  const videoStream = new BaichuanVideoStream({
    client: api.client,
    api,
    channel,
    profile,
  });

  let videoCodecInfo: { sps: Buffer | null; pps: Buffer | null } | null = null;
  let audioCodec: string | null = null;
  let audioSampleRate: number | null = null;
  let streamStarted = false;
  let closed = false;

  // Start the video stream
  await videoStream.start();

  // Handle errors
  videoStream.on("error", (error: Error) => {
    closed = true;
    throw error;
  });

  videoStream.on("close", () => {
    closed = true;
  });

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
  }> = [];

  let frameResolve: (() => void) | null = null;

  // Video frame handler
  videoStream.on("videoAccessUnit", (unit: {
    data: Buffer;
    isKeyframe: boolean;
    videoType: "H264" | "H265";
    microseconds: number;
  }) => {
    if (closed) return;
    
    frameQueue.push({
      audio: false,
      data: unit.data,
      codec: null,
      sampleRate: null,
      microseconds: unit.microseconds,
      videoType: unit.videoType,
    });
    
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
    
    if (frameResolve) {
      frameResolve();
      frameResolve = null;
    }
  });

  streamStarted = true;

  try {
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
  }
}

