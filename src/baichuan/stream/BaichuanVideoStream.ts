/**
 * Baichuan Video Stream - Costruisce uno stream RTSP dal protocollo Baichuan nativo
 * Basato su neolink: riceve frame video via push events e li serve come stream RTSP
 * 
 * Reference: neolink crates/core/src/bc_protocol/*
 */

import { BaichuanClient } from "../../client/BaichuanClient.js";
import type { BaichuanFrame } from "../../protocol/framing.js";
import { EventEmitter } from "node:events";
import type { StreamProfile } from "../../reolink/baichuan/types.js";
import type { ReolinkBaichuanApi } from "../../reolink/baichuan/ReolinkBaichuanApi.js";
import { BcMediaCodec } from "./BcMediaCodec.js";

export interface BaichuanVideoStreamOptions {
  client: BaichuanClient;
  api?: ReolinkBaichuanApi; // Optional API for requesting stream
  channel: number;
  profile: StreamProfile; // "main" | "sub" | "ext"
}

/**
 * BaichuanVideoStream - Gestisce lo streaming video via Baichuan protocol
 * 
 * I frame video arrivano come push events dal BaichuanClient.
 * Questo stream riceve i frame, li decodifica e li serve come stream RTSP.
 * 
 * Basato su neolink: i frame video hanno:
 * - cmd_id specifico per lo stream (da identificare)
 * - streamType = 0 per video (probabilmente)
 * - body contiene dati video H.264/H.265 incapsulati
 */
export class BaichuanVideoStream extends EventEmitter<{
  videoFrame: [Buffer]; // Frame video decodificato (H.264/H.265 NAL units)
  audioFrame: [Buffer]; // Frame audio (se presente)
  error: [Error];
  close: [];
}> {
  private client: BaichuanClient;
  private api: ReolinkBaichuanApi | undefined;
  private channel: number;
  private profile: StreamProfile;
  private active = false;
  private videoFrameHandler: ((frame: BaichuanFrame) => void) | undefined;
  private bcMediaCodec: BcMediaCodec;

  constructor(options: BaichuanVideoStreamOptions) {
    super();
    this.client = options.client;
    this.api = options.api;
    this.channel = options.channel;
    this.profile = options.profile;
    this.bcMediaCodec = new BcMediaCodec(false); // non-strict mode for error recovery
  }

  /**
   * Start video stream.
   * Ascolta i push events e identifica i frame video.
   * 
   * Note: Il cmd_id per richiedere lo stream video deve essere identificato.
   * Per ora, ascoltiamo tutti i push events e filtriamo i frame video.
   */
  async start(): Promise<void> {
    if (this.active) {
      throw new Error("Video stream already active");
    }

    // Richiedi lo stream video se API è disponibile
    if (this.api) {
      try {
        await this.api.startVideoStream(this.channel, this.profile);
      } catch (error) {
        // Log error but continue - stream might start automatically
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    }

    // Ascolta i push events per frame video
    // I frame con cmd_id 3 contengono BcMedia packets (video/audio)
    let totalFramesReceived = 0;
    let totalMediaPackets = 0;
    this.videoFrameHandler = (frame: BaichuanFrame) => {
      // Solo frame con cmd_id 3 sono video stream
      if (frame.header.cmdId !== 3) return;
      
      totalFramesReceived++;
      if (totalFramesReceived === 1) {
        console.log(`[BaichuanVideoStream] Primo frame cmd_id 3 ricevuto (bodyLen: ${frame.body.length}, channelId: ${frame.header.channelId})`);
      }

      // Per i frame video, extension e payload sono separati
      // Il payload contiene i dati BcMedia, ma potrebbe essere ancora criptato
      // Decripta il payload separatamente
      let dataToParse: Buffer;
      
      if (frame.payload.length > 0) {
        // Decripta il payload separatamente
        dataToParse = this.client.tryDecryptBinary(
          frame.payload,
          frame.header.channelId,
          this.client.enc
        );
        if (totalFramesReceived === 1) {
          console.log(`[BaichuanVideoStream] Payload decriptato: ${dataToParse.length} bytes, first 32 bytes: ${dataToParse.subarray(0, Math.min(32, dataToParse.length)).toString("hex")}`);
        }
      } else {
        // Fallback: decripta il body completo e cerca i dati dopo XML
        const decrypted = this.client.tryDecryptBinary(
          frame.body,
          frame.header.channelId,
          this.client.enc
        );
        
        // Find where BcMedia packets start (after XML if present)
        let searchStart = 0;
        const extensionEnd = decrypted.indexOf(Buffer.from("</Extension>"));
        const bodyEnd = decrypted.indexOf(Buffer.from("</body>"));
        
        if (extensionEnd !== -1) {
          searchStart = extensionEnd + Buffer.from("</Extension>").length;
        } else if (bodyEnd !== -1) {
          searchStart = bodyEnd + Buffer.from("</body>").length;
        }
        
        dataToParse = decrypted.subarray(searchStart);
      }

      // Use BcMediaCodec to handle fragmented packets
      // The codec buffers incomplete packets and assembles them when complete
      const dataAfterXml = dataToParse;
      if (totalFramesReceived === 1) {
        console.log(`[BaichuanVideoStream] Data after XML: ${dataAfterXml.length} bytes, first 32 bytes: ${dataAfterXml.subarray(0, Math.min(32, dataAfterXml.length)).toString("hex")}`);
      }
      
      const mediaPackets = this.bcMediaCodec.decode(dataAfterXml);
      totalMediaPackets += mediaPackets.length;
      
      if (totalFramesReceived <= 5 && mediaPackets.length > 0) {
        console.log(`[BaichuanVideoStream] Frame #${totalFramesReceived}: parsati ${mediaPackets.length} BcMedia packets (total: ${totalMediaPackets})`);
      }
      
      // Process complete BcMedia packets
      for (const media of mediaPackets) {
        // Emit video frames (Iframe/Pframe)
        if (media.type === "Iframe" || media.type === "Pframe") {
          // The data field contains raw H.264/H.265 NAL units
          this.emit("videoFrame", media.data);
        }
        
        // Emit audio frames
        if (media.type === "Aac" || media.type === "Adpcm") {
          this.emit("audioFrame", media.data);
        }

        // Emit info frames for metadata
        if (media.type === "InfoV1" || media.type === "InfoV2") {
          // Could emit metadata event if needed
        }
      }
    };

    this.client.on("push", this.videoFrameHandler);
    this.active = true;
  }

  // isVideoFrame, isAudioFrame, and extractVideoData are no longer needed
  // BcMediaParser handles all frame parsing and extraction

  /**
   * Stop video stream.
   */
  async stop(): Promise<void> {
    if (!this.active) return;

    if (this.videoFrameHandler) {
      this.client.removeListener("push", this.videoFrameHandler);
    }
    this.videoFrameHandler = undefined;
    
    // Clear codec buffer
    this.bcMediaCodec.clear();

    // Ferma lo stream video se API è disponibile
    if (this.api) {
      try {
        await this.api.stopVideoStream(this.channel, this.profile);
      } catch (error) {
        // Log error but continue
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.active = false;
    this.emit("close");
  }

  isActive(): boolean {
    return this.active;
  }
}

