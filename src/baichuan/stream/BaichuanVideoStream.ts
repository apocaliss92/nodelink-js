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

  constructor(options: BaichuanVideoStreamOptions) {
    super();
    this.client = options.client;
    this.api = options.api;
    this.channel = options.channel;
    this.profile = options.profile;
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
    this.videoFrameHandler = (frame: BaichuanFrame) => {
      // Identifica frame video:
      // - streamType = 0 per video (probabilmente)
      // - body contiene dati binari (non XML)
      // - cmd_id specifico per video stream (da identificare)
      
      const isVideoFrame = this.isVideoFrame(frame);
      
      if (isVideoFrame && frame.body.length > 0) {
        // Decrypt video data
        const decryptedVideo = this.client.tryDecryptBinary(
          frame.body,
          frame.header.channelId,
          this.client.enc
        );

        // Estrai frame video (H.264/H.265 NAL units)
        // I frame video Baichuan sono incapsulati in un header personalizzato
        // Deve essere rimosso per ottenere i NAL units puri
        const videoData = this.extractVideoData(decryptedVideo);
        
        if (videoData.length > 0) {
          this.emit("videoFrame", videoData);
        }
      }

      // Identifica frame audio (se presente nello stream)
      const isAudioFrame = this.isAudioFrame(frame);
      if (isAudioFrame && frame.body.length > 0) {
        const decryptedAudio = this.client.tryDecryptBinary(
          frame.body,
          frame.header.channelId,
          this.client.enc
        );
        this.emit("audioFrame", decryptedAudio);
      }
    };

    this.client.on("push", this.videoFrameHandler);
    this.active = true;
  }

  /**
   * Identifica se un frame è un frame video.
   * Basato su neolink: i frame video arrivano come BcMedia packets con cmd_id 3 (MSG_ID_VIDEO).
   * I frame video contengono NAL units H.264/H.265 incapsulati.
   */
  private isVideoFrame(frame: BaichuanFrame): boolean {
    // I frame video hanno:
    // - cmd_id = 3 (MSG_ID_VIDEO) - questo è il cmd_id per lo stream video
    // - body contiene dati binari (non XML)
    // - dimensione significativa (>100 bytes tipicamente)
    // - streamType può variare (0 per video, 1 per audio nello stesso stream)
    
    if (frame.header.cmdId !== 3) {
      return false; // Solo cmd_id 3 è per video stream
    }
    
    const bodyStr = frame.body.toString("utf8", 0, Math.min(100, frame.body.length));
    const isXml = bodyStr.startsWith("<?xml") || bodyStr.startsWith("<");
    
    // Frame video: non XML, dimensione significativa
    return !isXml && frame.body.length > 100;
  }

  /**
   * Identifica se un frame è un frame audio.
   * Basato su neolink: i frame audio arrivano nello stesso stream video con cmd_id 3.
   * Potrebbero avere streamType = 1 o essere identificati dalla dimensione/pattern.
   */
  private isAudioFrame(frame: BaichuanFrame): boolean {
    // Frame audio nello stesso stream video:
    // - cmd_id = 3 (stesso dello stream video)
    // - streamType potrebbe essere 1 (audio) o identificato da dimensione/pattern
    // - body binario, dimensione tipicamente più piccola dei frame video
    
    if (frame.header.cmdId !== 3) {
      return false; // Solo cmd_id 3 può contenere audio nello stream
    }
    
    const bodyStr = frame.body.toString("utf8", 0, Math.min(100, frame.body.length));
    const isXml = bodyStr.startsWith("<?xml") || bodyStr.startsWith("<");
    
    // Frame audio: non XML, dimensione tipicamente più piccola (ma non sempre)
    // Potrebbe essere identificato meglio analizzando il contenuto
    return !isXml && frame.body.length > 0 && frame.body.length < 10000; // Audio tipicamente più piccolo
  }

  /**
   * Estrae dati video dai frame Baichuan.
   * I frame video Baichuan sono incapsulati in un header personalizzato.
   * Deve essere rimosso per ottenere i NAL units H.264/H.265 puri.
   * 
   * Basato su neolink: i frame video hanno un header Baichuan che deve essere rimosso.
   */
  private extractVideoData(encryptedData: Buffer): Buffer {
    // TODO: Implementare estrazione dati video basata su neolink
    // I frame video Baichuan hanno un header personalizzato che incapsula i NAL units
    // Deve essere rimosso per ottenere i dati video puri
    
    // Per ora, restituiamo i dati così come sono (potrebbe essere necessario rimuovere header)
    // Neolink probabilmente ha una funzione per estrarre i NAL units
    
    return encryptedData;
  }

  /**
   * Stop video stream.
   */
  async stop(): Promise<void> {
    if (!this.active) return;

    if (this.videoFrameHandler) {
      this.client.removeListener("push", this.videoFrameHandler);
    }
    this.videoFrameHandler = undefined;

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

