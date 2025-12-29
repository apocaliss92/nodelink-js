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
  private detectedVideoType: "H264" | "H265" | null = null;
  
  // Client tracking
  private connectedClients = new Set<string>(); // Set of client IDs (IP:port)
  private nativeStreamActive = false; // Whether the native stream is currently active
  private clientConnectionServer: net.Server | undefined; // TCP server to track connections
  private streamMetadata: { frameRate: number; width: number; height: number } | null = null;
  // Track all client resources for cleanup
  private clientResources = new Map<string, {
    ffmpeg: ReturnType<typeof spawn> | undefined;
    udpSocket: dgram.Socket | null;
    rtspSocket: net.Socket | null;
  }>();

  constructor(options: BaichuanRtspServerOptions) {
    super();
    this.api = options.api;
    this.channel = options.channel;
    this.profile = options.profile;
    this.listenHost = options.listenHost ?? "127.0.0.1";
    this.listenPort = options.listenPort ?? 8554;
    this.path = options.path ?? `/stream/${this.profile}`;
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
        // Detect video type from metadata
        if (stream.videoEncType === "H.265" || stream.videoEncType === "HEVC") {
          this.detectedVideoType = "H265";
        } else {
          this.detectedVideoType = "H264";
        }
      }
    } catch (error) {
      console.warn(`[BaichuanRtspServer] Could not get stream metadata: ${error}`);
      this.streamMetadata = { frameRate: 25, width: 1920, height: 1080 };
      this.detectedVideoType = "H264"; // Default
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
        
        // Close UDP socket
        if (resources.udpSocket) {
          try {
            resources.udpSocket.close();
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

        console.log(`[BaichuanRtspServer] RTSP ${method} ${url}`);

        if (method === "OPTIONS") {
          sendResponse(200, "OK", {
            "Public": "DESCRIBE, SETUP, TEARDOWN, PLAY, PAUSE, OPTIONS",
          });
        } else if (method === "DESCRIBE") {
          // Generate SDP
          const sdp = this.generateSdp();
          sendResponse(200, "OK", {
            "Content-Type": "application/sdp",
            "Content-Base": `rtsp://${this.listenHost}:${this.listenPort}${this.path}/`,
          }, sdp);
        } else if (method === "SETUP") {
          // Add client first
          this.connectedClients.add(clientId);
          this.emit("client", clientId);
          
          // Start native stream if first client
          if (this.connectedClients.size === 1 && !this.nativeStreamActive) {
            await this.startNativeStream();
          }

          // Parse transport
          const transportMatch = requestText.match(/Transport:\s*([^\r\n]+)/i);
          const transport = transportMatch ? transportMatch[1] : "";
          useTcpInterleaved = transport ? (transport.includes("TCP") || transport.includes("tcp")) : true; // Default to TCP
          
          // Generate session ID
          sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
          
          // Track client resources
          this.clientResources.set(clientId, {
            ffmpeg: undefined,
            udpSocket: null,
            rtspSocket: socket,
          });
          
          // Start ffmpeg for this client
          await this.startClientFfmpeg(clientId, socket, useTcpInterleaved, (proc, udpSock) => {
            clientFfmpeg = proc;
            clientUdpSocket = udpSock;
            const resources = this.clientResources.get(clientId);
            if (resources) {
              resources.ffmpeg = proc;
              resources.udpSocket = udpSock;
            }
          });

          if (useTcpInterleaved) {
            sendResponse(200, "OK", {
              "Transport": `RTP/AVP/TCP;unicast;interleaved=0-1`,
              "Session": sessionId,
            });
          } else {
            sendResponse(200, "OK", {
              "Transport": `RTP/AVP/UDP;unicast;client_port=5004-5005;server_port=5004-5005`,
              "Session": sessionId,
            });
          }
        } else if (method === "PLAY") {
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
    const codec = this.detectedVideoType === "H265" ? "H265" : "H264";
    const payloadType = 96;
    
    let sdp = "v=0\r\n";
    sdp += `o=- ${Date.now()} ${Date.now()} IN IP4 ${this.listenHost}\r\n`;
    sdp += "s=Baichuan Stream\r\n";
    sdp += `c=IN IP4 ${this.listenHost}\r\n`;
    sdp += "t=0 0\r\n";
    sdp += `m=video 0 RTP/AVP/TCP ${payloadType}\r\n`;
    sdp += `a=rtpmap:${payloadType} ${codec}/90000\r\n`;
    sdp += `a=control:track0\r\n`;
    sdp += `a=fmtp:${payloadType} packetization-mode=1\r\n`;
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
    onProcess: (proc: ReturnType<typeof spawn>, udpSock: dgram.Socket | null) => void
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
          console.log(`[BaichuanRtspServer] Fetched metadata for profile ${this.profile}: ${streamMetadata.frameRate} fps`);
        }
      } catch (error) {
        console.warn(`[BaichuanRtspServer] Could not fetch stream metadata: ${error}`);
        streamMetadata = { frameRate: 25, width: 1920, height: 1080 };
      }
    }
    
    const ffmpegFormat = this.detectedVideoType === "H265" ? "hevc" : "h264";
    
    // For TCP interleaved, use a local UDP socket to receive RTP from ffmpeg
    // Then forward via TCP interleaved
    let localUdpPort = 0;
    let udpSocket: dgram.Socket | null = null;
    
    if (useTcpInterleaved) {
      localUdpPort = 50000 + Math.floor(Math.random() * 10000);
      udpSocket = dgram.createSocket("udp4");
      
      await new Promise<void>((resolve, reject) => {
        udpSocket!.once("listening", () => resolve());
        udpSocket!.once("error", reject);
        udpSocket!.bind(localUdpPort, "127.0.0.1");
      });
      
      // Forward RTP packets from UDP to TCP interleaved
      if (udpSocket) {
        let rtpPacketCount = 0;
        udpSocket.on("message", (msg: Buffer) => {
          if (!rtspSocket || rtspSocket.destroyed || !rtspSocket.writable) return;
          if (msg.length < 12) return;
          
          const version = (msg[0]! >> 6) & 0x3;
          if (version !== 2) return;
          
          const payloadType = msg[1]! & 0x7F;
          const channel = payloadType === 96 ? 0 : 2;
          
          const header = Buffer.alloc(4);
          header[0] = 0x24; // '$'
          header[1] = channel;
          header[2] = (msg.length >> 8) & 0xFF;
          header[3] = msg.length & 0xFF;
          
          rtpPacketCount++;
          if (rtpPacketCount % 1000 === 0) {
            console.log(`[BaichuanRtspServer] Forwarded ${rtpPacketCount} RTP packets to client ${clientId} via TCP interleaved`);
          }
          
          try {
            rtspSocket.write(Buffer.concat([header, msg]));
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'EPIPE') {
        return;
            }
          }
        });
      }
    }
    
    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel", "error",
      "-fflags", "+genpts",
    ];
    
    // Set input frame rate if available (before -f and -i)
    // This tells ffmpeg how to interpret the timing of frames from stdin
    const frameRate = streamMetadata?.frameRate || 25;
    if (frameRate > 0) {
      ffmpegArgs.push("-r", frameRate.toString());
      console.log(`[BaichuanRtspServer] Using frame rate ${frameRate} fps for client ${clientId}`);
    }
    
    ffmpegArgs.push(
      "-f", ffmpegFormat,
      "-use_wallclock_as_timestamps", "1", // Use wallclock time as timestamps for better accuracy
      "-i", "pipe:0",
      "-c:v", "copy",
      "-vsync", "cfr", // Constant frame rate - generate timestamps based on input frame rate
    );
    
    // Note: For RTP output, we don't need to specify output frame rate
    // The timestamps will be generated based on the input frame rate and -vsync cfr
    
    // Note: Frames from BaichuanVideoStream are already in Annex-B format with SPS/PPS prepended
    // So we don't need h264_mp4toannexb or hevc_mp4toannexb bitstream filters
    
    if (useTcpInterleaved) {
      ffmpegArgs.push(
        "-f", "rtp",
        "-payload_type", "96",
        `rtp://127.0.0.1:${localUdpPort}?pkt_size=1300`,
      );
    } else {
      ffmpegArgs.push(
        "-f", "rtp",
        "-payload_type", "96",
        `rtp://127.0.0.1:5004?pkt_size=1300`,
      );
    }
    
    const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    
    onProcess(ffmpeg, udpSocket);
    
    // Each client gets its own native stream generator
    // This ensures that each client receives all frames independently
    console.log(`[BaichuanRtspServer] Creating native stream generator for client ${clientId}`);
    const clientGenerator = createNativeStream(this.api, this.channel, this.profile);
    
    // Feed frames to ffmpeg from native stream with proper timing
    let frameCount = 0;
    let lastFrameTime = Date.now();
    const targetFrameInterval = streamMetadata && streamMetadata.frameRate > 0 
      ? 1000 / streamMetadata.frameRate 
      : 40; // Default to 25fps if not available
    
    const feedFrames = async () => {
      try {
        console.log(`[BaichuanRtspServer] Starting to feed frames to client ${clientId} (target FPS: ${streamMetadata?.frameRate || 25}, interval: ${targetFrameInterval}ms)`);
        for await (const frame of clientGenerator) {
          if (!ffmpeg.stdin || ffmpeg.stdin.destroyed) {
            console.log(`[BaichuanRtspServer] FFmpeg stdin closed for client ${clientId}`);
            break;
          }
          if (frame.audio) continue;
          if (frame.data.length === 0) continue;
          
          frameCount++;
          if (frameCount % 100 === 0) {
            console.log(`[BaichuanRtspServer] Sent ${frameCount} frames to client ${clientId} (frame size: ${frame.data.length} bytes)`);
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
          
          try {
            if (ffmpeg.stdin) {
              const written = ffmpeg.stdin.write(frame.data);
              if (!written) {
                await new Promise<void>((resolve) => {
                  if (ffmpeg.stdin) {
                    ffmpeg.stdin.once("drain", () => resolve());
                  } else {
                    resolve();
                  }
                });
              }
            }
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'EPIPE') {
              console.log(`[BaichuanRtspServer] EPIPE writing to ffmpeg for client ${clientId}`);
              break;
            }
            console.error(`[BaichuanRtspServer] Error writing frame to ffmpeg for client ${clientId}:`, error);
          }
        }
        console.log(`[BaichuanRtspServer] Finished feeding frames to client ${clientId} (total: ${frameCount} frames)`);
      } catch (error) {
        console.error(`[BaichuanRtspServer] Error in feedFrames for client ${clientId}:`, error);
      }
    };
    
    feedFrames().catch((error) => {
      console.error(`[BaichuanRtspServer] Error feeding frames to client ${clientId}:`, error);
    });
    
    // Log ffmpeg errors
    ffmpeg.stderr?.on("data", (data: Buffer) => {
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

    console.log(`[BaichuanRtspServer] Starting native stream for profile ${this.profile}`);
    this.nativeStreamActive = true;
    // Note: Each client creates its own generator in startClientFfmpeg, so we don't need a shared one here
  }

  /**
   * Stop native stream (mark as inactive).
   */
  private stopNativeStream(): void {
    if (!this.nativeStreamActive) {
      return;
    }

    console.log(`[BaichuanRtspServer] Stopping native stream`);
    this.nativeStreamActive = false;
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
   * Wait until RTSP server is ready to accept connections.
   */
  async waitUntilReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.clientConnectionServer) {
        reject(new Error("RTSP server not started"));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for RTSP server to be ready"));
      }, 10000);

      // Check if port is listening
      const checkPort = () => {
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.on("connect", () => {
          socket.destroy();
          clearTimeout(timeout);
          resolve();
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
