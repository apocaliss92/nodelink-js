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
  private async loadWerift(): Promise<any> {
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
    const videoTrack = new MediaStreamTrack({ kind: "video" });
    peerConnection.addTrack(videoTrack);
    session.videoTrack = videoTrack;

    // Add audio track (Opus for WebRTC)
    const audioTrack = new MediaStreamTrack({ kind: "audio" });
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
      this.log("debug", `ICE connection state for ${sessionId}: ${state}`);
      if (state === "connected") {
        session.state = "connected";
        this.emit("session-connected", { sessionId });
      } else if (state === "disconnected" || state === "failed") {
        session.state = state as any;
        this.closeSession(sessionId).catch((err) => {
          this.log("error", `Error closing session on ICE ${state}: ${err}`);
        });
      }
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
      new RTCIceCandidate(candidate.candidate, candidate.sdpMid ?? "0"),
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
          // Audio frame - would need transcoding to Opus for WebRTC
          // For now, track stats only
          // TODO: Implement AAC/ADPCM to Opus transcoding
          session.stats.audioFrames++;
        } else {
          // Video frame
          if (frame.data) {
            // Detect codec on first video frame
            if (!session.videoCodec && frame.videoType) {
              session.videoCodec = frame.videoType;
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
              // H.264 → send via RTP media track
              await this.sendH264Frame(
                session,
                werift,
                frame.data,
                sequenceNumber,
                timestamp,
              );
              sequenceNumber =
                (sequenceNumber + Math.ceil(frame.data.length / 1200)) & 0xffff;
              packetsSentSinceLastLog++;
            } else if (session.videoCodec === "H265") {
              // H.265 → send via DataChannel (WebCodecs will decode in browser)
              await this.sendH265Frame(session, frame, frameNumber);
              packetsSentSinceLastLog++;
            }

            frameNumber++;
            session.stats.videoFrames++;
            session.stats.bytesSent += frame.data.length;

            // Log progress every 5 seconds
            const now = Date.now();
            if (now - lastLogTime >= 5000) {
              this.log(
                "debug",
                `WebRTC session ${session.id} [${session.videoCodec}]: sent ${session.stats.videoFrames} frames, ${packetsSentSinceLastLog} packets, ${Math.round(session.stats.bytesSent / 1024)} KB`,
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
   * Send H.264 frame via RTP media track
   */
  private async sendH264Frame(
    session: WebRTCSession,
    werift: any,
    frameData: Buffer,
    sequenceNumber: number,
    timestamp: number,
  ): Promise<void> {
    const nalUnits = parseAnnexBNalUnits(frameData);

    for (let i = 0; i < nalUnits.length; i++) {
      const nalUnit = nalUnits[i]!;
      if (nalUnit.length === 0) continue;

      const isLastNalu = i === nalUnits.length - 1;
      const nalType = getH264NalType(nalUnit);

      // Skip AUD (Access Unit Delimiter) NAL units
      if (nalType === 9) continue;

      // Create and send RTP packets
      const rtpPackets = this.createH264RtpPackets(
        werift,
        nalUnit,
        sequenceNumber,
        timestamp,
        isLastNalu,
      );

      for (const rtpPacket of rtpPackets) {
        session.videoTrack.writeRtp(rtpPacket);
        sequenceNumber = (sequenceNumber + 1) & 0xffff;
      }
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
