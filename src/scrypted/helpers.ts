/**
 * Helper functions and snippets for Scrypted integration.
 * Based on Scrypted plugins: wyze (getVideoStream) and tapo (startIntercom).
 * 
 * References:
 * - https://github.com/koush/scrypted/blob/main/plugins/wyze/src/main.py
 * - https://github.com/koush/scrypted/blob/2cc7ab08fd6fc58638dba82e0fd83c4cb7d0bb87/plugins/tapo/src/main.ts
 * - https://github.com/koush/scrypted/blob/2cc7ab08fd6fc58638dba82e0fd83c4cb7d0bb87/plugins/onvif/src/onvif-intercom.ts
 */

import type { ReolinkBaichuanApi } from "../reolink/baichuan/ReolinkBaichuanApi.js";
import type { ReolinkEvent, StreamProfile } from "../reolink/baichuan/types.js";
import { buildRtspUrl } from "../rtsp/urls.js";
import { spawn } from "node:child_process";

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
 * - Format: G.711 A-law (pcm_alaw)
 * - Sample Rate: 8000 Hz
 * - Channels: 1 (mono)
 * - Bitrate: 64k (typical)
 * 
 * Scrypted will pass audio data already in the correct format via FFmpegInput.
 * No encoding/decoding is performed - data is passed directly to the camera.
 * 
 * Example ffmpeg encoder arguments (similar to ONVIF intercom):
 *   -acodec pcm_alaw
 *   -ar 8000
 *   -ac 1
 *   -b:a 64k
 * 
 * Note: Audio reception is handled via the video stream, not through this intercom interface.
 * 
 * Reference: https://github.com/koush/scrypted/blob/2cc7ab08fd6fc58638dba82e0fd83c4cb7d0bb87/plugins/onvif/src/onvif-intercom.ts
 */
export class ScryptedIntercom {
  private api: ReolinkBaichuanApi;
  private channel: number;
  private active = false;

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

    // Check if two-way audio is supported
    const config = await this.api.getTwoWayAudioConfig(this.channel);
    if (!config.enabled) {
      throw new Error(`Two-way audio not supported on channel ${this.channel}`);
    }

    // Start two-way audio session
    await this.api.startTwoWayAudio(this.channel);

    this.active = true;
  }

  /**
   * Send audio data to camera.
   * 
   * @param audioData - G.711 A-law encoded audio data (from Scrypted/ffmpeg)
   *                    Format: pcm_alaw, 8kHz, mono, 64k bitrate
   *                    No encoding is performed - data is sent directly to camera.
   * 
   * Note: Scrypted will pass audio already in G.711 A-law format via FFmpegInput.
   *       This method sends the data directly to the camera without modification.
   *       Similar to ONVIF intercom implementation.
   */
  async sendAudio(audioData: Buffer): Promise<void> {
    if (!this.active) {
      throw new Error("Intercom session not active");
    }

    // Send audio data directly to camera (already in G.711 A-law format from ffmpeg)
    // No encoding/decoding needed - Scrypted handles format conversion via ffmpeg
    await this.api.sendAudioData(audioData, this.channel);
  }

  /**
   * Stop two-way audio session.
   */
  async stop(): Promise<void> {
    if (!this.active) return;

    await this.api.stopTwoWayAudio(this.channel);
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
    this.api.client.on("event", (event: ReolinkEvent) => {
      onEvent(event);
    });

    this.subscribed = true;
  }

  /**
   * Unsubscribe from events.
   */
  async unsubscribe(): Promise<void> {
    if (!this.subscribed) return;

    await this.api.unsubscribeEvents();
    this.api.client.removeAllListeners("event");
    this.subscribed = false;
  }

  isSubscribed(): boolean {
    return this.subscribed;
  }
}

