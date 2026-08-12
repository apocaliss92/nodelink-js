/**
 * Baichuan WebRTC Server - WebRTC streaming from Baichuan cameras
 *
 * Provides ultra-low latency video/audio streaming using native Baichuan protocol.
 * Supports bidirectional audio (intercom) via WebRTC DataChannel.
 *
 * Architecture:
 * - Camera → Baichuan native stream → H.264/H.265 frames → RTP → WebRTC
 * - Browser mic → WebRTC DataChannel → ADPCM encoding → Baichuan Talk → Camera speaker
 *
 * Usage:
 * ```typescript
 * const webrtc = new BaichuanWebRTCServer({
 *   api: reolinkApi,
 *   channel: 0,
 *   profile: "main",
 *   enableIntercom: true,
 * });
 *
 * // Create offer for client
 * const { sessionId, offer } = await webrtc.createSession();
 *
 * // Send offer to browser via signaling, receive answer
 * await webrtc.handleAnswer(sessionId, answer);
 *
 * // Handle ICE candidates
 * await webrtc.addIceCandidate(sessionId, candidate);
 *
 * // Close session
 * await webrtc.closeSession(sessionId);
 * ```
 */

import { EventEmitter } from "node:events";
import type { StreamProfile } from "../../reolink/baichuan/types";
import type { ReolinkBaichuanApi } from "../../reolink/baichuan/ReolinkBaichuanApi";
import type { NativeVideoStreamVariant } from "../../reolink/baichuan/types";
import { createNativeStream, Intercom } from "../../rfc/helpers";
import { detectVideoCodecFromNal } from "./BcMediaAnnexBDecoder";
import { AacToOpusTranscoder } from "./AacToOpusTranscoder";
import {
  convertToAnnexB as convertH264ToAnnexB,
  isH264KeyframeAnnexB,
  splitAnnexBToNalPayloads as splitH264AnnexBToNalPayloads,
} from "./H264Converter";

// ============================================================================
// Types
// ============================================================================

export interface BaichuanWebRTCServerOptions {
  /** API instance (required) */
  api: ReolinkBaichuanApi;
  /** Channel number (required) */
  channel: number;
  /** Stream profile (required) */
  profile: StreamProfile;
  /** Native-only: TrackMix tele/autotrack variants */
  variant?: NativeVideoStreamVariant;
  /** Enable two-way audio intercom (default: false) */
  enableIntercom?: boolean;
  /** STUN servers for ICE (default: Google STUN) */
  stunServers?: string[];
  /** TURN servers for NAT traversal (optional) */
  turnServers?: Array<{
    urls: string;
    username?: string;
    credential?: string;
  }>;
  /** Limit the UDP port range used by ICE (useful for Docker port publishing) */
  icePortRange?: [number, number];
  /** Extra host addresses to advertise as candidates (e.g. host LAN IP) */
  iceAdditionalHostAddresses?: string[];
  /** Force relay-only (TURN) if needed */
  iceTransportPolicy?: "all" | "relay";
  /**
   * Path to ffmpeg used for AAC → Opus audio transcoding. Defaults to
   * "ffmpeg" on PATH. Pass an empty string to disable audio (the audio track
   * will still appear in the SDP for SDP-stability, but stay silent).
   */
  ffmpegPath?: string;
  /** Logger callback */
  logger?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ) => void;
}

export interface WebRTCSessionInfo {
  id: string;
  state: "connecting" | "connected" | "disconnected" | "failed";
  createdAt: Date;
  stats: {
    videoFrames: number;
    audioFrames: number;
    bytesSent: number;
    intercomBytesSent: number;
  };
}

export interface WebRTCOffer {
  sdp: string;
  type: "offer";
}

export interface WebRTCAnswer {
  sdp: string;
  type: "answer";
}

export interface WebRTCIceCandidate {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}

/**
 * werift's `RTCIceCandidate` constructor takes a **single init object** and
 * copies it onto the instance (`Object.assign(this, props)`) — it is not the
 * positional `(candidate, sdpMid)` form of the browser API. Passing the
 * candidate string positionally spreads it into numeric keys, leaves
 * `.candidate` undefined, and `IceCandidate.fromJSON()` then throws inside a
 * swallowed try/catch, so every trickled candidate is dropped without a trace.
 *
 * `sdpMLineIndex` matters too: werift routes candidates via
 * `getTransportByMLineIndex` and only honours a **number**. With just an
 * `sdpMid` string it silently falls back to `iceTransports[0]`, which is wrong
 * for any session with more than one m-line. When the caller omits it we
 * recover it from a numeric `sdpMid`.
 */
export function toWeriftIceCandidateInit(
  candidate: Readonly<WebRTCIceCandidate>,
): { candidate: string; sdpMid: string; sdpMLineIndex?: number } {
  const sdpMid = candidate.sdpMid ?? "0";
  const parsedMid = Number.parseInt(sdpMid, 10);
  const sdpMLineIndex =
    candidate.sdpMLineIndex ??
    (Number.isInteger(parsedMid) && String(parsedMid) === sdpMid
      ? parsedMid
      : undefined);

  return {
    candidate: candidate.candidate,
    sdpMid,
    // Omit rather than pass undefined (`exactOptionalPropertyTypes`).
    ...(sdpMLineIndex === undefined ? {} : { sdpMLineIndex }),
  };
}

interface WebRTCSession {
  id: string;
  peerConnection: any; // RTCPeerConnection from werift
  videoTrack: any; // MediaStreamTrack from werift
  audioTrack: any; // MediaStreamTrack from werift
  videoDataChannel: any; // RTCDataChannel for H.265 video frames
  nativeStream: AsyncGenerator<any, void, unknown> | null;
  intercom: Intercom | null;
  dataChannel: any; // RTCDataChannel for intercom
  videoCodec: "H264" | "H265" | null;
  // H.264 parameter sets cache
  lastH264Sps?: Buffer | null;
  lastH264Pps?: Buffer | null;
  // H.265 parameter sets cache
  lastH265Vps?: Buffer | null;
  lastH265Sps?: Buffer | null;
  lastH265Pps?: Buffer | null;
  hasReceivedKeyframe?: boolean; // Track if we've received an IDR frame
  // AAC → Opus transcoder for the audio track. Lazy-spun on the first audio
  // frame so non-audio sessions don't fork an ffmpeg process.
  audioTranscoder?: AacToOpusTranscoder | null;
  // RTP sequence + timestamp counters for the audio track. ffmpeg's RTP
  // output uses its own SSRC, so we extract just the opus payload and rewrap
  // it with our audio track's SSRC and our own monotonic seq.
  audioRtpSequence?: number;
  audioRtpTimestampBase?: number;
  audioStartedLogged?: boolean;
  createdAt: Date;
  state: "connecting" | "connected" | "disconnected" | "failed";
  stats: {
    videoFrames: number;
    audioFrames: number;
    bytesSent: number;
    intercomBytesSent: number;
  };
  cleanup?: () => void;
}

// ============================================================================
// H.264/H.265 NAL Parsing Helpers
// ============================================================================

/**
 * Parse NAL units from Annex-B format
 * Annex-B uses start codes (0x00000001 or 0x000001) to delimit NALUs
 */
function parseAnnexBNalUnits(annexB: Buffer): Buffer[] {
  const nalUnits: Buffer[] = [];
  let offset = 0;

  while (offset < annexB.length) {
    // Find start code
    let startCodeLen = 0;
    if (
      offset + 4 <= annexB.length &&
      annexB[offset] === 0 &&
      annexB[offset + 1] === 0 &&
      annexB[offset + 2] === 0 &&
      annexB[offset + 3] === 1
    ) {
      startCodeLen = 4;
    } else if (
      offset + 3 <= annexB.length &&
      annexB[offset] === 0 &&
      annexB[offset + 1] === 0 &&
      annexB[offset + 2] === 1
    ) {
      startCodeLen = 3;
    } else {
      offset++;
      continue;
    }

    const naluStart = offset + startCodeLen;

    // Find next start code or end of buffer
    let naluEnd = annexB.length;
    for (let i = naluStart; i < annexB.length - 2; i++) {
      if (
        annexB[i] === 0 &&
        annexB[i + 1] === 0 &&
        (annexB[i + 2] === 1 ||
          (i + 3 < annexB.length && annexB[i + 2] === 0 && annexB[i + 3] === 1))
      ) {
        naluEnd = i;
        break;
      }
    }

    if (naluEnd > naluStart) {
      nalUnits.push(annexB.subarray(naluStart, naluEnd));
    }

    offset = naluEnd;
  }

  return nalUnits;
}

/**
 * Get H.264 NAL unit type from first byte
 */
function getH264NalType(nalUnit: Buffer): number {
  return nalUnit[0]! & 0x1f;
}

/**
 * Get H.265 NAL unit type from first two bytes
 */
function getH265NalType(nalUnit: Buffer): number {
  return (nalUnit[0]! >> 1) & 0x3f;
}

// ============================================================================
// BaichuanWebRTCServer
// ============================================================================

/**
 * BaichuanWebRTCServer - WebRTC server for Baichuan video streams
 *
 * Events:
 * - 'session-created': New session created
 * - 'session-connected': Session connected (ICE complete)
 * - 'session-closed': Session closed
 * - 'intercom-started': Intercom started for session
 * - 'intercom-stopped': Intercom stopped for session
 * - 'error': Error occurred
 */
export class BaichuanWebRTCServer extends EventEmitter {
  private readonly options: BaichuanWebRTCServerOptions;
  private readonly sessions = new Map<string, WebRTCSession>();
  private sessionIdCounter = 0;
  private weriftModule: any = null;

  constructor(options: BaichuanWebRTCServerOptions) {
    super();
    this.options = options;
  }

  /**
   * Initialize werift module (lazy load to avoid requiring it if not used)
   */
  private async loadWerift(): Promise<typeof import("werift")> {
    if (this.weriftModule) return this.weriftModule;

    try {
      this.weriftModule = await import("werift");
      return this.weriftModule;
    } catch (err) {
      throw new Error(
        `Failed to load werift module. Make sure it's installed: npm install werift\nError: ${err}`,
      );
    }
  }

  /**
   * Create a new WebRTC session
   * Returns a session ID and SDP offer to send to the browser
   */
  async createSession(): Promise<{ sessionId: string; offer: WebRTCOffer }> {
    const werift = await this.loadWerift();
    const { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } =
      werift;

    const sessionId = `webrtc-${++this.sessionIdCounter}-${Date.now()}`;

    this.log("info", `Creating WebRTC session ${sessionId}`);

    // Configure ICE servers
    const iceServers: any[] = [];

    // Add STUN servers
    const stunServers = this.options.stunServers ?? [
      "stun:stun.l.google.com:19302",
    ];
    for (const urls of stunServers) {
      iceServers.push({ urls });
    }

    // Add TURN servers if provided
    if (this.options.turnServers) {
      iceServers.push(...this.options.turnServers);
    }

    // Create peer connection with H.264 codec
    const peerConnection = new RTCPeerConnection({
      iceServers,
      // `exactOptionalPropertyTypes` is on: werift's PeerConfig does not accept
      // an explicit `undefined`, so omit these keys entirely when unset rather
      // than passing undefined through.
      ...(this.options.icePortRange
        ? { icePortRange: this.options.icePortRange }
        : {}),
      ...(this.options.iceAdditionalHostAddresses
        ? { iceAdditionalHostAddresses: this.options.iceAdditionalHostAddresses }
        : {}),
      ...(this.options.iceTransportPolicy
        ? { iceTransportPolicy: this.options.iceTransportPolicy }
        : {}),
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: "video/H264",
            clockRate: 90000,
            rtcpFeedback: [
              { type: "nack" },
              { type: "nack", parameter: "pli" },
              { type: "goog-remb" },
            ],
            parameters:
              "packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1",
          }),
        ],
        audio: [
          new RTCRtpCodecParameters({
            mimeType: "audio/opus",
            clockRate: 48000,
            channels: 2,
          }),
        ],
      },
    });

    // Create session object
    const session: WebRTCSession = {
      id: sessionId,
      peerConnection,
      videoTrack: null,
      audioTrack: null,
      videoDataChannel: null,
      nativeStream: null,
      intercom: null,
      dataChannel: null,
      videoCodec: null,
      createdAt: new Date(),
      state: "connecting",
      stats: {
        videoFrames: 0,
        audioFrames: 0,
        bytesSent: 0,
        intercomBytesSent: 0,
      },
    };

    this.sessions.set(sessionId, session);

    // Add video track (H.264 - will be used only for H.264 streams)
    // Generate a random SSRC for the video track
    const videoSsrc = (Math.random() * 0xffffffff) >>> 0;
    const videoTrack = new MediaStreamTrack({ kind: "video", ssrc: videoSsrc });
    const videoSender = peerConnection.addTrack(videoTrack);
    session.videoTrack = videoTrack;

    // Log SSRC for debugging
    this.log(
      "info",
      `Video track created: ssrc=${videoTrack.ssrc}, sender params=${JSON.stringify(videoSender?.getParameters?.() ?? {})}`,
    );

    // Add audio track (Opus for WebRTC)
    const audioSsrc = (Math.random() * 0xffffffff) >>> 0;
    const audioTrack = new MediaStreamTrack({ kind: "audio", ssrc: audioSsrc });
    peerConnection.addTrack(audioTrack);
    session.audioTrack = audioTrack;

    // Create data channel for H.265 video frames (browser will decode with WebCodecs)
    const videoDataChannel = peerConnection.createDataChannel("video", {
      ordered: true,
      maxRetransmits: 0, // Unreliable for real-time video
    });
    session.videoDataChannel = videoDataChannel;

    videoDataChannel.onopen = () => {
      this.log("info", `Video data channel opened for session ${sessionId}`);
    };

    // Create data channel for intercom audio (browser → camera)
    if (this.options.enableIntercom) {
      const dataChannel = peerConnection.createDataChannel("intercom", {
        ordered: true,
      });
      session.dataChannel = dataChannel;

      dataChannel.onopen = () => {
        this.log(
          "info",
          `Intercom data channel opened for session ${sessionId}`,
        );
        this.emit("intercom-started", { sessionId });
      };

      dataChannel.onmessage = async (event: any) => {
        // Handle incoming audio from browser for intercom
        if (session.intercom && event.data instanceof ArrayBuffer) {
          try {
            const audioData = Buffer.from(event.data);
            await session.intercom.sendAudio(audioData);
            session.stats.intercomBytesSent += audioData.length;
          } catch (err) {
            this.log("error", `Failed to send intercom audio: ${err}`);
          }
        }
      };

      dataChannel.onclose = () => {
        this.log(
          "info",
          `Intercom data channel closed for session ${sessionId}`,
        );
        this.emit("intercom-stopped", { sessionId });
      };
    }

    // Handle ICE connection state changes
    peerConnection.iceConnectionStateChange.subscribe((state: string) => {
      this.log("info", `ICE connection state for ${sessionId}: ${state}`);
      if (state === "connected") {
        session.state = "connected";
        this.emit("session-connected", { sessionId });
      } else if (state === "failed") {
        session.state = state as any;
        this.closeSession(sessionId).catch((err) => {
          this.log("error", `Error closing session on ICE ${state}: ${err}`);
        });
      }
      // Note: "disconnected" is often transient on LAN, don't immediately close
    });

    // Handle peer connection state changes
    peerConnection.connectionStateChange.subscribe((state: string) => {
      this.log("debug", `Connection state for ${sessionId}: ${state}`);
      if (state === "closed" || state === "failed") {
        this.closeSession(sessionId).catch((err) => {
          this.log(
            "error",
            `Error closing session on connection ${state}: ${err}`,
          );
        });
      }
    });

    // Create offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    // Wait for ICE gathering to complete (or timeout)
    await this.waitForIceGathering(peerConnection, 3000);

    const localDescription = peerConnection.localDescription;
    if (!localDescription) {
      throw new Error("Failed to create local description");
    }

    this.emit("session-created", { sessionId });

    return {
      sessionId,
      offer: {
        sdp: localDescription.sdp,
        type: "offer",
      },
    };
  }

  /**
   * Handle WebRTC answer from browser and start streaming
   */
  async handleAnswer(sessionId: string, answer: WebRTCAnswer): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const werift = await this.loadWerift();
    const { RTCSessionDescription } = werift;

    this.log("info", `Handling WebRTC answer for session ${sessionId}`);

    // Set remote description
    await session.peerConnection.setRemoteDescription(
      new RTCSessionDescription(answer.sdp, answer.type),
    );

    // Start native stream
    await this.startNativeStream(session);

    // Start intercom if enabled
    if (this.options.enableIntercom && session.dataChannel) {
      await this.startIntercom(session);
    }
  }

  /**
   * Add ICE candidate from browser
   */
  async addIceCandidate(
    sessionId: string,
    candidate: WebRTCIceCandidate,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const werift = await this.loadWerift();
    const { RTCIceCandidate } = werift;

    await session.peerConnection.addIceCandidate(
      new RTCIceCandidate(toWeriftIceCandidateInit(candidate)),
    );
  }

  /**
   * Close a WebRTC session
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.log("info", `Closing WebRTC session ${sessionId}`);
    session.state = "disconnected";

    // Stop intercom
    if (session.intercom) {
      try {
        await session.intercom.stop();
      } catch (err) {
        this.log("debug", `Error stopping intercom: ${err}`);
      }
      session.intercom = null;
    }

    // Close data channel
    if (session.dataChannel) {
      try {
        session.dataChannel.close();
      } catch (err) {
        this.log("debug", `Error closing data channel: ${err}`);
      }
      session.dataChannel = null;
    }

    // Stop audio transcoder (kills the per-session ffmpeg subprocess and
    // closes the UDP loopback socket).
    if (session.audioTranscoder) {
      try {
        await session.audioTranscoder.stop();
      } catch (err) {
        this.log("debug", `Error stopping audio transcoder: ${err}`);
      }
      session.audioTranscoder = null;
    }

    // Call cleanup if defined
    if (session.cleanup) {
      session.cleanup();
    }

    // Close peer connection
    try {
      await session.peerConnection.close();
    } catch (err) {
      this.log("debug", `Error closing peer connection: ${err}`);
    }

    this.sessions.delete(sessionId);
    this.emit("session-closed", { sessionId });

    this.log(
      "info",
      `WebRTC session ${sessionId} closed (active sessions: ${this.sessions.size})`,
    );
  }

  /**
   * Get information about all active sessions
   */
  getSessions(): WebRTCSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      state: s.state,
      createdAt: s.createdAt,
      stats: { ...s.stats },
    }));
  }

  /**
   * Get information about a specific session
   */
  getSession(sessionId: string): WebRTCSessionInfo | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      id: session.id,
      state: session.state,
      createdAt: session.createdAt,
      stats: { ...session.stats },
    };
  }

  /**
   * Close all sessions and stop the server
   */
  async stop(): Promise<void> {
    this.log("info", "Stopping WebRTC server");
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map((id) => this.closeSession(id)));
    this.log("info", "WebRTC server stopped");
  }

  /**
   * Get the number of active sessions
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Wait for ICE gathering to complete
   */
  private async waitForIceGathering(pc: any, timeoutMs: number): Promise<void> {
    if (pc.iceGatheringState === "complete") return;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, timeoutMs);

      pc.iceGatheringStateChange.subscribe((state: string) => {
        if (state === "complete") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  /**
   * Start native Baichuan stream and pump frames to WebRTC
   */
  private async startNativeStream(session: WebRTCSession): Promise<void> {
    this.log(
      "info",
      `Starting native stream for session ${session.id} (channel=${this.options.channel}, profile=${this.options.profile})`,
    );

    // Create native stream generator
    // createNativeStream automatically acquires a dedicated socket from the pool.
    session.nativeStream = createNativeStream(
      this.options.api,
      this.options.channel,
      this.options.profile,
      this.options.variant !== undefined
        ? { variant: this.options.variant }
        : undefined,
    );

    // Pump frames to WebRTC
    this.pumpFramesToWebRTC(session).catch((err) => {
      this.log("error", `Frame pump error for session ${session.id}: ${err}`);
      this.closeSession(session.id).catch(() => {});
    });
  }

  /**
   * Pump frames from native stream to WebRTC tracks
   * H.264 → RTP media track (standard WebRTC)
   * H.265 → DataChannel with raw Annex-B frames (decoded by WebCodecs in browser)
   */
  private async pumpFramesToWebRTC(session: WebRTCSession): Promise<void> {
    if (!session.nativeStream) {
      this.log("warn", `No native stream for session ${session.id}`);
      return;
    }

    this.log("info", `Starting frame pump for session ${session.id}`);

    const werift = await this.loadWerift();
    const { RtpPacket, RtpHeader } = werift;

    let sequenceNumber = Math.floor(Math.random() * 65535);
    let timestamp = Math.floor(Math.random() * 0xffffffff);
    const videoClockRate = 90000; // Standard RTP clock rate for video
    let lastTimeMicros = 0;
    let lastLogTime = Date.now();
    let packetsSentSinceLastLog = 0;
    let frameNumber = 0;

    try {
      this.log("info", `Entering frame loop for session ${session.id}`);

      for await (const frame of session.nativeStream) {
        if (session.state === "disconnected" || session.state === "failed") {
          this.log(
            "debug",
            `Session ${session.id} state is ${session.state}, breaking frame loop`,
          );
          break;
        }

        if (frame.audio) {
          // Audio frame from the camera (AAC ADTS or ADPCM). Hand off to the
          // ffmpeg-backed transcoder, which decodes + re-encodes to Opus and
          // returns RTP-ready packets via the `packet` event.
          session.stats.audioFrames++;
          if (session.stats.audioFrames === 1) {
            const head =
              frame.data && frame.data.length > 0
                ? frame.data.subarray(0, Math.min(8, frame.data.length)).toString("hex")
                : "(empty)";
            this.log(
              "info",
              `First audio frame for ${session.id}: codec=${frame.codec ?? "?"} bytes=${frame.data?.length ?? 0} head=${head}`,
            );
          }
          if (
            this.options.ffmpegPath !== "" &&
            frame.data &&
            frame.data.length > 0
          ) {
            // ADPCM is uncommon on the cameras we've tested — start with AAC
            // only; ADPCM support can be added by switching the input format.
            await this.ensureAudioTranscoder(session, werift);
            session.audioTranscoder?.feedAac(frame.data);
          }
        } else {
          // Video frame
          if (frame.data) {
            // Detect codec on first video frame
            if (!session.videoCodec && frame.videoType) {
              const detected = detectVideoCodecFromNal(frame.data);
              session.videoCodec = (detected ?? frame.videoType) as any;
              this.log("info", `Detected video codec: ${session.videoCodec}`);

              // Send codec info to client via data channel
              if (
                session.videoDataChannel &&
                session.videoDataChannel.readyState === "open"
              ) {
                const codecInfo = JSON.stringify({
                  type: "codec",
                  codec: session.videoCodec,
                  width: frame.width || 0,
                  height: frame.height || 0,
                });
                session.videoDataChannel.send(codecInfo);
              }
            }

            // Calculate timestamp
            if (frame.microseconds && lastTimeMicros > 0) {
              const deltaMicros = frame.microseconds - lastTimeMicros;
              const deltaTicks = Math.floor(
                (deltaMicros / 1000000) * videoClockRate,
              );
              timestamp = (timestamp + deltaTicks) >>> 0;
            } else {
              timestamp = (timestamp + 3000) >>> 0; // ~33ms for 30fps
            }
            lastTimeMicros = frame.microseconds || 0;

            if (session.videoCodec === "H264") {
              // H.264 → send via DataChannel (WebCodecs will decode in browser)
              // Check if connection is ready
              const connState = session.peerConnection.connectionState;
              const iceState = session.peerConnection.iceConnectionState;

              // Accept various "connected" states - werift may use different values
              const isConnected =
                connState === "connected" ||
                iceState === "connected" ||
                iceState === "completed";

              if (!isConnected) {
                // Wait for connection, but don't block forever - drop frames until connected
                if (frameNumber < 10) {
                  this.log(
                    "debug",
                    `Waiting for connection, dropping H.264 frame ${frameNumber}`,
                  );
                }
                frameNumber++;
                continue;
              }

              // H.264 → send via RTP media track (standard WebRTC)
              const packetsSent = await this.sendH264Frame(
                session,
                werift,
                frame.data,
                sequenceNumber,
                timestamp,
              );
              sequenceNumber = (sequenceNumber + packetsSent) & 0xffff;
              packetsSentSinceLastLog += packetsSent;
              frameNumber++;
              session.stats.videoFrames++;
              session.stats.bytesSent += frame.data.length;
            } else if (session.videoCodec === "H265") {
              // H.265 → send via DataChannel (WebCodecs will decode in browser)
              const sent = await this.sendVideoFrameViaDataChannel(
                session,
                frame,
                frameNumber,
                "H265",
              );
              if (sent) {
                packetsSentSinceLastLog++;
                frameNumber++;
                session.stats.videoFrames++;
                session.stats.bytesSent += frame.data.length;
              }
            }

            // Log progress every 5 seconds (now includes audio frame counter
            // so we can see whether the camera ever yields audio at all).
            const now = Date.now();
            if (now - lastLogTime >= 5000) {
              this.log(
                "debug",
                `WebRTC session ${session.id} [${session.videoCodec}]: sent ${session.stats.videoFrames} video frames, ${packetsSentSinceLastLog} packets, ${Math.round(session.stats.bytesSent / 1024)} KB | audio frames=${session.stats.audioFrames}`,
              );
              lastLogTime = now;
              packetsSentSinceLastLog = 0;
            }
          }
        }
      }
    } catch (err) {
      this.log(
        "error",
        `Error pumping frames for session ${session.id}: ${err}`,
      );
    }

    this.log("info", `Native stream ended for session ${session.id}`);
  }

  /**
   * Lazily start the AAC → Opus transcoder for `session` and wire it to the
   * audio RTP track. ffmpeg writes RTP-formatted Opus packets back to a UDP
   * loopback the transcoder owns; we strip the RTP header and rewrap the
   * Opus payload with our audioTrack's SSRC so the browser receives a
   * coherent stream.
   */
  private async ensureAudioTranscoder(
    session: WebRTCSession,
    werift: any,
  ): Promise<void> {
    if (session.audioTranscoder !== undefined) return;

    const { RtpPacket, RtpHeader } = werift;
    const ssrc = session.audioTrack?.ssrc ?? Math.floor(Math.random() * 0xffffffff);

    const transcoder = new AacToOpusTranscoder({
      ...(this.options.ffmpegPath ? { ffmpegPath: this.options.ffmpegPath } : {}),
      logger: (level, msg) => this.log(level, msg),
    });

    session.audioRtpSequence = Math.floor(Math.random() * 0xffff);
    session.audioRtpTimestampBase = 0;

    transcoder.on("packet", ({ payload, timestamp, marker }) => {
      try {
        // Anchor the RTP timestamp to the first packet so the value space we
        // send to the browser starts near 0 (avoids negative jitter buffer
        // effects) and stays consistent across reconnects.
        if (
          session.audioRtpTimestampBase === undefined ||
          session.audioRtpTimestampBase === 0
        ) {
          session.audioRtpTimestampBase = timestamp;
        }
        const localTs = (timestamp - session.audioRtpTimestampBase) >>> 0;
        const seq = session.audioRtpSequence!;
        session.audioRtpSequence = (seq + 1) & 0xffff;

        const header = new RtpHeader({
          version: 2,
          padding: false,
          extension: false,
          marker,
          // Werift assigns 111 to Opus by default in the receiver SDP, but it
          // also accepts other PTs. Use 111 for compatibility with the offer
          // we generated earlier.
          payloadType: 111,
          sequenceNumber: seq,
          timestamp: localTs,
          ssrc,
        });
        const rtp = new RtpPacket(header, payload);
        session.audioTrack?.writeRtp(rtp);
        if (!session.audioStartedLogged) {
          session.audioStartedLogged = true;
          this.log(
            "info",
            `Audio RTP started for ${session.id} (PT=111, ssrc=${ssrc})`,
          );
        }
      } catch (err) {
        this.log(
          "warn",
          `audio writeRtp failed for ${session.id}: ${(err as Error).message}`,
        );
      }
    });

    transcoder.on("error", (err) => {
      this.log("error", `audio transcoder error for ${session.id}: ${err.message}`);
    });
    transcoder.on("exit", (code) => {
      this.log("info", `audio transcoder exited (${code}) for ${session.id}`);
    });

    try {
      await transcoder.start();
      session.audioTranscoder = transcoder;
    } catch (err) {
      this.log(
        "error",
        `failed to start audio transcoder for ${session.id}: ${(err as Error).message}`,
      );
      session.audioTranscoder = null;
    }
  }

  /**
   * Send H.264 frame via RTP media track
   * Returns the number of RTP packets sent
   */
  private async sendH264Frame(
    session: WebRTCSession,
    werift: any,
    frameData: Buffer,
    sequenceNumber: number,
    timestamp: number,
  ): Promise<number> {
    // Frame data may be length-prefixed; normalize to Annex-B.
    const annexB = convertH264ToAnnexB(frameData);
    const nalUnits = splitH264AnnexBToNalPayloads(annexB);

    // Categorize NAL units
    let hasSps = false;
    let hasPps = false;
    let hasIdr = false;
    const nalTypes: number[] = [];

    for (const nal of nalUnits) {
      const t = (nal[0] ?? 0) & 0x1f;
      nalTypes.push(t);
      if (t === 7) {
        hasSps = true;
        session.lastH264Sps = nal;
      }
      if (t === 8) {
        hasPps = true;
        session.lastH264Pps = nal;
      }
      if (t === 5) hasIdr = true;
    }

    // Log NAL types for first few frames to debug
    if (session.stats.videoFrames < 10) {
      this.log(
        "debug",
        `H.264 frame NAL types: [${nalTypes.join(",")}] (5=IDR, 7=SPS, 8=PPS, 1=P-slice)`,
      );
    }

    // A keyframe is an IDR frame (type 5). SPS/PPS may come separately.
    const isKeyframe = hasIdr;
    let nalList = nalUnits;

    // If this is an IDR but missing SPS/PPS, prepend cached ones
    if (hasIdr && (!hasSps || !hasPps)) {
      const prepend: Buffer[] = [];
      if (!hasSps && session.lastH264Sps) {
        prepend.push(session.lastH264Sps);
        this.log("debug", `Prepending cached SPS to IDR frame`);
      }
      if (!hasPps && session.lastH264Pps) {
        prepend.push(session.lastH264Pps);
        this.log("debug", `Prepending cached PPS to IDR frame`);
      }
      if (prepend.length > 0) {
        nalList = [...prepend, ...nalUnits];
      } else if (!session.lastH264Sps || !session.lastH264Pps) {
        // IDR without SPS/PPS and no cache - decoder can't use this
        this.log(
          "warn",
          `IDR frame without SPS/PPS and no cached parameters - frame may not decode`,
        );
      }
    }

    // Wait for first keyframe before sending any frames
    if (!session.hasReceivedKeyframe) {
      if (hasIdr && session.lastH264Sps && session.lastH264Pps) {
        session.hasReceivedKeyframe = true;
        this.log(
          "info",
          `First H.264 keyframe received with SPS/PPS - starting video stream`,
        );
        // Continue to send this keyframe below
      } else if (hasIdr) {
        this.log(
          "debug",
          `IDR received but waiting for SPS/PPS before starting stream`,
        );
        return 0;
      } else {
        // P-frame before first keyframe - drop it
        if (session.stats.videoFrames < 5) {
          this.log(
            "debug",
            `Dropping P-frame ${session.stats.videoFrames} while waiting for keyframe`,
          );
        }
        return 0;
      }
    }

    let totalPacketsSent = 0;
    let currentSeqNum = sequenceNumber;

    // Get SSRC from video track
    const ssrc = session.videoTrack.ssrc || 0;

    for (let i = 0; i < nalList.length; i++) {
      const nalUnit = nalList[i]!;
      if (nalUnit.length === 0) continue;

      const isLastNalu = i === nalList.length - 1;
      const nalType = getH264NalType(nalUnit);

      // Skip AUD (Access Unit Delimiter) NAL units
      if (nalType === 9) continue;

      // Create and send RTP packets
      const rtpPackets = this.createH264RtpPackets(
        werift,
        nalUnit,
        currentSeqNum,
        timestamp,
        isLastNalu,
        ssrc,
      );

      // Log NAL processing for first few frames
      if (session.stats.videoFrames < 3) {
        this.log(
          "info",
          `NAL ${i}: type=${nalType}, size=${nalUnit.length}, rtpPackets=${rtpPackets.length}`,
        );
      }

      for (const rtpPacket of rtpPackets) {
        try {
          session.videoTrack.writeRtp(rtpPacket);
          currentSeqNum = (currentSeqNum + 1) & 0xffff;
          totalPacketsSent++;
        } catch (err) {
          this.log(
            "error",
            `Error writing RTP packet for session ${session.id}: ${err}`,
          );
          // Continue trying to send more packets
        }
      }
    }

    // Log first few frames for debugging
    if (session.stats.videoFrames < 3) {
      this.log(
        "info",
        `H.264 frame sent: nalCount=${nalList.length} packets=${totalPacketsSent} seq=${sequenceNumber}->${currentSeqNum} ts=${timestamp} keyframe=${isKeyframe}`,
      );
    }

    return totalPacketsSent;
  }

  /**
   * Send video frame via DataChannel (works for both H.264 and H.265)
   * Format: 12-byte header + Annex-B data
   * Header: [frameNum (4)] [timestamp (4)] [flags (1)] [keyframe (1)] [reserved (2)]
   * Flags: 0x01 = H.265, 0x02 = H.264
   */
  private async sendVideoFrameViaDataChannel(
    session: WebRTCSession,
    frame: any,
    frameNumber: number,
    codec: "H264" | "H265",
  ): Promise<boolean> {
    if (!session.videoDataChannel) {
      if (frameNumber === 0) {
        this.log("warn", `No video data channel for session ${session.id}`);
      }
      return false;
    }

    if (session.videoDataChannel.readyState !== "open") {
      if (frameNumber === 0) {
        this.log(
          "warn",
          `Video data channel not open for session ${session.id}: ${session.videoDataChannel.readyState}`,
        );
      }
      return false;
    }

    // Parse NAL units to detect keyframe and cache SPS/PPS
    const nalUnits = parseAnnexBNalUnits(frame.data);
    let isKeyframe = frame.isKeyframe === true;
    let hasIdr = false;
    let hasSps = false;
    let hasPps = false;
    let hasVps = false;
    const nalTypes: number[] = [];

    for (const nalUnit of nalUnits) {
      if (nalUnit.length === 0) continue;

      if (codec === "H265") {
        const nalType = getH265NalType(nalUnit);
        nalTypes.push(nalType);
        // VPS=32, SPS=33, PPS=34, IDR_W_RADL=19, IDR_N_LP=20
        if (nalType === 32) {
          hasVps = true;
          session.lastH265Vps = nalUnit;
        }
        if (nalType === 33) {
          hasSps = true;
          session.lastH265Sps = nalUnit;
        }
        if (nalType === 34) {
          hasPps = true;
          session.lastH265Pps = nalUnit;
        }
        if (nalType === 19 || nalType === 20) {
          hasIdr = true;
          isKeyframe = true;
        }
      } else {
        // H.264
        const nalType = getH264NalType(nalUnit);
        nalTypes.push(nalType);
        // SPS=7, PPS=8, IDR=5
        if (nalType === 7) {
          hasSps = true;
          session.lastH264Sps = nalUnit;
        }
        if (nalType === 8) {
          hasPps = true;
          session.lastH264Pps = nalUnit;
        }
        if (nalType === 5) {
          hasIdr = true;
          isKeyframe = true;
        }
      }
    }

    // Log NAL types for first few frames
    if (frameNumber < 5) {
      this.log(
        "debug",
        `${codec} frame ${frameNumber} NAL types: [${nalTypes.join(",")}] hasIdr=${hasIdr} hasSps=${hasSps} hasPps=${hasPps}`,
      );
    }

    // Wait for first keyframe before sending any frames
    if (!session.hasReceivedKeyframe) {
      if (codec === "H264") {
        // For H.264, we need SPS+PPS+IDR
        if (hasIdr && session.lastH264Sps && session.lastH264Pps) {
          session.hasReceivedKeyframe = true;
          this.log(
            "info",
            `First H.264 keyframe received with SPS/PPS - starting video stream`,
          );
        } else if (hasSps || hasPps) {
          // Got parameter sets, wait for IDR
          this.log("debug", `Received H.264 parameter sets, waiting for IDR`);
          return false;
        } else if (hasIdr) {
          // IDR without SPS/PPS - can't use yet
          this.log("debug", `IDR received but waiting for SPS/PPS`);
          return false;
        } else {
          // P-frame - drop it
          if (frameNumber < 10) {
            this.log(
              "debug",
              `Dropping H.264 P-frame ${frameNumber} while waiting for keyframe`,
            );
          }
          return false;
        }
      } else {
        // For H.265, we need VPS+SPS+PPS+IDR
        if (
          hasIdr &&
          session.lastH265Vps &&
          session.lastH265Sps &&
          session.lastH265Pps
        ) {
          session.hasReceivedKeyframe = true;
          this.log(
            "info",
            `First H.265 keyframe received with VPS/SPS/PPS - starting video stream`,
          );
        } else if (hasVps || hasSps || hasPps) {
          this.log("debug", `Received H.265 parameter sets, waiting for IDR`);
          return false;
        } else if (hasIdr) {
          this.log("debug", `H.265 IDR received but waiting for VPS/SPS/PPS`);
          return false;
        } else {
          if (frameNumber < 10) {
            this.log(
              "debug",
              `Dropping H.265 P-frame ${frameNumber} while waiting for keyframe`,
            );
          }
          return false;
        }
      }
    }

    // Build the frame data, prepending cached parameter sets if needed for IDR
    let frameData = frame.data;

    if (hasIdr) {
      if (codec === "H264" && (!hasSps || !hasPps)) {
        // Prepend cached SPS/PPS to IDR
        const parts: Buffer[] = [];
        if (!hasSps && session.lastH264Sps) {
          parts.push(Buffer.from([0x00, 0x00, 0x00, 0x01]));
          parts.push(session.lastH264Sps);
        }
        if (!hasPps && session.lastH264Pps) {
          parts.push(Buffer.from([0x00, 0x00, 0x00, 0x01]));
          parts.push(session.lastH264Pps);
        }
        if (parts.length > 0) {
          frameData = Buffer.concat([...parts, frame.data]);
          this.log("debug", `Prepended cached SPS/PPS to H.264 IDR frame`);
        }
      } else if (codec === "H265" && (!hasVps || !hasSps || !hasPps)) {
        // Prepend cached VPS/SPS/PPS to IDR
        const parts: Buffer[] = [];
        if (!hasVps && session.lastH265Vps) {
          parts.push(Buffer.from([0x00, 0x00, 0x00, 0x01]));
          parts.push(session.lastH265Vps);
        }
        if (!hasSps && session.lastH265Sps) {
          parts.push(Buffer.from([0x00, 0x00, 0x00, 0x01]));
          parts.push(session.lastH265Sps);
        }
        if (!hasPps && session.lastH265Pps) {
          parts.push(Buffer.from([0x00, 0x00, 0x00, 0x01]));
          parts.push(session.lastH265Pps);
        }
        if (parts.length > 0) {
          frameData = Buffer.concat([...parts, frame.data]);
          this.log("debug", `Prepended cached VPS/SPS/PPS to H.265 IDR frame`);
        }
      }
    }

    // Create header (12 bytes)
    const header = Buffer.alloc(12);
    header.writeUInt32BE(frameNumber, 0); // Frame number
    header.writeUInt32BE(frame.microseconds ? frame.microseconds / 1000 : 0, 4); // Timestamp in ms
    header.writeUInt8(codec === "H265" ? 0x01 : 0x02, 8); // Flags: 0x01 = H.265, 0x02 = H.264
    header.writeUInt8(isKeyframe ? 1 : 0, 9); // Keyframe flag
    header.writeUInt16BE(0, 10); // Reserved

    // Combine header + raw Annex-B data
    const packet = Buffer.concat([header, frameData]);

    // Log first few frames
    if (frameNumber < 3) {
      this.log(
        "info",
        `Sending ${codec} frame ${frameNumber}: ${packet.length} bytes, keyframe=${isKeyframe}`,
      );
    }

    // Send via DataChannel as a sequence of chunks. Every binary message
    // carries a uniform 4-byte chunk header so the client can reassemble
    // without ambiguity:
    //   [0..1] chunk index      (u16 BE)
    //   [2..3] total chunks     (u16 BE)
    //
    // Single-chunk frames are sent as `[0, 1]` so the wire format is consistent
    // — important for H.265 where a 4K IDR frame can run 400KB and is always
    // chunked, while inter-frames may fit in one message. Without a uniform
    // header the client would have no way to tell which is which.
    const CHUNK_HEADER_LEN = 4;
    const MAX_PAYLOAD_PER_CHUNK = 16000 - CHUNK_HEADER_LEN;

    try {
      const totalChunks = Math.max(
        1,
        Math.ceil(packet.length / MAX_PAYLOAD_PER_CHUNK),
      );
      for (let i = 0; i < totalChunks; i++) {
        const start = i * MAX_PAYLOAD_PER_CHUNK;
        const end = Math.min(start + MAX_PAYLOAD_PER_CHUNK, packet.length);
        const chunk = packet.subarray(start, end);
        const chunkHeader = Buffer.alloc(CHUNK_HEADER_LEN);
        chunkHeader.writeUInt16BE(i, 0);
        chunkHeader.writeUInt16BE(totalChunks, 2);
        session.videoDataChannel.send(Buffer.concat([chunkHeader, chunk]));
      }
      return true;
    } catch (err) {
      this.log("error", `Error sending ${codec} frame ${frameNumber}: ${err}`);
      return false;
    }
  }

  /**
   * Send H.265 frame via DataChannel
   * Format: 12-byte header + Annex-B data
   * Header: [frameNum (4)] [timestamp (4)] [flags (1)] [keyframe (1)] [reserved (2)]
   */
  private async sendH265Frame(
    session: WebRTCSession,
    frame: any,
    frameNumber: number,
  ): Promise<void> {
    if (!session.videoDataChannel) {
      if (frameNumber === 0) {
        this.log("warn", `No video data channel for session ${session.id}`);
      }
      return;
    }

    if (session.videoDataChannel.readyState !== "open") {
      if (frameNumber === 0) {
        this.log(
          "warn",
          `Video data channel not open for session ${session.id}: ${session.videoDataChannel.readyState}`,
        );
      }
      return;
    }

    // Use isKeyframe from the frame if available, otherwise detect from NAL units
    let isKeyframe = frame.isKeyframe === true;

    // Double-check by scanning NAL units if frame.isKeyframe is not set
    if (!isKeyframe && frame.isKeyframe === undefined) {
      const nalUnits = parseAnnexBNalUnits(frame.data);
      for (const nalUnit of nalUnits) {
        if (nalUnit.length === 0) continue;
        const nalType = getH265NalType(nalUnit);
        // VPS=32, SPS=33, PPS=34, IDR_W_RADL=19, IDR_N_LP=20
        if (
          nalType === 32 ||
          nalType === 33 ||
          nalType === 34 ||
          nalType === 19 ||
          nalType === 20
        ) {
          isKeyframe = true;
          break;
        }
      }
    }

    // Create header (12 bytes)
    const header = Buffer.alloc(12);
    header.writeUInt32BE(frameNumber, 0); // Frame number
    header.writeUInt32BE(frame.microseconds ? frame.microseconds / 1000 : 0, 4); // Timestamp in ms
    header.writeUInt8(0x01, 8); // Flags: 0x01 = H.265
    header.writeUInt8(isKeyframe ? 1 : 0, 9); // Keyframe flag
    header.writeUInt16BE(0, 10); // Reserved

    // Combine header + raw Annex-B data
    const packet = Buffer.concat([header, frame.data]);

    // Log first few frames
    if (frameNumber < 3) {
      this.log(
        "info",
        `Sending H.265 frame ${frameNumber}: ${packet.length} bytes, keyframe=${isKeyframe}`,
      );
    }

    // Send via DataChannel (may need to chunk for large frames)
    const MAX_CHUNK_SIZE = 16000; // Safe size for DataChannel

    try {
      if (packet.length <= MAX_CHUNK_SIZE) {
        session.videoDataChannel.send(packet);
      } else {
        // Chunk large frames
        const totalChunks = Math.ceil(packet.length / MAX_CHUNK_SIZE);
        for (let i = 0; i < totalChunks; i++) {
          const start = i * MAX_CHUNK_SIZE;
          const end = Math.min(start + MAX_CHUNK_SIZE, packet.length);
          const chunk = packet.subarray(start, end);

          // Prepend chunk header: [chunk index (1)] [total chunks (1)] [data...]
          const chunkHeader = Buffer.alloc(2);
          chunkHeader.writeUInt8(i, 0);
          chunkHeader.writeUInt8(totalChunks, 1);

          session.videoDataChannel.send(Buffer.concat([chunkHeader, chunk]));
        }
      }
    } catch (err) {
      this.log("error", `Error sending H.265 frame ${frameNumber}: ${err}`);
    }
  }

  /**
   * Create RTP packets for H.264 NAL unit
   * Handles single NAL, STAP-A aggregation, and FU-A fragmentation
   */
  private createH264RtpPackets(
    werift: any,
    nalUnit: Buffer,
    sequenceNumber: number,
    timestamp: number,
    marker: boolean,
    ssrc: number,
  ): any[] {
    const { RtpPacket, RtpHeader } = werift;
    const MTU = 1200; // Safe MTU for RTP payload

    const packets: any[] = [];

    if (nalUnit.length <= MTU) {
      // Single NAL unit - send as-is
      const header = new RtpHeader();
      header.payloadType = 96; // Dynamic payload type for H.264
      header.sequenceNumber = sequenceNumber;
      header.timestamp = timestamp;
      header.marker = marker;
      header.ssrc = ssrc;

      packets.push(new RtpPacket(header, nalUnit));
    } else {
      // FU-A fragmentation for large NAL units
      const nalHeader = nalUnit[0]!;
      const nalType = nalHeader & 0x1f;
      const nri = nalHeader & 0x60;

      // FU indicator: same NRI, type = 28 (FU-A)
      const fuIndicator = (nri | 28) & 0xff;

      let offset = 1; // Skip NAL header
      let isFirst = true;

      while (offset < nalUnit.length) {
        const remaining = nalUnit.length - offset;
        const chunkSize = Math.min(remaining, MTU - 2); // -2 for FU indicator + FU header
        const isLast = offset + chunkSize >= nalUnit.length;

        // FU header: S bit (start), E bit (end), R bit (reserved), Type
        let fuHeader = nalType;
        if (isFirst) fuHeader |= 0x80; // S bit
        if (isLast) fuHeader |= 0x40; // E bit

        // Create FU-A payload
        const fuPayload = Buffer.alloc(2 + chunkSize);
        fuPayload[0] = fuIndicator;
        fuPayload[1] = fuHeader;
        nalUnit.copy(fuPayload, 2, offset, offset + chunkSize);

        const header = new RtpHeader();
        header.payloadType = 96;
        header.sequenceNumber = (sequenceNumber + packets.length) & 0xffff;
        header.timestamp = timestamp;
        header.marker = isLast && marker;
        header.ssrc = ssrc;

        packets.push(new RtpPacket(header, fuPayload));

        offset += chunkSize;
        isFirst = false;
      }
    }

    return packets;
  }

  /**
   * Start intercom (two-way audio)
   */
  private async startIntercom(session: WebRTCSession): Promise<void> {
    try {
      session.intercom = new Intercom({
        api: this.options.api,
        channel: this.options.channel,
      });

      await session.intercom.start();
      this.log("info", `Intercom started for session ${session.id}`);
    } catch (err) {
      this.log(
        "error",
        `Failed to start intercom for session ${session.id}: ${err}`,
      );
      // Don't fail the whole session, just disable intercom
      session.intercom = null;
    }
  }

  /**
   * Log helper
   */
  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ): void {
    if (this.options.logger) {
      this.options.logger(level, message);
    }
  }
}
