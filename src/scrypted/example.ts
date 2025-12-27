/**
 * Example integration with Scrypted.
 * This file shows how to use the library with Scrypted's VideoCamera and TwoWayAudio interfaces.
 * 
 * Based on:
 * - wyze plugin: https://github.com/koush/scrypted/blob/main/plugins/wyze/src/main.py
 * - tapo plugin: https://github.com/koush/scrypted/blob/2cc7ab08fd6fc58638dba82e0fd83c4cb7d0bb87/plugins/tapo/src/main.ts
 */

import { ReolinkBaichuanApi } from "../reolink/baichuan/ReolinkBaichuanApi.js";
import { getVideoStream, getConstructedVideoStreamOptions, ScryptedIntercom, ScryptedEventEmitter } from "./helpers.js";
import type { ReolinkEvent, StreamProfile } from "../reolink/baichuan/types.js";
import type { ResponseMediaStreamOptions } from "./helpers.js";

/**
 * Example Scrypted VideoCamera implementation
 */
export class ScryptedReolinkCamera {
  private api: ReolinkBaichuanApi;
  private channel: number;
  private eventEmitter: ScryptedEventEmitter;

  constructor(
    host: string,
    username: string,
    password: string,
    channel: number = 0,
    transport: "tcp" | "udp" | "auto" = "auto"
  ) {
    this.api = new ReolinkBaichuanApi({
      host,
      username,
      password,
      transport,
      channel,
    });
    this.channel = channel;
    this.eventEmitter = new ScryptedEventEmitter(this.api);
  }

  /**
   * Get video stream for Scrypted VideoCamera interface.
   * Similar to wyze getVideoStream().
   */
  async getVideoStream(
    profile: StreamProfile = "sub",
    rtspHost?: string,
    rtspPort: number = 554,
    rtspUsername?: string,
    rtspPassword?: string
  ) {
    // Login if needed
    await this.api.login();

    // Get stream metadata and build RTSP URL
    // Use provided RTSP credentials or default to Baichuan credentials
    return await getVideoStream({
      channel: this.channel,
      profile,
      api: this.api,
      rtspHost: rtspHost ?? "192.168.1.50", // Should be provided or stored
      rtspPort,
      rtspUsername: rtspUsername ?? "admin", // Should be provided or stored
      rtspPassword: rtspPassword ?? "", // Should be provided or stored
    });
  }

  /**
   * Get constructed video stream options for Scrypted.
   * Similar to Scrypted Reolink plugin getConstructedVideoStreamOptions().
   * Returns all available stream profiles with their metadata.
   */
  async getConstructedVideoStreamOptions(
    rtspHost?: string,
    rtspPort: number = 554,
    rtspUsername?: string,
    rtspPassword?: string
  ): Promise<ResponseMediaStreamOptions[]> {
    // Login if needed
    await this.api.login();

    return await getConstructedVideoStreamOptions(
      this.channel,
      this.api,
      rtspHost ?? "192.168.1.50", // Should be provided or stored
      rtspPort,
      rtspUsername ?? "admin", // Should be provided or stored
      rtspPassword ?? "" // Should be provided or stored
    );
  }

  /**
   * Subscribe to motion/AI events.
   * Events will be emitted via onEvent callback.
   */
  async subscribeEvents(onEvent: (event: ReolinkEvent) => void): Promise<void> {
    await this.eventEmitter.subscribe(onEvent);
  }

  /**
   * Unsubscribe from events.
   */
  async unsubscribeEvents(): Promise<void> {
    await this.eventEmitter.unsubscribe();
  }

  /**
   * Start two-way audio intercom.
   * Similar to tapo startIntercom() and ONVIF intercom.
   * 
   * Audio Format Requirements (for sending audio TO camera):
   * - Format: G.711 A-law (pcm_alaw), 8kHz, mono, 64k bitrate
   * - Audio reception is handled via the video stream, not through this interface
   * 
   * Reference: https://github.com/koush/scrypted/blob/2cc7ab08fd6fc58638dba82e0fd83c4cb7d0bb87/plugins/onvif/src/onvif-intercom.ts
   */
  async startIntercom(): Promise<ScryptedIntercom> {
    await this.api.login();

    const intercom = new ScryptedIntercom({
      channel: this.channel,
      api: this.api,
    });

    await intercom.start();
    return intercom;
  }

  /**
   * Close connection and cleanup.
   */
  async close(): Promise<void> {
    await this.eventEmitter.unsubscribe();
    await this.api.close();
  }
}

/**
 * Example usage in Scrypted plugin:
 * 
 * ```typescript
 * import { ScryptedReolinkCamera } from "baichuan-protocol/scrypted/example";
 * 
 * class ReolinkPlugin implements DeviceProvider, VideoCamera {
 *   private camera: ScryptedReolinkCamera;
 * 
 *   constructor() {
 *     this.camera = new ScryptedReolinkCamera(
 *       "192.168.1.50",
 *       "admin",
 *       "password",
 *       0, // channel
 *       "tcp" // transport
 *     );
 *   }
 * 
 *   async getVideoStream(options: RequestMediaStreamOptions): Promise<MediaObject> {
 *     const stream = await this.camera.getVideoStream("sub");
 *     // Return MediaObject with stream.url (RTSP URL)
 *     return {
 *       url: stream.url,
 *       container: stream.container,
 *       video: stream.video,
 *       audio: stream.audio,
 *     };
 *   }
 * 
 *   async startIntercom(microphone: MediaObject): Promise<TwoWayAudio> {
 *     const intercom = await this.camera.startIntercom((audioData) => {
 *       // Handle received audio data
 *     });
 * 
 *     return {
 *       async sendAudio(audio: Buffer) {
 *         await intercom.sendAudio(audio);
 *       },
 *       async stop() {
 *         await intercom.stop();
 *       },
 *     };
 *   }
 * 
 *   async onDeviceEvent(nativeId: string, eventInterface: string, eventData: any) {
 *     // Subscribe to events
 *     await this.camera.subscribeEvents((event) => {
 *       if (event.type === "motion" && event.motion?.state) {
 *         // Motion detected
 *         this.onMotionDetected(nativeId);
 *       }
 *       if (event.type === "ai" && event.ai?.detected) {
 *         // AI detection
 *         this.onAIDetected(nativeId, event.ai.type);
 *       }
 *     });
 *   }
 * }
 * ```
 */

