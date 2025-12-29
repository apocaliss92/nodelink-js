/**
 * Baichuan RTSP Server - Builds an RTSP server that serves a Baichuan video stream.
 * 
 * Structure:
 * - RTSP server uses ffmpeg -rtsp_flags listen to create RTSP server from stdin
 * - Native stream starts only when at least one client is connected
 * - Native stream stops when no clients are connected
 * - Tracks connected clients
 * - Passes native frames directly to ffmpeg without repacketization
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import * as net from "node:net";
import * as dgram from "node:dgram";
import type { StreamProfile } from "../../reolink/baichuan/types";
import type { ReolinkBaichuanApi } from "../../reolink/baichuan/ReolinkBaichuanApi";
import { createNativeStream } from "../../scrypted/helpers";
import { createRtspFlow, type RtspFlow, type RtspVideoType } from "./rtspFlow";
import { isH264KeyframeAnnexB } from "./H264Converter";
import { isH265Irap, splitAnnexBToNalPayloads } from "./H265Converter";

function envBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return defaultValue;
}

export interface BaichuanRtspServerOptions {
  /** API instance (required) */
  api: ReolinkBaichuanApi;
  /** Channel number (required) */
  channel: number;
  /** Stream profile (required) */
  profile: StreamProfile;
  listenHost?: string; // Host to listen on (default: "127.0.0.1")
  listenPort?: number; // Port to listen on (default: 8554)
  path?: string; // RTSP path (e.g. "/main" or "/sub")
}

/**
 * BaichuanRtspServer - RTSP server that serves a Baichuan video stream.
 *
 * Uses ffmpeg as RTSP server that reads from stdin, passing native frames directly.
 * This approach is simpler and more reliable than manual RTP repacketization.
 *
 * Lifecycle:
 * - Server starts immediately (ffmpeg RTSP server)
 * - Native stream starts only when first client connects
 * - Native stream stops when last client disconnects
 */
export class BaichuanRtspServer extends EventEmitter<{
  client: [string]; // Client connesso
  clientDisconnected: [string]; // Client disconnesso
  error: [Error];
  close: [];
}> {
  private api: ReolinkBaichuanApi;
  private channel: number;
  private profile: StreamProfile;
  private listenHost: string;
  private listenPort: number;
  private path: string;
  private active = false;
  private flow: RtspFlow;
  
  // Client tracking
  private connectedClients = new Set<string>(); // Set of client IDs (IP:port)
  private nativeStreamActive = false; // Whether the native stream is currently active
  private clientConnectionServer: net.Server | undefined; // TCP server to track connections
  private streamMetadata: { frameRate: number; width: number; height: number } | null = null;
  // Track all client resources for cleanup
  private clientResources = new Map<string, {
    ffmpeg: ReturnType<typeof spawn> | undefined;
    udpSocket: dgram.Socket | null;
    udpSocketAudio: dgram.Socket | null;
    rtspSocket: net.Socket | null;
    pipelineStarted?: boolean;
    seenFirstVideoKeyframe?: boolean;
    h265WaitStartMs?: number;
    setupTrack0: boolean;
    setupTrack1: boolean;
    isPlaying: boolean;
    track0RtpChannel?: number;
    track0RtcpChannel?: number;
    track1RtpChannel?: number;
    track1RtcpChannel?: number;
    rtpVideoSeq?: number;
    rtpVideoTimestamp?: number;
    rtpVideoBaseMicroseconds?: number;
    rtpVideoBaseTimestamp?: number;
    rtpVideoLastTimestamp?: number;
    rtpVideoSsrc?: number;
    rtpAudioSeq?: number;
    rtpAudioTimestamp?: number;
    rtpAudioSsrc?: number;
    rtpSentVideoConfig?: boolean;
  }>();

  private isRtspDebugEnabled(): boolean {
    const dbg = this.api.client.getDebugConfig();
    return dbg.debugRtsp || envBool(process.env.BAICHUAN_DEBUG_RTSP, false);
  }

  private rtspDebugLog(message: string): void {
    if (!this.isRtspDebugEnabled()) return;
    console.log(`[BaichuanRtspServer] ${message}`);
  }
  // Track when first frame arrives from camera
  private firstFramePromise: Promise<void> | null = null;
  private firstFrameResolve: (() => void) | null = null;
  private firstFrameReceived = false;
  private firstAudioPromise: Promise<void> | null = null;
  private firstAudioResolve: (() => void) | null = null;
  private firstAudioDetected = false;
  // Audio support (TCP only): AAC with ADTS framing, packetized to RTP (mpeg4-generic).
  private hasAudio = false;
  private audioInfo:
    | { codec: "aac-adts"; sampleRate: number; channels: number; configHex: string }
    | null = null;
  private audioPrimingFrame: Buffer | null = null;
  // Temporary stream for extracting parameter sets during DESCRIBE
  private tempStreamGenerator: AsyncGenerator<{
    audio: boolean;
    data: Buffer;
    codec: string | null;
    sampleRate: number | null;
    microseconds: number | null;
    videoType?: "H264" | "H265";
  }, void, unknown> | null = null;

  private static isAdtsAacFrame(b: Buffer): boolean {
    // ADTS syncword: 0xFFF (12 bits)
    return b.length >= 2 && b[0] === 0xff && (b[1]! & 0xf0) === 0xf0;
  }

  private static parseAdtsSamplingInfo(b: Buffer): { sampleRate: number; channels: number; configHex: string } | null {
    // Minimal ADTS header parsing to extract sample rate index + channel config.
    // Reference layout:
    // - sampling_frequency_index: bits 2..5 of byte2 (b[2])
    // - channel_configuration: 1 bit in b[2] (LSB) + 2 bits in b[3] (MSBs)
    if (b.length < 7) return null;
    if (!BaichuanRtspServer.isAdtsAacFrame(b)) return null;

    const samplingIndex = (b[2]! >> 2) & 0x0f;
    const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const sampleRate = sampleRates[samplingIndex] ?? null;
    if (!sampleRate) return null;

    const channelConfig = ((b[2]! & 0x01) << 2) | ((b[3]! >> 6) & 0x03);
    const channels = channelConfig === 0 ? 1 : channelConfig;

    // ADTS profile (2 bits): 0=Main, 1=LC, 2=SSR. AudioSpecificConfig uses audioObjectType = profile + 1.
    const profile = (b[2]! >> 6) & 0x03;
    const audioObjectType = profile + 1;
    // AudioSpecificConfig (AAC): 5 bits AOT, 4 bits sampling idx, 4 bits channel config.
    const asc = (audioObjectType << 11) | (samplingIndex << 7) | (channelConfig << 3);
    const configHex = Buffer.from([(asc >> 8) & 0xff, asc & 0xff]).toString("hex");
    return { sampleRate, channels, configHex };
  }

  private static parseInterleavedChannels(transportHeader: string): { rtp: number; rtcp: number } | null {
    const m = transportHeader.match(/interleaved\s*=\s*(\d+)\s*-\s*(\d+)/i);
    if (!m) return null;
    const rtp = Number.parseInt(m[1]!, 10);
    const rtcp = Number.parseInt(m[2]!, 10);
    if (!Number.isFinite(rtp) || !Number.isFinite(rtcp)) return null;
    return { rtp, rtcp };
  }

  private static splitAnnexBNals(data: Buffer): Buffer[] {
    // Returns NAL units WITHOUT start codes.
    const nals: Buffer[] = [];
    const len = data.length;
    const isStartCodeAt = (i: number): number => {
      // returns start code length (3 or 4) or 0
      if (i + 3 <= len && data[i] === 0x00 && data[i + 1] === 0x00) {
        if (data[i + 2] === 0x01) return 3;
        if (i + 4 <= len && data[i + 2] === 0x00 && data[i + 3] === 0x01) return 4;
      }
      return 0;
    };

    let i = 0;
    // find first start code
    while (i < len) {
      const sc = isStartCodeAt(i);
      if (sc) break;
      i++;
    }
    while (i < len) {
      const sc = isStartCodeAt(i);
      if (!sc) {
        i++;
        continue;
      }
      const nalStart = i + sc;
      let j = nalStart;
      while (j < len) {
        const sc2 = isStartCodeAt(j);
        if (sc2) break;
        j++;
      }
      if (nalStart < j) {
        const nal = data.subarray(nalStart, j);
        // skip empty/zero-length nals
        if (nal.length > 0) nals.push(nal);
      }
      i = j;
    }
    return nals;
  }

  private static stripAdtsHeader(adtsFrame: Buffer): Buffer | null {
    if (!BaichuanRtspServer.isAdtsAacFrame(adtsFrame)) return null;
    if (adtsFrame.length < 7) return null;
    const protectionAbsent = (adtsFrame[1]! & 0x01) === 0x01;
    const headerLen = protectionAbsent ? 7 : 9;
    if (adtsFrame.length <= headerLen) return null;
    return adtsFrame.subarray(headerLen);
  }

  constructor(options: BaichuanRtspServerOptions) {
    super();
    this.api = options.api;
    this.channel = options.channel;
    this.profile = options.profile;
    this.listenHost = options.listenHost ?? "127.0.0.1";
    this.listenPort = options.listenPort ?? 8554;
    this.path = options.path ?? `/stream/${this.profile}`;

    // Default flow is conservative (tcp+h264); it will be refined from metadata or first frames.
    const transport = this.api.client.getTransport();
    this.flow = createRtspFlow(transport, "H264");
  }

  private setFlowVideoType(videoType: RtspVideoType, reason: string): void {
    if (this.flow.videoType === videoType) return;
    const transport = this.api.client.getTransport();
    this.flow.stopKeepAlive();
    this.flow = createRtspFlow(transport, videoType);
    this.rtspDebugLog(`Using RTSP flow ${this.flow.key} (${reason})`);
  }

  /**
   * Start the RTSP server.
   */
  async start(): Promise<void> {
    if (this.active) {
      throw new Error("RTSP server is already active");
    }

    // Get stream metadata
    try {
      const metadata = await this.api.getStreamMetadata(this.channel);
      const stream = metadata.streams.find((s) => s.profile === this.profile);
      if (stream) {
        this.streamMetadata = {
          frameRate: stream.frameRate || 25,
          width: stream.width,
          height: stream.height,
        };
        // Detect video type from metadata (refines flow early, before first frame).
        const metaVideoType: RtspVideoType =
          stream.videoEncType === "H.265" || stream.videoEncType === "HEVC" ? "H265" : "H264";
        this.setFlowVideoType(metaVideoType, "metadata");
      }
    } catch (error) {
      console.warn(`[BaichuanRtspServer] Could not get stream metadata: ${error}`);
      this.streamMetadata = { frameRate: 25, width: 1920, height: 1080 };
      this.setFlowVideoType("H264", "metadata unavailable");
    }

    // Start TCP server to handle RTSP connections
    this.clientConnectionServer = net.createServer((socket) => {
      this.handleRtspConnection(socket);
    });

    // Start listening
    await new Promise<void>((resolve, reject) => {
      this.clientConnectionServer!.listen(this.listenPort, this.listenHost, () => {
        resolve();
      });
      this.clientConnectionServer!.on("error", (error) => {
        reject(error);
      });
    });

    this.active = true;
    console.log(`[BaichuanRtspServer] RTSP server started on ${this.listenHost}:${this.listenPort}, path: ${this.path}`);
  }

  /**
   * Handle RTSP connection from a client.
   */
  private handleRtspConnection(socket: net.Socket): void {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[BaichuanRtspServer] RTSP client connected: ${clientId}`);
    
    let sessionId = "";
    let buffer = Buffer.alloc(0);
    let clientFfmpeg: ReturnType<typeof spawn> | undefined;
    let useTcpInterleaved = false;
    let clientUdpSocket: dgram.Socket | null = null;
    let clientUdpSocketAudio: dgram.Socket | null = null;

    const cleanup = () => {
      this.removeClient(clientId);
      
      // Remove from tracking
      const resources = this.clientResources.get(clientId);
      if (resources) {
        // Kill ffmpeg process
        if (resources.ffmpeg) {
          try {
            resources.ffmpeg.stdin?.end();
            resources.ffmpeg.kill("SIGTERM");
            setTimeout(() => {
              try {
                resources.ffmpeg?.kill("SIGKILL");
              } catch {}
            }, 1000);
          } catch {}
        }
        
        // Close UDP sockets
        if (resources.udpSocket) {
          try {
            resources.udpSocket.close();
          } catch {}
        }
        if ((resources as any).udpSocketAudio) {
          try {
            ((resources as any).udpSocketAudio as dgram.Socket).close();
          } catch {}
        }
        
        // Close RTSP socket if still open
        if (resources.rtspSocket && !resources.rtspSocket.destroyed) {
          try {
            resources.rtspSocket.destroy();
          } catch {}
        }
        
        this.clientResources.delete(clientId);
      }
      
      // Also cleanup local variables
      if (clientFfmpeg) {
        try {
          clientFfmpeg.stdin?.end();
          clientFfmpeg.kill("SIGTERM");
          setTimeout(() => {
            try {
              clientFfmpeg?.kill("SIGKILL");
            } catch {}
          }, 1000);
        } catch {}
        clientFfmpeg = undefined;
      }
      
      if (clientUdpSocket) {
        try {
          clientUdpSocket.close();
        } catch {}
        clientUdpSocket = null;
      }

      if (clientUdpSocketAudio) {
        try {
          clientUdpSocketAudio.close();
        } catch {}
        clientUdpSocketAudio = null;
      }
    };

    socket.on("close", cleanup);
    socket.on("error", (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code !== 'EPIPE') {
        console.error(`[BaichuanRtspServer] RTSP client error:`, error);
      }
      cleanup();
    });

    socket.on("data", async (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      
      while (buffer.includes("\r\n\r\n")) {
        const endIndex = buffer.indexOf("\r\n\r\n");
        const requestText = buffer.subarray(0, endIndex).toString();
        buffer = buffer.subarray(endIndex + 4);
        
        if (!requestText.trim()) continue;
        
        const lines = requestText.split("\r\n");
        const requestLine = lines[0]?.split(" ");
        if (!requestLine || requestLine.length < 3) continue;

        const method = requestLine[0];
        const url = requestLine[1];
        const version = requestLine[2];
        
        const cseqMatch = requestText.match(/CSeq:\s*(\d+)/i);
        const cseq = cseqMatch ? parseInt(cseqMatch[1] ?? "0", 10) : 0;

        const sendResponse = (statusCode: number, statusText: string, headers: Record<string, string> = {}, body?: string) => {
          let response = `${version} ${statusCode} ${statusText}\r\n`;
          response += `CSeq: ${cseq}\r\n`;
          for (const [key, value] of Object.entries(headers)) {
            response += `${key}: ${value}\r\n`;
          }
          if (body) {
            response += `Content-Length: ${body.length}\r\n`;
          }
          response += "\r\n";
          if (body) {
            response += body;
          }
          socket.write(response);
        };

        this.rtspDebugLog(`RTSP ${method} ${url}`);

        if (method === "OPTIONS") {
          sendResponse(200, "OK", {
            "Public": "DESCRIBE, SETUP, TEARDOWN, PLAY, PAUSE, OPTIONS",
          });
        } else if (method === "DESCRIBE") {
          // For first client, start native stream and wait for parameter sets
          // This ensures SDP includes parameter sets for proper decoding
          if (!this.firstFrameReceived && this.connectedClients.size === 0) {
            // Start native stream to get first frame with parameter sets
            if (!this.nativeStreamActive) {
              await this.startNativeStream();
            }
            // Wait for first frame (with timeout to avoid blocking too long)
            // This ensures parameter sets are extracted before SDP is generated
            try {
              await Promise.race([
                this.firstFramePromise || Promise.resolve(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for first frame")), 10000))
              ]);
              this.rtspDebugLog(`First frame received, parameter sets extracted for SDP`);
            } catch (error) {
              console.warn(`[BaichuanRtspServer] Timeout waiting for first frame for SDP: ${error}`);
              // Continue anyway - SDP will be generated without parameter sets
              // Frames should have parameter sets prepended anyway
            }

            // For TCP, try to also prime AAC audio parameters before answering DESCRIBE.
            // If audio doesn't arrive quickly, continue with video-only SDP.
            if (this.api.client.getTransport() === "tcp" && !this.hasAudio) {
              try {
                await Promise.race([
                  this.firstAudioPromise || Promise.resolve(),
                  new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for audio")), 2000))
                ]);
              } catch {
                // ignore
              }
            }
          }
          
          // Generate SDP (parameter sets will be included if available)
          const sdp = this.generateSdp();
          sendResponse(200, "OK", {
            "Content-Type": "application/sdp",
            "Content-Base": `rtsp://${this.listenHost}:${this.listenPort}${this.path}/`,
          }, sdp);
        } else if (method === "SETUP") {
          const isTrack0 = url?.includes("track0");
          const isTrack1 = url?.includes("track1");
          if (!isTrack0 && !isTrack1) {
            sendResponse(404, "Not Found", {
              "Session": sessionId || `session_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            });
            continue;
          }

          // Only accept track1 if we advertised audio in SDP.
          if (isTrack1 && !this.hasAudio) {
            sendResponse(404, "Not Found", {
              "Session": sessionId || `session_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            });
            continue;
          }

          // Add client first
          this.connectedClients.add(clientId);
          this.emit("client", clientId);
          
          // Start native stream if first client
          if (this.connectedClients.size === 1 && !this.nativeStreamActive) {
            await this.startNativeStream();
          }

          // Parse transport
          const transportMatch = requestText.match(/Transport:\s*([^\r\n]+)/i);
          const transport = (transportMatch?.[1] ?? "").trim();
          useTcpInterleaved = transport ? (transport.includes("TCP") || transport.includes("tcp")) : true; // Default to TCP
          
          // Generate session ID (must stay stable across SETUP for multiple tracks)
          if (!sessionId) {
            sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
          }
          
          // Track client resources
          const existing = this.clientResources.get(clientId);
          if (!existing) {
            this.clientResources.set(clientId, {
              ffmpeg: undefined,
              udpSocket: null,
              udpSocketAudio: null,
              rtspSocket: socket,
              pipelineStarted: false,
              seenFirstVideoKeyframe: false,
              setupTrack0: false,
              setupTrack1: false,
              isPlaying: false,
            });
          } else {
            // Keep existing state across multiple SETUP requests (track0 + track1).
            existing.rtspSocket = socket;
          }

          // Record requested interleaved channels (ffmpeg can choose them).
          if (useTcpInterleaved) {
            const resources = this.clientResources.get(clientId) as any;
            const requested = BaichuanRtspServer.parseInterleavedChannels(transport);
            if (resources) {
              if (isTrack1) {
                const ch = requested ?? { rtp: 2, rtcp: 3 };
                resources.track1RtpChannel = ch.rtp;
                resources.track1RtcpChannel = ch.rtcp;
              } else {
                const ch = requested ?? { rtp: 0, rtcp: 1 };
                resources.track0RtpChannel = ch.rtp;
                resources.track0RtcpChannel = ch.rtcp;
              }
            }
          }
          
          // Start the media pipeline for this client once (on first SETUP, track0 or track1).
          // Note: in direct-RTP mode there is no ffmpeg process, so we must not rely on `clientFfmpeg`.
          {
            const resources = this.clientResources.get(clientId) as any;
            if (resources && !resources.pipelineStarted) {
              resources.pipelineStarted = true;
              await this.startClientFfmpeg(clientId, socket, useTcpInterleaved, (proc, udpSock, udpSockAudio) => {
                clientFfmpeg = proc;
                clientUdpSocket = udpSock;
                clientUdpSocketAudio = udpSockAudio;
                const r = this.clientResources.get(clientId) as any;
                if (r) {
                  r.ffmpeg = proc;
                  r.udpSocket = udpSock;
                  r.udpSocketAudio = udpSockAudio;
                }
              });
            }
          }

          // Mark track SETUP state (used to gate interleaved RTP forwarding).
          {
            const resources = this.clientResources.get(clientId) as any;
            if (resources) {
              if (isTrack1) resources.setupTrack1 = true;
              else resources.setupTrack0 = true;
              this.rtspDebugLog(
                `SETUP done for ${clientId}: track0=${!!resources.setupTrack0} track1=${!!resources.setupTrack1} playing=${!!resources.isPlaying}`
              );
            }
          }

          if (useTcpInterleaved) {
            const resources = this.clientResources.get(clientId) as any;
            const fallback = isTrack1 ? { rtp: 2, rtcp: 3 } : { rtp: 0, rtcp: 1 };
            const rtp = isTrack1 ? (resources?.track1RtpChannel ?? fallback.rtp) : (resources?.track0RtpChannel ?? fallback.rtp);
            const rtcp = isTrack1 ? (resources?.track1RtcpChannel ?? fallback.rtcp) : (resources?.track0RtcpChannel ?? fallback.rtcp);
            const interleaved = `${rtp}-${rtcp}`;
            sendResponse(200, "OK", {
              "Transport": `RTP/AVP/TCP;unicast;interleaved=${interleaved}`,
              "Session": sessionId,
            });
          } else {
            // UDP transport to RTSP client is not the main focus here; keep existing behavior.
            sendResponse(200, "OK", {
              "Transport": `RTP/AVP/UDP;unicast;client_port=5004-5005;server_port=5004-5005`,
              "Session": sessionId,
            });
          }
        } else if (method === "PLAY") {
          {
            const resources = this.clientResources.get(clientId) as any;
            if (resources) {
              resources.isPlaying = true;
              this.rtspDebugLog(
                `PLAY for ${clientId}: track0=${!!resources.setupTrack0} track1=${!!resources.setupTrack1} playing=${!!resources.isPlaying}`
              );
            }
          }
          sendResponse(200, "OK", {
            "Session": sessionId,
            "Range": "npt=0.000-",
          });
        } else if (method === "TEARDOWN") {
          cleanup();
          sendResponse(200, "OK", {
            "Session": sessionId,
          });
          socket.end();
        } else {
          sendResponse(501, "Not Implemented");
        }
      }
    });
  }

  /**
   * Generate SDP (Session Description Protocol) for RTSP DESCRIBE.
   */
  private generateSdp(): string {
    const codec = this.flow.sdpCodec;
    const videoPayloadType = 96;
    const audioPayloadType = 97;
    
    let sdp = "v=0\r\n";
    sdp += `o=- ${Date.now()} ${Date.now()} IN IP4 ${this.listenHost}\r\n`;
    sdp += "s=Baichuan Stream\r\n";
    sdp += `c=IN IP4 ${this.listenHost}\r\n`;
    sdp += "t=0 0\r\n";
    
    // Video track
    sdp += `m=video 0 RTP/AVP ${videoPayloadType}\r\n`;
    sdp += `a=rtpmap:${videoPayloadType} ${codec}/90000\r\n`;
    sdp += `a=control:track0\r\n`;
    
    const { fmtp, hasParamSets } = this.flow.getFmtp();
    if (!hasParamSets) {
      console.warn(`[BaichuanRtspServer] SDP missing parameter sets for flow ${this.flow.key}`);
    }
    
    if (fmtp) {
      sdp += `a=fmtp:${videoPayloadType} ${fmtp}\r\n`;
    }

    // Audio track (TCP only).
    // We packetize AAC (ADTS) as RTP mpeg4-generic, with config derived from ADTS.
    if (this.hasAudio) {
      sdp += `m=audio 0 RTP/AVP ${audioPayloadType}\r\n`;
      const a = this.audioInfo;
      const rate = a?.sampleRate ?? 8000;
      const ch = a?.channels ?? 1;
      const cfg = a?.configHex ?? "";
      sdp += `a=rtpmap:${audioPayloadType} mpeg4-generic/${rate}/${ch}\r\n`;
      if (cfg) {
        sdp += `a=fmtp:${audioPayloadType} streamtype=5; profile-level-id=15; mode=AAC-hbr; config=${cfg}; SizeLength=13; IndexLength=3; IndexDeltaLength=3;\r\n`;
      }
      sdp += `a=control:track1\r\n`;
    }

    sdp += `a=setup:passive\r\n`;
    sdp += `a=connection:new\r\n`;
    
    return sdp;
  }

  /**
   * Start ffmpeg for a specific client.
   */
  private async startClientFfmpeg(
    clientId: string,
    rtspSocket: net.Socket,
    useTcpInterleaved: boolean,
    onProcess: (proc: ReturnType<typeof spawn> | undefined, udpSock: dgram.Socket | null, udpSockAudio: dgram.Socket | null) => void
  ): Promise<void> {
    // Re-fetch stream metadata to ensure we have the correct frame rate for this profile
    let streamMetadata = this.streamMetadata;
    if (!streamMetadata || !streamMetadata.frameRate) {
      try {
        const metadata = await this.api.getStreamMetadata(this.channel);
        const stream = metadata.streams.find((s) => s.profile === this.profile);
        if (stream) {
          streamMetadata = {
            frameRate: stream.frameRate || 25,
            width: stream.width,
            height: stream.height,
          };
          this.rtspDebugLog(`Fetched metadata for profile ${this.profile}: ${streamMetadata.frameRate} fps`);
        }
      } catch (error) {
        console.warn(`[BaichuanRtspServer] Could not fetch stream metadata: ${error}`);
        streamMetadata = { frameRate: 25, width: 1920, height: 1080 };
      }
    }
    
    const ffmpegFormat = this.flow.ffmpegFormat;
    
    // For TCP interleaved we can either:
    // - packetize locally (direct RTP), or
    // - use ffmpeg as a packetizer and forward RTP.
    // The ffmpeg path proved flaky; prefer direct RTP for TCP interleaved.
    let localUdpPort = 0;
    let localUdpPortAudio = 0;
    let udpSocket: dgram.Socket | null = null;
    let udpSocketAudio: dgram.Socket | null = null;

    const useDirectRtp = useTcpInterleaved;
    
    if (useTcpInterleaved && !useDirectRtp) {
      localUdpPort = 50000 + Math.floor(Math.random() * 10000);
      udpSocket = dgram.createSocket("udp4");
      
      await new Promise<void>((resolve, reject) => {
        udpSocket!.once("listening", () => resolve());
        udpSocket!.once("error", reject);
        udpSocket!.bind(localUdpPort, "127.0.0.1");
      });
      
      const sendInterleaved = (channel: number, msg: Buffer): boolean => {
        if (!rtspSocket || rtspSocket.destroyed || !rtspSocket.writable) return false;
        if (msg.length < 12) return false;

        const version = (msg[0]! >> 6) & 0x3;
        if (version !== 2) return false;

        // Gate forwarding until the RTSP client has completed SETUP and PLAY.
        const resources = this.clientResources.get(clientId) as any;
        if (!resources?.isPlaying) return false;
        const videoRtpChannel = resources?.track0RtpChannel ?? 0;
        const audioRtpChannel = resources?.track1RtpChannel ?? 2;
        if (channel === videoRtpChannel && !resources?.setupTrack0) return false;
        if (channel === audioRtpChannel && !resources?.setupTrack1) return false;

        const header = Buffer.alloc(4);
        header[0] = 0x24; // '$'
        header[1] = channel;
        header[2] = (msg.length >> 8) & 0xff;
        header[3] = msg.length & 0xff;
        try {
          return rtspSocket.write(Buffer.concat([header, msg]));
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && (error as any).code === "EPIPE") return false;
        }

        return false;
      };

      if (udpSocket) {
        const resources = this.clientResources.get(clientId) as any;
        const videoRtpChannel = resources?.track0RtpChannel ?? 0;
        let rtpPacketCount = 0;
        let firstSeen = false;
        let firstForwarded = false;
        udpSocket.on("message", (msg: Buffer) => {
          if (!firstSeen) {
            firstSeen = true;
            this.rtspDebugLog(`First video RTP packet received from ffmpeg for client ${clientId} (len=${msg.length})`);
          }

          const forwarded = sendInterleaved(videoRtpChannel, msg);
          if (forwarded && !firstForwarded) {
            firstForwarded = true;
            this.rtspDebugLog(`First video RTP packet forwarded via TCP interleaved for client ${clientId}`);
          }
          rtpPacketCount++;
          if (rtpPacketCount % 1000 === 0) {
            this.rtspDebugLog(`Forwarded ${rtpPacketCount} RTP packets to client ${clientId} via TCP interleaved`);
          }
        });
      }

      if (this.hasAudio) {
        localUdpPortAudio = localUdpPort + 2 + Math.floor(Math.random() * 1000) * 2;
        udpSocketAudio = dgram.createSocket("udp4");
        await new Promise<void>((resolve, reject) => {
          udpSocketAudio!.once("listening", () => resolve());
          udpSocketAudio!.once("error", reject);
          udpSocketAudio!.bind(localUdpPortAudio, "127.0.0.1");
        });
        let audioPacketCount = 0;
        let firstSeenAudio = false;
        let firstForwardedAudio = false;
        udpSocketAudio.on("message", (msg: Buffer) => {
          const resources = this.clientResources.get(clientId) as any;
          const audioRtpChannel = resources?.track1RtpChannel ?? 2;
          audioPacketCount++;
          if (!firstSeenAudio) {
            firstSeenAudio = true;
            this.rtspDebugLog(`First audio RTP packet received from ffmpeg for client ${clientId} (len=${msg.length})`);
          }
          const forwarded = sendInterleaved(audioRtpChannel, msg);
          if (forwarded && !firstForwardedAudio) {
            firstForwardedAudio = true;
            this.rtspDebugLog(`First audio RTP packet forwarded via TCP interleaved for client ${clientId}`);
          }
          if (audioPacketCount % 1000 === 0) {
            this.rtspDebugLog(`Forwarded ${audioPacketCount} audio RTP packets to client ${clientId} via TCP interleaved`);
          }
        });
      }
    }
    
    const resources = this.clientResources.get(clientId) as any;
    const rtspDebug = this.isRtspDebugEnabled();
    const rtspDebugLog = (message: string) => this.rtspDebugLog(message);

    const sendInterleaved = (channel: number, msg: Buffer): boolean => {
      if (!rtspSocket || rtspSocket.destroyed || !rtspSocket.writable) return false;
      const header = Buffer.alloc(4);
      header[0] = 0x24; // '$'
      header[1] = channel;
      header[2] = (msg.length >> 8) & 0xff;
      header[3] = msg.length & 0xff;
      try {
        return rtspSocket.write(Buffer.concat([header, msg]));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && (error as any).code === "EPIPE") return false;
      }
      return false;
    };

    const getVideoChannel = (): number => (resources?.track0RtpChannel ?? 0);
    const getAudioChannel = (): number => (resources?.track1RtpChannel ?? 2);

    const buildRtpHeader = (
      payloadType: number,
      marker: boolean,
      seq: number,
      timestamp: number,
      ssrc: number
    ): Buffer => {
      const h = Buffer.alloc(12);
      h[0] = 0x80; // V=2
      h[1] = (marker ? 0x80 : 0x00) | (payloadType & 0x7f);
      h.writeUInt16BE(seq & 0xffff, 2);
      h.writeUInt32BE(timestamp >>> 0, 4);
      h.writeUInt32BE(ssrc >>> 0, 8);
      return h;
    };

    const sendRtpPacket = (isAudio: boolean, payload: Buffer, marker: boolean) => {
      const pt = isAudio ? 97 : 96;
      if (!resources?.isPlaying) return;
      if (isAudio && !resources?.setupTrack1) return;
      if (!isAudio && !resources?.setupTrack0) return;

      if (!isAudio) {
        if (resources.rtpVideoSeq === undefined) resources.rtpVideoSeq = Math.floor(Math.random() * 0x10000);
        // Start at 0 to reduce A/V offset when RTCP SR is not present.
        if (resources.rtpVideoTimestamp === undefined) resources.rtpVideoTimestamp = 0;
        if (resources.rtpVideoSsrc === undefined) resources.rtpVideoSsrc = (Math.random() * 0xffffffff) >>> 0;
        const h = buildRtpHeader(pt, marker, resources.rtpVideoSeq, resources.rtpVideoTimestamp, resources.rtpVideoSsrc);
        resources.rtpVideoSeq = (resources.rtpVideoSeq + 1) & 0xffff;
        sendInterleaved(getVideoChannel(), Buffer.concat([h, payload]));
      } else {
        if (resources.rtpAudioSeq === undefined) resources.rtpAudioSeq = Math.floor(Math.random() * 0x10000);
        // Start at 0 to reduce A/V offset when RTCP SR is not present.
        if (resources.rtpAudioTimestamp === undefined) resources.rtpAudioTimestamp = 0;
        if (resources.rtpAudioSsrc === undefined) resources.rtpAudioSsrc = (Math.random() * 0xffffffff) >>> 0;
        const h = buildRtpHeader(pt, marker, resources.rtpAudioSeq, resources.rtpAudioTimestamp, resources.rtpAudioSsrc);
        resources.rtpAudioSeq = (resources.rtpAudioSeq + 1) & 0xffff;
        sendInterleaved(getAudioChannel(), Buffer.concat([h, payload]));
      }
    };

    const maxRtpPayload = 1200;

    const packetizeAndSendH264 = (nal: Buffer, markerOnLast: boolean) => {
      if (nal.length <= maxRtpPayload) {
        sendRtpPacket(false, nal, markerOnLast);
        return;
      }
      const nalHeader = nal[0]!;
      const nalType = nalHeader & 0x1f;
      // FU indicator: keep forbidden_zero_bit + NRI, set type to 28 (FU-A)
      const fuIndicator = (nalHeader & 0xe0) | 28;
      const data = nal.subarray(1);
      let offset = 0;
      while (offset < data.length) {
        const remaining = data.length - offset;
        const chunkLen = Math.min(remaining, maxRtpPayload - 2);
        const start = offset === 0;
        const end = offset + chunkLen >= data.length;
        const fuHeader = (start ? 0x80 : 0x00) | (end ? 0x40 : 0x00) | nalType;
        const chunk = data.subarray(offset, offset + chunkLen);
        const payload = Buffer.concat([Buffer.from([fuIndicator, fuHeader]), chunk]);
        sendRtpPacket(false, payload, markerOnLast && end);
        offset += chunkLen;
      }
    };

    const packetizeAndSendH265 = (nal: Buffer, markerOnLast: boolean) => {
      if (nal.length <= maxRtpPayload) {
        sendRtpPacket(false, nal, markerOnLast);
        return;
      }
      if (nal.length < 3) return;
      const nalHeader0 = nal[0]!;
      const nalHeader1 = nal[1]!;
      const nalType = (nalHeader0 >> 1) & 0x3f;
      const fuIndicator0 = (nalHeader0 & 0x81) | (49 << 1);
      const fuIndicator1 = nalHeader1;
      const data = nal.subarray(2);
      let offset = 0;
      while (offset < data.length) {
        const remaining = data.length - offset;
        const chunkLen = Math.min(remaining, maxRtpPayload - 3);
        const start = offset === 0;
        const end = offset + chunkLen >= data.length;
        const fuHeader = (start ? 0x80 : 0x00) | (end ? 0x40 : 0x00) | (nalType & 0x3f);
        const chunk = data.subarray(offset, offset + chunkLen);
        const payload = Buffer.concat([Buffer.from([fuIndicator0, fuIndicator1, fuHeader]), chunk]);
        sendRtpPacket(false, payload, markerOnLast && end);
        offset += chunkLen;
      }
    };

    const videoClockRate = 90000;
    const videoFps = streamMetadata?.frameRate && streamMetadata.frameRate > 0 ? streamMetadata.frameRate : 25;
    const videoTimestampIncrement = Math.max(1, Math.round(videoClockRate / videoFps));

    const setVideoTimestampFromMicroseconds = (frameMicroseconds: number | null | undefined) => {
      if (!resources) return;
      if (frameMicroseconds === null || frameMicroseconds === undefined) return;
      if (!Number.isFinite(frameMicroseconds)) return;

      if (resources.rtpVideoTimestamp === undefined) resources.rtpVideoTimestamp = 0;
      if (resources.rtpVideoBaseTimestamp === undefined) resources.rtpVideoBaseTimestamp = resources.rtpVideoTimestamp;

      if (resources.rtpVideoBaseMicroseconds === undefined) {
        resources.rtpVideoBaseMicroseconds = frameMicroseconds >>> 0;
        resources.rtpVideoLastTimestamp = resources.rtpVideoTimestamp;
        return;
      }

      const baseUs = resources.rtpVideoBaseMicroseconds >>> 0;
      const curUs = frameMicroseconds >>> 0;
      const deltaUs = (curUs - baseUs) >>> 0;
      const baseTs = (resources.rtpVideoBaseTimestamp ?? 0) >>> 0;
      let ts = (baseTs + Math.round((deltaUs * videoClockRate) / 1_000_000)) >>> 0;

      const last = resources.rtpVideoLastTimestamp;
      if (last !== undefined && ts <= (last >>> 0)) {
        ts = ((last >>> 0) + 1) >>> 0;
      }

      resources.rtpVideoTimestamp = ts;
      resources.rtpVideoLastTimestamp = ts;
    };

    const sendVideoAccessUnit = (videoType: "H264" | "H265", accessUnitAnnexB: Buffer, advanceTimestamp = true) => {
      const nals = BaichuanRtspServer.splitAnnexBNals(accessUnitAnnexB);
      if (nals.length === 0) return;
      for (let idx = 0; idx < nals.length; idx++) {
        const nal = nals[idx]!;
        const isLastNal = idx === nals.length - 1;
        if (videoType === "H265") packetizeAndSendH265(nal, isLastNal);
        else packetizeAndSendH264(nal, isLastNal);
      }

      // If we don't have bcmedia microseconds available, fall back to fixed FPS increment.
      if (advanceTimestamp && resources?.rtpVideoTimestamp !== undefined && resources?.rtpVideoBaseMicroseconds === undefined) {
        resources.rtpVideoTimestamp = (resources.rtpVideoTimestamp + videoTimestampIncrement) >>> 0;
      }
    };

    const sendAudioAdtsFrame = (adts: Buffer) => {
      const raw = BaichuanRtspServer.stripAdtsHeader(adts);
      if (!raw) return;
      // RFC 3640: AU-headers-length (16 bits) + AU-header (16 bits)
      const auHeadersLength = Buffer.from([0x00, 0x10]);
      const auSize = raw.length & 0x1fff;
      const auHeader = Buffer.alloc(2);
      // AU-size (13 bits) + AU-Index (3 bits, 0)
      auHeader[0] = (auSize >> 5) & 0xff;
      auHeader[1] = (auSize & 0x1f) << 3;
      const payload = Buffer.concat([auHeadersLength, auHeader, raw]);
      sendRtpPacket(true, payload, true);

      // advance audio timestamp by 1024 samples per AAC-LC frame
      if (resources?.rtpAudioTimestamp !== undefined) {
        resources.rtpAudioTimestamp = (resources.rtpAudioTimestamp + 1024) >>> 0;
      }
    };

    const isH265IrapAccessUnit = (annexB: Buffer): boolean => {
      const nals = splitAnnexBToNalPayloads(annexB);
      for (const nal of nals) {
        if (nal.length < 2) continue;
        const b0 = nal[0];
        if (b0 === undefined) continue;
        if ((b0 & 0x80) !== 0) continue;
        const nalType = (b0 >> 1) & 0x3f;
        if (isH265Irap(nalType)) return true;
      }
      return false;
    };

    if (useDirectRtp) {
      onProcess(undefined, null, null);
    }

    let ffmpeg: ReturnType<typeof spawn> | undefined;
    let audioPipe: NodeJS.WritableStream | undefined;
    if (!useDirectRtp) {
      const ffmpegArgs = [
        "-hide_banner",
        "-loglevel", "error",
        "-fflags", "+genpts+igndts", // Generate PTS, ignore DTS from input
      ];
    
      // Set input frame rate if available (before -f and -i)
      // This tells ffmpeg how to interpret the timing of frames from stdin
      const frameRate = streamMetadata?.frameRate || 25;
      if (frameRate > 0) {
        ffmpegArgs.push("-r", frameRate.toString());
        this.rtspDebugLog(`Using frame rate ${frameRate} fps for client ${clientId}`);
      }
    
      ffmpegArgs.push(
        "-f", ffmpegFormat,
        "-i", "pipe:0",
      );

    // Optional audio input (AAC ADTS -> RTP L16).
    // We keep it TCP-only and conservative: if audio isn't detected/advertised, skip entirely.
      if (this.hasAudio) {
        ffmpegArgs.push(
          "-f", "aac",
          "-i", "pipe:3",
        );
      }
    
    // Note: For RTP output, we don't need to specify output frame rate
    // The timestamps will be generated based on the input frame rate and -vsync cfr
    
    // Note: Frames from BaichuanVideoStream are already in Annex-B format with SPS/PPS prepended
    // So we don't need h264_mp4toannexb or hevc_mp4toannexb bitstream filters
      if (useTcpInterleaved) {
      // Video output
      ffmpegArgs.push(
        "-map", "0:v:0",
        "-c:v", "copy",
        "-vsync", "cfr", // Constant frame rate - generate timestamps based on input frame rate
        "-avoid_negative_ts", "make_zero", // Ensure timestamps are non-negative
        "-f", "rtp",
        "-payload_type", "96",
        `rtp://127.0.0.1:${localUdpPort}?pkt_size=1300`,
      );
      // Audio output
      if (this.hasAudio && udpSocketAudio && localUdpPortAudio) {
        const a = this.audioInfo;
        const rate = a?.sampleRate ?? 8000;
        const ch = a?.channels ?? 1;
        ffmpegArgs.push(
          "-map", "1:a:0",
          // ffmpeg's RTP muxer requires AAC extradata (global headers); encoding ensures it's present.
          "-c:a", "aac",
          "-profile:a", "aac_low",
          "-ar", String(rate),
          "-ac", String(ch),
          "-flags:a", "+global_header",
          "-f", "rtp",
          "-payload_type", "97",
          `rtp://127.0.0.1:${localUdpPortAudio}?pkt_size=1300`,
        );
      }
      } else {
      ffmpegArgs.push(
        "-map", "0:v:0",
        "-c:v", "copy",
        "-vsync", "cfr",
        "-avoid_negative_ts", "make_zero",
        "-f", "rtp",
        "-payload_type", "96",
        `rtp://127.0.0.1:5004?pkt_size=1300`,
      );
    }
    
      const stdio: any[] = ["pipe", "ignore", "pipe"];
      if (this.hasAudio) stdio.push("pipe");
      this.rtspDebugLog(`Spawning ffmpeg for client ${clientId}: ffmpeg ${ffmpegArgs.join(" ")}`);
      ffmpeg = spawn("ffmpeg", ffmpegArgs, {
        stdio,
      });

      // Seed ffmpeg with video parameter sets so it can start parsing/packetizing immediately.
      // This helps when live access units don't carry SPS/PPS early enough.
      try {
        const paramSets = this.flow.getParameterSetsAnnexB();
        if (paramSets && paramSets.length > 0 && ffmpeg?.stdin) {
          ffmpeg.stdin.write(paramSets);
          this.rtspDebugLog(`Wrote video parameter sets to ffmpeg stdin for client ${clientId} (len=${paramSets.length})`);
        }
      } catch (e) {
        console.warn(`[BaichuanRtspServer] Failed to write video parameter sets to ffmpeg for client ${clientId}: ${e}`);
      }
      ffmpeg.on("error", (error) => {
        console.error(`[BaichuanRtspServer] Failed to spawn ffmpeg for client ${clientId}:`, error);
      });

      ffmpeg.on("close", (code, signal) => {
        this.rtspDebugLog(`ffmpeg exited for client ${clientId} (code=${code}, signal=${signal})`);
      });

      onProcess(ffmpeg, udpSocket, udpSocketAudio);

      // Prevent unhandled errors on the writable side when the client disconnects or the server stops.
      // We treat these as normal shutdown signals.
      ffmpeg.stdin?.on("error", (error: NodeJS.ErrnoException) => {
        const code = (error as any)?.code;
        if (code === "EPIPE" || code === "ERR_STREAM_WRITE_AFTER_END") {
          this.rtspDebugLog(`FFmpeg stdin error (${code}) for client ${clientId}`);
          return;
        }
        console.error(`[BaichuanRtspServer] FFmpeg stdin error for client ${clientId}:`, error);
      });

      audioPipe = (this.hasAudio ? (ffmpeg.stdio?.[3] as NodeJS.WritableStream | undefined) : undefined);
      (audioPipe as any)?.on?.("error", (error: NodeJS.ErrnoException) => {
        const code = (error as any)?.code;
        if (code === "EPIPE" || code === "ERR_STREAM_WRITE_AFTER_END") {
          this.rtspDebugLog(`FFmpeg audio pipe error (${code}) for client ${clientId}`);
          return;
        }
        console.error(`[BaichuanRtspServer] FFmpeg audio pipe error for client ${clientId}:`, error);
      });

      // If we already observed an ADTS frame during SDP priming, push one immediately.
      // This prevents ffmpeg from blocking on probing `pipe:3` before it can start producing RTP.
      if (audioPipe && this.audioPrimingFrame) {
        try {
          audioPipe.write(this.audioPrimingFrame);
        } catch {}
      }
    
    }

    // Default: each client gets its own native stream generator.
    // When available, reuse the already-started generator created during DESCRIBE SDP priming.
    // This avoids a costly stop/start cycle and makes the first RTP packets arrive much sooner.
    this.rtspDebugLog(`Creating native stream generator for client ${clientId}`);
    const clientGenerator = this.tempStreamGenerator
      ? this.tempStreamGenerator
      : createNativeStream(this.api, this.channel, this.profile);
    if (this.tempStreamGenerator) {
      this.rtspDebugLog(`Reusing primed generator for client ${clientId}`);
      this.tempStreamGenerator = null;
    }
    
    // Feed frames to ffmpeg from native stream with proper timing
    let frameCount = 0;
    let lastFrameTime = Date.now();
    const targetFrameInterval = streamMetadata && streamMetadata.frameRate > 0 
      ? 1000 / streamMetadata.frameRate 
      : 40; // Default to 25fps if not available
    
    const feedFrames = async () => {
      try {
        this.rtspDebugLog(
          `Starting to feed frames to client ${clientId} (target FPS: ${streamMetadata?.frameRate || 25}, interval: ${targetFrameInterval}ms)`
        );
        let audioFrameCount = 0;
        let firstVideoWriteLogged = false;
        let firstAudioWriteLogged = false;
        let firstVideoFrameSeenLogged = false;
        let h265WaitParamSetsLogged = false;
        let h265WaitIrapLogged = false;
        for await (const frame of clientGenerator) {
          // Check if client is still connected before processing frame
          if (!this.connectedClients.has(clientId)) {
            this.rtspDebugLog(`Client ${clientId} disconnected, stopping frame feed`);
            break;
          }
          
          const stdin = ffmpeg?.stdin;
          if (!useDirectRtp) {
            if (!stdin || stdin.destroyed || stdin.writableEnded || stdin.writableFinished) {
              this.rtspDebugLog(`FFmpeg stdin closed for client ${clientId}`);
              break;
            }
          }
          
          if (frame.data.length === 0) continue;

          if (!frame.audio && !firstVideoFrameSeenLogged) {
            firstVideoFrameSeenLogged = true;
            if (rtspDebug) {
              const headHex = frame.data.subarray(0, 16).toString("hex");
              rtspDebugLog(
                `First video frame received from generator for client ${clientId} (len=${frame.data.length}, videoType=${String(
                  (frame as any).videoType ?? this.flow.videoType
                )}, head=${headHex})`
              );
            }
          }
          
          // Handle audio frames (TCP only): write ADTS AAC frames to ffmpeg audio pipe.
          if (frame.audio) {
            audioFrameCount++;
            if (audioFrameCount === 1) {
              this.rtspDebugLog(
                `Audio frames detected (codec: ${frame.codec || "unknown"}, sampleRate: ${frame.sampleRate || "unknown"})`
              );
            }
            if (audioFrameCount % 100 === 0) {
              this.rtspDebugLog(`Received ${audioFrameCount} audio frames (not sent to RTSP yet)`);
            }

            if (useDirectRtp) {
              // Avoid starting with audio-only while the decoder is still waiting for the first keyframe.
              if (!resources?.seenFirstVideoKeyframe) {
                continue;
              }
              if (this.hasAudio && BaichuanRtspServer.isAdtsAacFrame(frame.data)) {
                if (rtspDebug && !firstAudioWriteLogged) {
                  firstAudioWriteLogged = true;
                  const headHex = frame.data.subarray(0, 16).toString("hex");
                  rtspDebugLog(`First audio ADTS frame packetized to RTP for client ${clientId} (len=${frame.data.length}, head=${headHex})`);
                }
                sendAudioAdtsFrame(frame.data);
              }
              continue;
            } else {
              const audioPipeOk =
                this.hasAudio &&
                audioPipe &&
                !(audioPipe as any).writableEnded &&
                !(audioPipe as any).writableFinished;
              if (audioPipeOk) {
                const ap = audioPipe;
                if (!ap) continue;
                // Only accept AAC ADTS frames for now.
                if (BaichuanRtspServer.isAdtsAacFrame(frame.data)) {
                  try {
                    if (!firstAudioWriteLogged) {
                      firstAudioWriteLogged = true;
                      const headHex = frame.data.subarray(0, 16).toString("hex");
                      this.rtspDebugLog(
                        `First audio frame written to ffmpeg pipe for client ${clientId} (len=${frame.data.length}, head=${headHex})`
                      );
                    }
                    const written = ap.write(frame.data);
                    if (!written) {
                      await new Promise<void>((resolve) => ap.once("drain", () => resolve()));
                    }
                  } catch {}
                }
              }
              continue;
            }
            continue;
          }
          
          // Extract parameter sets until available.
          // Some cameras don't include VPS/SPS/PPS in the very first access unit.
          if (frame.videoType === "H264" || frame.videoType === "H265") {
            if (frameCount === 0) {
              this.setFlowVideoType(frame.videoType, "first video frame");
            }

            const before = this.flow.getFmtp();
            if (!before.hasParamSets) {
              this.flow.extractParameterSets(frame.data);
              const after = this.flow.getFmtp();
              if (after.hasParamSets) {
                this.markFirstFrameReceived();
              }
            } else if (!this.firstFrameReceived) {
              this.markFirstFrameReceived();
            }
          }
          
          frameCount++;
          if (frameCount % 100 === 0) {
            this.rtspDebugLog(`Sent ${frameCount} frames to client ${clientId} (frame size: ${frame.data.length} bytes)`);
          }
          
          // Throttle frame sending to match frame rate
          // Use a more precise timing mechanism to ensure frames are sent at the correct rate
          const now = Date.now();
          const timeSinceLastFrame = now - lastFrameTime;
          const waitTime = targetFrameInterval - timeSinceLastFrame;
          if (waitTime > 0) {
            // Wait for the exact interval before sending the next frame
            await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, targetFrameInterval * 2)));
          }
          lastFrameTime = Date.now();
          
          if (useDirectRtp) {
            const videoType = (frame.videoType ?? this.flow.videoType) as "H264" | "H265";

            // Many cameras start streaming with P-frames; decoding stays black until the first IDR/IRAP.
            // For H.264 we gate strictly on IDR.
            // For H.265 we gate on: (1) having VPS/SPS/PPS extracted (so we can send config), then
            // (2) seeing an IRAP access unit (with a short timeout to avoid deadlocks).
            if (!resources?.seenFirstVideoKeyframe) {
              if (videoType === "H265") {
                const { hasParamSets } = this.flow.getFmtp();
                if (!hasParamSets) {
                  if (rtspDebug && !h265WaitParamSetsLogged) {
                    h265WaitParamSetsLogged = true;
                    rtspDebugLog(`H265 gating: waiting for VPS/SPS/PPS before sending RTP to client ${clientId}`);
                  }
                  continue;
                }

                // Send parameter sets as soon as we have them, even before the first IRAP.
                if (!resources?.rtpSentVideoConfig) {
                  const paramSets = this.flow.getParameterSetsAnnexB();
                  if (paramSets && paramSets.length > 0) {
                    sendVideoAccessUnit(videoType, paramSets, false);
                    resources.rtpSentVideoConfig = true;
                  }
                }

                if (!resources.h265WaitStartMs) resources.h265WaitStartMs = Date.now();
                const isIrap = isH265IrapAccessUnit(frame.data);
                const waitedMs = Date.now() - (resources.h265WaitStartMs as number);
                if (!isIrap && waitedMs < 2000) {
                  if (rtspDebug && !h265WaitIrapLogged) {
                    h265WaitIrapLogged = true;
                    rtspDebugLog(`H265 gating: waiting for IRAP (or timeout) for client ${clientId}`);
                  }
                  continue;
                }

                resources.seenFirstVideoKeyframe = true;
              } else {
                const isKeyframe = isH264KeyframeAnnexB(frame.data);
                if (!isKeyframe) {
                  continue;
                }
                resources.seenFirstVideoKeyframe = true;
              }
            }

            // Derive RTP timestamps from the bcmedia microseconds clock (when available).
            // This makes frame pacing/timing match the camera source more closely than using a fixed FPS increment.
            const frameMicroseconds = (frame as any).microseconds as number | null | undefined;
            setVideoTimestampFromMicroseconds(frameMicroseconds);

            if (!resources?.rtpSentVideoConfig) {
              const paramSets = this.flow.getParameterSetsAnnexB();
              if (paramSets && paramSets.length > 0) {
                // Parameter sets are not a video frame; keep the same RTP timestamp.
                sendVideoAccessUnit(videoType, paramSets, false);
                resources.rtpSentVideoConfig = true;
              }
            }
            if (!firstVideoWriteLogged) {
              firstVideoWriteLogged = true;
              if (rtspDebug) {
                const headHex = frame.data.subarray(0, 16).toString("hex");
                rtspDebugLog(`First video access unit packetized to RTP for client ${clientId} (len=${frame.data.length}, head=${headHex})`);
              }
            }

            sendVideoAccessUnit(videoType, frame.data, true);
          } else {
            try {
              if (stdin && !stdin.destroyed && !stdin.writableEnded && !stdin.writableFinished) {
                if (!firstVideoWriteLogged) {
                  firstVideoWriteLogged = true;
                  const headHex = frame.data.subarray(0, 16).toString("hex");
                  this.rtspDebugLog(
                    `First video frame written to ffmpeg stdin for client ${clientId} (len=${frame.data.length}, head=${headHex})`
                  );
                }
                const written = stdin.write(frame.data);
                if (!written) {
                  await new Promise<void>((resolve) => {
                    if (stdin) {
                      stdin.once("drain", () => resolve());
                    } else {
                      resolve();
                    }
                  });
                }
              }
            } catch (error) {
              const code = (error as any)?.code;
              if (code === "EPIPE" || code === "ERR_STREAM_WRITE_AFTER_END") {
                this.rtspDebugLog(`EPIPE writing to ffmpeg for client ${clientId}`);
                break;
              }
              console.error(`[BaichuanRtspServer] Error writing frame to ffmpeg for client ${clientId}:`, error);
            }
          }
        }
        this.rtspDebugLog(`Finished feeding frames to client ${clientId} (total: ${frameCount} frames)`);
      } catch (error) {
        console.error(`[BaichuanRtspServer] Error in feedFrames for client ${clientId}:`, error);
      }
    };
    
    feedFrames().catch((error) => {
      console.error(`[BaichuanRtspServer] Error feeding frames to client ${clientId}:`, error);
    });
    
    // Log ffmpeg errors (ffmpeg path only)
    ffmpeg?.stderr?.on("data", (data: Buffer) => {
      const output = data.toString();
      if (output.includes("error") || output.includes("Error")) {
        console.error(`[BaichuanRtspServer] FFmpeg error for client ${clientId}: ${output}`);
      }
    });
  }

  /**
   * Start native stream (mark as active).
   * Each client will create its own generator, so we just track that the stream is active.
   */
  private async startNativeStream(): Promise<void> {
    if (this.nativeStreamActive) {
      return;
    }

    this.nativeStreamActive = true;
    this.firstFrameReceived = false;
    this.firstAudioDetected = false;
    this.hasAudio = false;
    this.audioInfo = null;
    this.audioPrimingFrame = null;
    
    // Create promise that resolves when first frame arrives
    this.firstFramePromise = new Promise<void>((resolve) => {
      this.firstFrameResolve = resolve;
    });

    this.firstAudioPromise = new Promise<void>((resolve) => {
      this.firstAudioResolve = resolve;
    });
    
    this.rtspDebugLog(`Starting native stream for profile ${this.profile} (waiting for camera to start transmitting...)`);

    // Keep-alive behavior is part of the selected protocol flow.
    await this.flow.startKeepAlive(this.api);
    
    // Start a stream to extract parameter sets for SDP.
    // IMPORTANT (battery/UDP): do not iterate with `for await` + `break`, because that will close
    // the generator and send a stop-stream command. Instead, call `next()` until SPS/PPS are found
    // and then leave the generator open so the first client can keep consuming it.
    const tempGen = createNativeStream(this.api, this.channel, this.profile);
    // Keep it open so the first RTSP client can immediately consume frames.
    // We'll hand it off in `startClientFfmpeg()` and then clear `tempStreamGenerator`.
    const keepTempGenOpen = true;
    this.tempStreamGenerator = tempGen;

    (async () => {
      try {
        this.rtspDebugLog(`Waiting for parameter sets in temporary stream...`);
        const startTime = Date.now();
        let paramSetsReadyAt = 0;
        while (true) {
          const { value: frame, done } = await tempGen.next();
          if (done || !frame) break;
          if (frame.audio) {
            // TCP-only audio detection: only advertise audio if we see ADTS AAC.
            if (!this.hasAudio && this.api.client.getTransport() === "tcp" && BaichuanRtspServer.isAdtsAacFrame(frame.data)) {
              const info = BaichuanRtspServer.parseAdtsSamplingInfo(frame.data);
              if (info) {
                this.hasAudio = true;
                this.audioInfo = { codec: "aac-adts", sampleRate: info.sampleRate, channels: info.channels, configHex: info.configHex };
                this.audioPrimingFrame = Buffer.from(frame.data);
                this.markFirstAudioDetected();
                this.rtspDebugLog(
                  `Audio detected (AAC/ADTS ${info.sampleRate}Hz ch=${info.channels}); advertising RTSP track1 as mpeg4-generic`
                );
              }
            }
            continue;
          }
          if (frame.data.length === 0) continue;

          if (frame.videoType === "H264" || frame.videoType === "H265") {
            this.setFlowVideoType(frame.videoType, "temp stream");
          }

          this.flow.extractParameterSets(frame.data);
          const { hasParamSets } = this.flow.getFmtp();
          if (hasParamSets) {
            this.rtspDebugLog(`Parameter sets extracted from temporary stream (${frame.data.length} bytes)`);
            this.markFirstFrameReceived();

            // For TCP, prefer including audio in SDP if it shows up quickly.
            // For UDP/battery, stop as soon as we have SPS/PPS to avoid extra stream churn.
            if (this.api.client.getTransport() !== "tcp") {
              break;
            }

            if (!paramSetsReadyAt) paramSetsReadyAt = Date.now();
            if (this.hasAudio) {
              break;
            }

            // Don't keep priming forever.
            if (Date.now() - paramSetsReadyAt > 2000) {
              break;
            }

            // Also cap total priming time.
            if (Date.now() - startTime > 10000) {
              break;
            }
          }
        }
      } catch (error) {
        console.warn(`[BaichuanRtspServer] Error in temporary stream for parameter sets: ${error}`);
      } finally {
        // Keep the temporary generator open so the first RTSP client can immediately consume frames.
        // (It will be handed off in `startClientFfmpeg()` via `this.tempStreamGenerator`.)
        if (!keepTempGenOpen) {
          try {
            await tempGen.return(undefined as any);
          } catch {}
        }
      }
    })().catch(() => {
      // Ignore errors in background task
    });
  }
  
  private markFirstFrameReceived(): void {
    if (!this.firstFrameReceived && this.firstFrameResolve) {
      this.firstFrameReceived = true;
      this.rtspDebugLog(`First frame received from camera for profile ${this.profile}`);
      this.firstFrameResolve();
      this.firstFrameResolve = null;
    }
  }

  private markFirstAudioDetected(): void {
    if (!this.firstAudioDetected && this.firstAudioResolve) {
      this.firstAudioDetected = true;
      this.firstAudioResolve();
      this.firstAudioResolve = null;
    }
  }

  /**
   * Stop native stream (mark as inactive).
   */
  private stopNativeStream(): void {
    if (!this.nativeStreamActive) {
      return;
    }

    this.rtspDebugLog(`Stopping native stream`);

    this.flow.stopKeepAlive();

    this.nativeStreamActive = false;
    this.firstFrameReceived = false;
    this.firstFramePromise = null;
    if (this.firstFrameResolve) {
      // Reject the promise if it's still pending
      this.firstFrameResolve = null;
    }
    this.firstAudioDetected = false;
    this.firstAudioPromise = null;
    if (this.firstAudioResolve) {
      this.firstAudioResolve = null;
    }
    // Close the priming generator if it was never handed off to a client.
    if (this.tempStreamGenerator) {
      try {
        void this.tempStreamGenerator.return(undefined as any);
      } catch {}
      this.tempStreamGenerator = null;
    }

    // Note: Individual client generators are cleaned up when clients disconnect
  }

  /**
   * Remove a client and stop native stream if no clients remain.
   */
  private removeClient(clientId: string): void {
    if (this.connectedClients.has(clientId)) {
      this.connectedClients.delete(clientId);
      this.emit("clientDisconnected", clientId);
      console.log(`[BaichuanRtspServer] RTSP client disconnected: ${clientId}`);
      
      // Stop native stream if no clients remain
      if (this.connectedClients.size === 0) {
        this.stopNativeStream();
      }
    }
  }

  /**
   * Wait until RTSP server is ready to accept connections AND camera starts transmitting frames.
   * This ensures that the server is fully ready, including waiting for the camera to wake up
   * and start sending video frames (important for battery-powered cameras).
   */
  async waitUntilReady(timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.clientConnectionServer) {
        reject(new Error("RTSP server not started"));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for RTSP server to be ready (${timeoutMs}ms). Camera may be sleeping or not responding.`));
      }, timeoutMs);

      // First, check if port is listening
      const checkPort = () => {
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.on("connect", () => {
          socket.destroy();
          // Port is listening, now wait for first frame if native stream is active
          if (this.nativeStreamActive && this.firstFramePromise) {
            this.rtspDebugLog(`Port is listening, waiting for camera to start transmitting frames...`);
            this.firstFramePromise
              .then(() => {
                clearTimeout(timeout);
                resolve();
              })
              .catch((error) => {
                clearTimeout(timeout);
                reject(error);
              });
          } else {
            // No native stream active yet, just wait for port
            clearTimeout(timeout);
            resolve();
          }
        });
        socket.on("timeout", () => {
          socket.destroy();
          setTimeout(checkPort, 500);
        });
        socket.on("error", () => {
          socket.destroy();
          setTimeout(checkPort, 500);
        });
        socket.connect(this.listenPort, this.listenHost);
      };
      
      // Start checking immediately
      checkPort();
    });
  }

  /**
   * Stop the RTSP server.
   * This will close all client connections and release all resources.
   */
  async stop(): Promise<void> {
    if (!this.active) {
      return;
    }

    console.log(`[BaichuanRtspServer] Stopping RTSP server on ${this.listenHost}:${this.listenPort}...`);

    // Stop native stream
    this.stopNativeStream();

    // Close all client connections and cleanup resources
    const clientIds = Array.from(this.connectedClients);
    for (const clientId of clientIds) {
      const resources = this.clientResources.get(clientId);
      if (resources) {
        // Kill ffmpeg process
        if (resources.ffmpeg) {
          try {
            resources.ffmpeg.stdin?.end();
            resources.ffmpeg.kill("SIGTERM");
            setTimeout(() => {
              try {
                resources.ffmpeg?.kill("SIGKILL");
              } catch {}
            }, 1000);
          } catch {}
        }
        
        // Close UDP socket
        if (resources.udpSocket) {
          try {
            resources.udpSocket.close();
          } catch {}
        }
        
        // Close RTSP socket
        if (resources.rtspSocket && !resources.rtspSocket.destroyed) {
          try {
            resources.rtspSocket.destroy();
          } catch {}
        }
      }
    }
    this.clientResources.clear();

    // Close client connection server
    if (this.clientConnectionServer) {
      await new Promise<void>((resolve) => {
        this.clientConnectionServer?.close(() => {
          resolve();
        });
      });
      this.clientConnectionServer = undefined;
    }

    this.active = false;
    this.connectedClients.clear();
    this.emit("close");
    console.log(`[BaichuanRtspServer] RTSP server stopped`);
  }

  /**
   * Get RTSP URL for this server.
   */
  getRtspUrl(): string {
    return `rtsp://${this.listenHost}:${this.listenPort}${this.path}`;
  }

  /**
   * Check if server is active.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Get number of connected clients.
   */
  getClientCount(): number {
    return this.connectedClients.size;
  }
}
