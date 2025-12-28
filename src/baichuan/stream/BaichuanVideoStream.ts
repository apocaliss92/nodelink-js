/**
 * Baichuan Video Stream - Costruisce uno stream RTSP dal protocollo Baichuan nativo
 * Basato su neolink: riceve frame video via push events e li serve come stream RTSP
 * 
 * Reference: neolink crates/core/src/bc_protocol/*
 */

import { BaichuanClient } from "../../client/BaichuanClient.js";
import type { BaichuanFrame } from "../../protocol/framing.js";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { createDecipheriv } from "node:crypto";
import type { StreamProfile } from "../../reolink/baichuan/types.js";
import type { ReolinkBaichuanApi } from "../../reolink/baichuan/ReolinkBaichuanApi.js";
import { BC_AES_IV } from "../../protocol/constants.js";
import type { EncryptionProtocol } from "../../protocol/crypto.js";
import { BcMediaCodec } from "./BcMediaCodec.js";
import { convertToAnnexB, hasStartCodes, H264RtpDepacketizer, isValidH264AnnexBAccessUnit, isH264KeyframeAnnexB, splitAnnexBToNalPayloads } from "./H264Converter.js";

const NAL_START_CODE_4B = Buffer.from([0x00, 0x00, 0x00, 0x01]);

// --- Minimal H.264 bit parsing helpers (for SPS/PPS IDs + slice pps_id) ---
function removeEmulationPreventionBytes(rbsp: Buffer): Buffer {
  // Remove 0x03 after 00 00 (Annex-B emulation prevention)
  const out: number[] = [];
  for (let i = 0; i < rbsp.length; i++) {
    if (i >= 2 && rbsp[i] === 0x03 && rbsp[i - 1] === 0x00 && rbsp[i - 2] === 0x00) {
      continue;
    }
    out.push(rbsp[i]!);
  }
  return Buffer.from(out);
}

class BitReader {
  private readonly b: Buffer;
  private bitPos = 0;
  constructor(buf: Buffer) {
    this.b = buf;
  }
  readBits(n: number): number | null {
    if (n <= 0) return 0;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const bytePos = this.bitPos >> 3;
      if (bytePos >= this.b.length) return null;
      const bitInByte = 7 - (this.bitPos & 7);
      const bit = (this.b[bytePos]! >> bitInByte) & 1;
      v = (v << 1) | bit;
      this.bitPos++;
    }
    return v >>> 0;
  }
  readUE(): number | null {
    // unsigned Exp-Golomb
    let zeros = 0;
    while (true) {
      const bit = this.readBits(1);
      if (bit == null) return null;
      if (bit === 0) zeros++;
      else break;
      if (zeros > 31) return null;
    }
    const rest = zeros ? this.readBits(zeros) : 0;
    if (rest == null) return null;
    return ((1 << zeros) - 1 + rest) >>> 0;
  }
}

function parseSpsIdFromNal(nalPayload: Buffer): number | null {
  // nalPayload includes nal header byte (type=7)
  if (((nalPayload[0] ?? 0) & 0x1f) !== 7) return null;
  const rbsp = removeEmulationPreventionBytes(nalPayload.subarray(1));
  const r = new BitReader(rbsp);
  // profile_idc (8), constraint flags+reserved (8), level_idc (8)
  if (r.readBits(8) == null) return null;
  if (r.readBits(8) == null) return null;
  if (r.readBits(8) == null) return null;
  return r.readUE();
}

function parsePpsIdsFromNal(nalPayload: Buffer): { ppsId: number; spsId: number } | null {
  if (((nalPayload[0] ?? 0) & 0x1f) !== 8) return null;
  const rbsp = removeEmulationPreventionBytes(nalPayload.subarray(1));
  const r = new BitReader(rbsp);
  const ppsId = r.readUE();
  const spsId = r.readUE();
  if (ppsId == null || spsId == null) return null;
  return { ppsId, spsId };
}

function parseSlicePpsIdFromNal(nalPayload: Buffer): number | null {
  const t = (nalPayload[0] ?? 0) & 0x1f;
  if (t !== 1 && t !== 5) return null;
  const rbsp = removeEmulationPreventionBytes(nalPayload.subarray(1));
  const r = new BitReader(rbsp);
  // first_mb_in_slice, slice_type, pic_parameter_set_id
  if (r.readUE() == null) return null;
  if (r.readUE() == null) return null;
  return r.readUE();
}

export interface BaichuanVideoStreamOptions {
  client: BaichuanClient;
  api?: ReolinkBaichuanApi; // Optional API for requesting stream
  channel: number;
  profile: StreamProfile; // "main" | "sub" | "ext"
}

/**
 * BaichuanVideoStream - Handles video streaming via the Baichuan protocol.
 *
 * Video frames arrive as `push` events from `BaichuanClient`.
 * This stream receives frames, decodes BcMedia packets and emits H.264/H.265 access units.
 *
 * Based on neolink:
 * - cmd_id is the stream message id (typically 3)
 * - streamType: 0 for main/ext, 1 for sub
 * - body/payload contains embedded BcMedia packets (H.264/H.265 + audio)
 */
export class BaichuanVideoStream extends EventEmitter<{
  videoFrame: [Buffer]; // Decoded video frame (H.264/H.265 Annex-B access unit)
  /**
   * Richer (non-breaking) event: access unit with metadata.
   * Useful for servers (HTTP/RTSP) to wait for a keyframe and/or prepend SPS/PPS.
   */
  videoAccessUnit: [{
    data: Buffer;
    isKeyframe: boolean;
    videoType: "H264" | "H265";
    microseconds: number;
    time?: number;
  }];
  audioFrame: [Buffer]; // Audio frame (if present)
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
  private debugH264LogsLeft: number;
  private debugSavedSamples: boolean;
  // "RTP-like" depacketizer (some models encapsulate NAL units in FU-A/STAP)
  private readonly depacketizer = new H264RtpDepacketizer();
  private dumpChunkIdx = 0;
  private pframeStreamDecipher: ReturnType<typeof createDecipheriv> | null = null;
  private spsById = new Map<number, Buffer>(); // NAL payload (without start code)
  private ppsById = new Map<number, { nal: Buffer; spsId: number }>(); // NAL payload + mapping
  private lastSps: Buffer | null = null;
  private lastPps: Buffer | null = null;
  private lastPrependedPpsId: number | null = null;
  // Note: reassembly happens at the BcMediaCodec transport level, so we do not
  // accumulate frames here (same approach as neolink).

  private static scoreBcMediaLike(b: Buffer): { score: number; first: number } {
    if (b.length < 4) return { score: -1, first: -1 };
    const maxScan = Math.min(64 * 1024, b.length - 4);
    let count = 0;
    let first = -1;
    for (let i = 0; i <= maxScan; i++) {
      const magic = b.readUInt32LE(i);
      const isInfoV1 = magic === 0x31303031; // "1001"
      const isInfoV2 = magic === 0x32303031; // "1002"
      const isIFrame = magic >= 0x63643030 && magic <= 0x63643039; // "cd00".."cd09"
      const isPFrame = magic >= 0x63643130 && magic <= 0x63643139; // "cd10".."cd19"
      const isAac = magic === 0x62773530; // "bw50"
      const isAdpcm = magic === 0x62773130; // "bw10"
      if (isInfoV1 || isInfoV2 || isIFrame || isPFrame || isAac || isAdpcm) {
        count++;
        if (first < 0) first = i;
        if (count > 32 && first === 0) break;
      }
    }
    return { score: count * 1000 - (first < 0 ? 50000 : first), first };
  }

  private chooseDecryptedOrRawCandidate(params: { raw: Buffer; enc: EncryptionProtocol; channelId: number }): Buffer {
    const { raw, enc, channelId } = params;
    const rawScore = BaichuanVideoStream.scoreBcMediaLike(raw);
    const dec =
      this.client.enc.kind === "aes" || this.client.enc.kind === "full_aes" || this.client.enc.kind === "bc"
        ? this.client.tryDecryptBinary(raw, channelId, enc)
        : raw;
    const decScore = BaichuanVideoStream.scoreBcMediaLike(dec);
    const chosen = decScore.score > rawScore.score ? dec : raw;
    const best = BaichuanVideoStream.scoreBcMediaLike(chosen);
    return best.first > 0 ? chosen.subarray(best.first) : chosen;
  }

  constructor(options: BaichuanVideoStreamOptions) {
    super();
    this.client = options.client;
    this.api = options.api;
    this.channel = options.channel;
    this.profile = options.profile;
    this.bcMediaCodec = new BcMediaCodec(false); // non-strict mode for error recovery
    this.debugH264LogsLeft = process.env.BAICHUAN_DEBUG_H264 === "1" ? 200 : 0;
    this.debugSavedSamples = false;
    this.dumpChunkIdx = 0;
    this.pframeStreamDecipher = null;
    this.spsById = new Map();
    this.ppsById = new Map();
    this.lastSps = null;
    this.lastPps = null;
    this.lastPrependedPpsId = null;
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

    // Request the video stream if the API is available
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
        console.log(`[BaichuanVideoStream] First cmd_id=3 frame received (bodyLen: ${frame.body.length}, channelId: ${frame.header.channelId})`);
      }
      if (totalFramesReceived % 10 === 0 || totalFramesReceived <= 5) {
        console.log(`[BaichuanVideoStream] Received ${totalFramesReceived} Baichuan frames (cmd_id=3)`);
      }

      // Note (from neolink): the media stream is often NOT encrypted like control messages.
      // So we first try to parse the `payload` directly (if present), and only as a fallback
      // we try stateless decryption.
      const enc = this.client.enc;
      const rawCandidate = frame.payload.length > 0 ? frame.payload : frame.body;

      // Se il payload contiene ancora XML+binary (payloadOffset mancante), togliamo l'XML come fallback.
      let dataToParse = rawCandidate;
      if (frame.payload.length === 0) {
        let searchStart = 0;
        const extensionEnd = rawCandidate.indexOf(Buffer.from("</Extension>"));
        const bodyEnd = rawCandidate.indexOf(Buffer.from("</body>"));
        if (extensionEnd !== -1) searchStart = extensionEnd + Buffer.from("</Extension>").length;
        else if (bodyEnd !== -1) searchStart = bodyEnd + Buffer.from("</body>").length;
        dataToParse = rawCandidate.subarray(searchStart);
      }

      // Se la sessione usa cifratura, alcuni modelli inviano lo stream cifrato “a livello frame”.
      // If we find a BcMedia magic in the raw payload, it's not a guarantee the content is NOT encrypted
      // (it can be a false positive). So we also try stateless decryption and pick
      // the most "BcMedia-like" candidate (neolink decrypts before deserializing).

      const dataAfterXml = this.chooseDecryptedOrRawCandidate({
        raw: dataToParse,
        enc,
        channelId: frame.header.channelId,
      });
      if (totalFramesReceived === 1) {
        console.log(`[BaichuanVideoStream] Data after XML: ${dataAfterXml.length} bytes, first 32 bytes: ${dataAfterXml.subarray(0, Math.min(32, dataAfterXml.length)).toString("hex")}`);
      }

      // Dump dei chunk esatti che vengono passati al decoder BCMedia (stile neolink payload_stream()).
      // Abilita con BAICHUAN_DUMP_BCMEDIA=1. Output sotto test/frames-debug/.
      if (process.env.BAICHUAN_DUMP_BCMEDIA === "1" && this.dumpChunkIdx < 200) {
        try {
          const outDir = path.join(process.cwd(), "test", "frames-debug");
          fs.mkdirSync(outDir, { recursive: true });
          const idx = String(this.dumpChunkIdx).padStart(4, "0");
          fs.writeFileSync(path.join(outDir, `bcmedia_chunk_${idx}.bin`), dataAfterXml);
          if (this.dumpChunkIdx === 0) {
            fs.writeFileSync(
              path.join(outDir, `bcmedia_info.json`),
              JSON.stringify(
                {
                  note: "Chunks fed into the BcMedia decoder (after XML stripping/alignment).",
                  profile: this.profile,
                  channel: this.channel,
                  encKind: this.client.enc.kind,
                },
                null,
                2
              )
            );
          }
          this.dumpChunkIdx++;
        } catch {
          // ignore
        }
      }
      
      const mediaPackets = this.bcMediaCodec.decode(dataAfterXml);
      totalMediaPackets += mediaPackets.length;
      
      // Count packet types
      const packetTypes = new Map<string, number>();
      for (const pkt of mediaPackets) {
        packetTypes.set(pkt.type, (packetTypes.get(pkt.type) || 0) + 1);
      }
      
      // Log detailed info for first few frames and periodically
      if (totalFramesReceived <= 10 || totalFramesReceived % 20 === 0) {
        const remainingBuffer = this.bcMediaCodec.getRemainingBuffer();
        const typesStr = Array.from(packetTypes.entries()).map(([t, c]) => `${t}:${c}`).join(", ");
        console.log(`[BaichuanVideoStream] Frame #${totalFramesReceived}: dataToParse=${dataAfterXml.length} bytes, parsed ${mediaPackets.length} BcMedia packets (${typesStr || "none"}), total: ${totalMediaPackets}, remaining buffer: ${remainingBuffer.length} bytes`);
      }
      
      // Process complete BcMedia packets.
      // In neolink, each BcMedia::Iframe/Pframe already contains a complete frame (access unit).
      // Il BcMediaCodec gestisce solo frammentazione a livello trasporto, non “mezzi frame”.
      let videoFramesEmitted = 0;
      let audioFramesEmitted = 0;
      
      for (const media of mediaPackets) {
        const maybeCacheParamSets = (annexB: Buffer, source: "Iframe" | "Pframe") => {
          // Guardrail: alcuni modelli mandano SPS/PPS anche fuori dagli I-frame (es. update param set).
          // Default: consenti cache anche da P-frame, ma puoi disattivare con BAICHUAN_CACHE_PARAMSETS_FROM_PFRAMES=0.
          const allowFromPframe = process.env.BAICHUAN_CACHE_PARAMSETS_FROM_PFRAMES !== "0";
          if (source === "Pframe" && !allowFromPframe) return;

          const nals = splitAnnexBToNalPayloads(annexB);
          for (const nal of nals) {
            const t = (nal[0] ?? 0) & 0x1f;
            if (t === 7) {
              const id = parseSpsIdFromNal(nal);
              if (id != null) {
                if (!isPlausibleH264Sps(nal)) continue;
                this.spsById.set(id, nal);
                if (process.env.BAICHUAN_DEBUG_PARAMSETS === "1") {
                  console.warn(`[BaichuanVideoStream] Cache SPS id=${id} len=${nal.length}`);
                }
              }
              if (isPlausibleH264Sps(nal)) this.lastSps = nal;
            }
            if (t === 8) {
              const ids = parsePpsIdsFromNal(nal);
              if (ids) {
                // Se il PPS punta a uno SPS “assurdo” o non plausibile, scartalo.
                const sps = this.spsById.get(ids.spsId);
                if (sps && !isPlausibleH264Sps(sps)) continue;
                this.ppsById.set(ids.ppsId, { nal, spsId: ids.spsId });
                if (process.env.BAICHUAN_DEBUG_PARAMSETS === "1") {
                  console.warn(`[BaichuanVideoStream] Cache PPS id=${ids.ppsId} (spsId=${ids.spsId}) len=${nal.length}`);
                }
              }
              this.lastPps = nal;
            }
          }
        };

        const filterAnnexBByNalTypes = (annexB: Buffer, source: "Iframe" | "Pframe"): Buffer | null => {
          // Opzionale: drop access-unit che contengono NAL types “anomali” (spesso sintomo di decrypt/depacketize errato).
          // Per questa camera (sub), in pratica ci aspettiamo 1/5 + 6/7/8/9.
          if (process.env.BAICHUAN_STRICT_NAL_TYPES !== "1") return annexB;
          const allowed = source === "Iframe" ? new Set([5, 6, 7, 8, 9]) : new Set([1, 6, 7, 8, 9]);
          const nals = splitAnnexBToNalPayloads(annexB);
          if (nals.length === 0) return null;
          for (const nal of nals) {
            const t = (nal[0] ?? 0) & 0x1f;
            if (!allowed.has(t)) return null;
            if (t === 7 && !isPlausibleH264Sps(nal)) return null;
          }
          return annexB;
        };

        const prependParamSetsIfNeeded = (annexB: Buffer): Buffer => {
          if (process.env.BAICHUAN_PREPEND_SPS_PPS !== "1") return annexB;
          const nals = splitAnnexBToNalPayloads(annexB);
          if (nals.length === 0) return annexB;
          const types = nals.map((n) => ((n[0] ?? 0) & 0x1f));
          // If it already includes SPS/PPS, do not prepend
          if (types.includes(7) && types.includes(8)) return annexB;
          // Se non include VCL, non ha senso prependere
          const hasVcl = types.some((t) => t === 1 || t === 5 || t === 19 || t === 20);
          if (!hasVcl) return annexB;

          // Determine pps_id referenced by the first slice (if present)
          let ppsId: number | null = null;
          for (const nal of nals) {
            const t = (nal[0] ?? 0) & 0x1f;
            if (t === 1 || t === 5) {
              ppsId = parseSlicePpsIdFromNal(nal);
              break;
            }
          }
          if (process.env.BAICHUAN_DEBUG_PARAMSETS === "1") {
            console.warn(`[BaichuanVideoStream] Slice references ppsId=${ppsId ?? "?"} lastPrepended=${this.lastPrependedPpsId ?? "?"}`);
          }

          // Se non riesco a leggerlo, non rischiare: usa fallback (se disponibile) solo all'inizio
          if (ppsId == null || ppsId > 255) {
            if (this.lastPrependedPpsId != null) return annexB;
            if (!this.lastSps || !this.lastPps) return annexB;
            this.lastPrependedPpsId = -1;
            return Buffer.concat([NAL_START_CODE_4B, this.lastSps, NAL_START_CODE_4B, this.lastPps, annexB]);
          }

          // Only prepend when ppsId changes (reduces duplication and instability)
          if (this.lastPrependedPpsId === ppsId) return annexB;

          const pps = this.ppsById.get(ppsId);
          if (pps) {
            const sps = this.spsById.get(pps.spsId);
            if (sps) {
              this.lastPrependedPpsId = ppsId;
              return Buffer.concat([NAL_START_CODE_4B, sps, NAL_START_CODE_4B, pps.nal, annexB]);
            }
          }
          // Se la slice referenzia un PPS che non abbiamo, NON possiamo “inventarlo”.
          // Better to drop this access unit until the correct PPS arrives; otherwise ffmpeg will error and you may get a "gray screen".
          const dropIfMissing = process.env.BAICHUAN_DROP_IF_PPS_MISSING !== "0";
          if (dropIfMissing) return Buffer.alloc(0);

          // fallback (sconsigliato): last seen
          if (!this.lastSps || !this.lastPps) return annexB;
          this.lastPrependedPpsId = ppsId;
          return Buffer.concat([NAL_START_CODE_4B, this.lastSps, NAL_START_CODE_4B, this.lastPps, annexB]);
        };

        const dumpNalSummary = (annexB: Buffer, label: string, microseconds: number) => {
          if (process.env.BAICHUAN_DUMP_NALS !== "1") return;
          try {
            const outDir = path.join(process.cwd(), "test", "frames-debug");
            fs.mkdirSync(outDir, { recursive: true });
            const nals = splitAnnexBToNalPayloads(annexB);
            const types = nals.map((n) => ((n[0] ?? 0) & 0x1f));
            let slicePpsId: number | null = null;
            const spsIds: number[] = [];
            const ppsIds: number[] = [];
            for (const nal of nals) {
              const t = (nal[0] ?? 0) & 0x1f;
              if ((t === 1 || t === 5) && slicePpsId == null) {
                slicePpsId = parseSlicePpsIdFromNal(nal);
              }
              if (t === 7) {
                const id = parseSpsIdFromNal(nal);
                if (id != null) spsIds.push(id);
              }
              if (t === 8) {
                const ids = parsePpsIdsFromNal(nal);
                if (ids) ppsIds.push(ids.ppsId);
              }
            }
            fs.appendFileSync(
              path.join(outDir, "nal_dump.ndjson"),
              JSON.stringify({
                label,
                microseconds,
                len: annexB.length,
                nalTypes: types,
                slicePpsId,
                auSpsIds: spsIds,
                auPpsIds: ppsIds,
                cachedSps: this.spsById.size,
                cachedPps: this.ppsById.size,
                lastPrependedPpsId: this.lastPrependedPpsId,
              }) + "\n"
            );
          } catch {
            // ignore
          }
        };

        const decryptMediaPayloadIfEnabled = (buf: Buffer): Buffer => {
          if (process.env.BAICHUAN_DECRYPT_MEDIA_PAYLOAD !== "1") return buf;
          if (!(this.client.enc.kind === "full_aes" || this.client.enc.kind === "aes")) return buf;
          try {
            const dec = createDecipheriv("aes-128-cfb", this.client.enc.key, BC_AES_IV);
            dec.setAutoPadding(false);
            return Buffer.concat([dec.update(buf), dec.final()]);
          } catch {
            return buf;
          }
        };
        const scoreAnnexB = (annex: Buffer): number => {
          if (!isValidH264AnnexBAccessUnit(annex)) return -1;
          const nals = splitAnnexBToNalPayloads(annex);
          if (nals.length === 0) return -1;
          const types = nals.map((n) => ((n[0] ?? 0) & 0x1f));
          let score = nals.length;
          if (types.includes(7)) score += 5;
          if (types.includes(8)) score += 5;
          if (types.includes(5)) score += 5;
          if (types.includes(1)) score += 2;
          return score;
        };
        const isPlausibleH264Sps = (nal: Buffer): boolean => {
          // nal is a payload without a start code. nal[0] is the NAL header (type=7)
          if (nal.length < 4) return false;
          if (((nal[0] ?? 0) & 0x1f) !== 7) return false;
          const profileIdc = nal[1] ?? 0;
          const levelIdc = nal[3] ?? 0;
          const knownProfiles = new Set([66, 77, 88, 100, 110, 122, 244]);
          if (!knownProfiles.has(profileIdc)) return false;
          if (levelIdc === 0 || levelIdc > 255) return false;
          return true;
        };
        const isPlausibleKeyframe = (annex: Buffer): boolean => {
          if (!isValidH264AnnexBAccessUnit(annex)) return false;
          const nals = splitAnnexBToNalPayloads(annex);
          if (nals.length < 2) return false;
          let sps: Buffer | null = null;
          let pps = false;
          let idr = false;
          for (const n of nals) {
            const t = (n[0] ?? 0) & 0x1f;
            if (t === 7 && !sps) sps = n;
            if (t === 8) pps = true;
            if (t === 5) idr = true;
          }
          if (!sps || !pps || !idr) return false;
          return isPlausibleH264Sps(sps);
        };
        const isPlausiblePframe = (annex: Buffer): boolean => {
          if (!isValidH264AnnexBAccessUnit(annex)) return false;
          const nals = splitAnnexBToNalPayloads(annex);
          if (nals.length === 0) return false;
          const types = nals.map((n) => ((n[0] ?? 0) & 0x1f));
          // alcuni stream possono includere SPS/PPS anche fuori dai keyframe (update parametri).
          if (types.includes(5)) return false; // IDR non dovrebbe arrivare come Pframe
          // accettiamo solo un sottoinsieme “normale” per non prendere falsi positivi su ciphertext
          for (const t of types) {
            if (![1, 6, 7, 8, 9].includes(t)) return false;
          }
          // deve esserci almeno una slice non-IDR o un aggiornamento SPS/PPS
          if (!(types.includes(1) || types.includes(7) || types.includes(8))) return false;
          // if we have an SPS, it must be plausible
          const sps = nals.find((n) => (((n[0] ?? 0) & 0x1f) === 7));
          if (sps && !isPlausibleH264Sps(sps)) return false;
          return true;
        };
        const tryDecryptH264 = (buf: Buffer, wantKeyframe: boolean, additionalHeader?: Buffer): { data: Buffer; annex: Buffer; used: boolean } => {
          if (!(this.client.enc.kind === "aes" || this.client.enc.kind === "full_aes")) {
            const annex = convertToAnnexB(buf);
            return { data: buf, annex, used: false };
          }
          const key = this.client.enc.key;
          const ivCandidates: Buffer[] = [];
          if (Buffer.isBuffer(additionalHeader) && additionalHeader.length >= 16) {
            // try multiple windows because we don't know where the IV is
            ivCandidates.push(additionalHeader.subarray(0, 16));
            if (additionalHeader.length >= 32) ivCandidates.push(additionalHeader.subarray(16, 32));
            ivCandidates.push(additionalHeader.subarray(Math.max(0, additionalHeader.length - 16)));
          }
          ivCandidates.push(BC_AES_IV);

          const baseAnnex = convertToAnnexB(buf);
          const baseScore = scoreAnnexB(baseAnnex);
          let best: { data: Buffer; annex: Buffer; score: number; iv?: Buffer } = { data: buf, annex: baseAnnex, score: baseScore };
          let bestKeyframe: { data: Buffer; annex: Buffer; score: number; iv: Buffer } | null = null;
          let bestPframe: { data: Buffer; annex: Buffer; score: number; iv: Buffer } | null = null;
          for (const iv of ivCandidates) {
            try {
              const dec = createDecipheriv("aes-128-cfb", key, iv);
              dec.setAutoPadding(false);
              const decrypted = Buffer.concat([dec.update(buf), dec.final()]);
              const annex = convertToAnnexB(decrypted);
              const score = scoreAnnexB(annex);
              if (score > best.score) {
                best = { data: decrypted, annex, score, iv };
              }
              if (score >= 3) {
                if (wantKeyframe && isPlausibleKeyframe(annex)) {
                  if (!bestKeyframe || score > bestKeyframe.score) bestKeyframe = { data: decrypted, annex, score, iv };
                }
                if (!wantKeyframe) {
                  if (isPlausiblePframe(annex)) {
                    if (!bestPframe || score > bestPframe.score) bestPframe = { data: decrypted, annex, score, iv };
                  }
                }
              }
            } catch {
              // ignore
            }
          }

          // Explicitly prefer decrypted payload when requested (useful with full_aes where base data "looks" Annex-B but is corrupted).
          const preferDecrypted = process.env.BAICHUAN_PREFER_DECRYPTED_MEDIA === "1";
          if (wantKeyframe && bestKeyframe) {
            if (preferDecrypted || bestKeyframe.score > baseScore) {
              if (process.env.BAICHUAN_DEBUG_H264 === "1") {
                console.warn(`[BaichuanVideoStream] ✅ Iframe decrypt(bestKeyframe) iv=${bestKeyframe.iv.toString("hex").slice(0, 8)}... score=${bestKeyframe.score} baseScore=${baseScore}`);
              }
              return { data: bestKeyframe.data, annex: bestKeyframe.annex, used: true };
            }
          }
          if (!wantKeyframe && bestPframe) {
            if (preferDecrypted || bestPframe.score > baseScore) {
              const types = splitAnnexBToNalPayloads(bestPframe.annex).map((n) => ((n[0] ?? 0) & 0x1f));
              if (process.env.BAICHUAN_DEBUG_H264 === "1") {
                console.warn(`[BaichuanVideoStream] ✅ Pframe decrypt(bestPframe) iv=${bestPframe.iv.toString("hex").slice(0, 8)}... score=${bestPframe.score} baseScore=${baseScore} nalTypes=${types.slice(0, 6).join(",")}`);
              }
              return { data: bestPframe.data, annex: bestPframe.annex, used: true };
            }
          }

          return { data: buf, annex: convertToAnnexB(buf), used: false };
        };

        if (media.type === "Iframe") {
          const addHdr = Buffer.isBuffer((media as any).additionalHeader) ? (media as any).additionalHeader : undefined;
          const raw = decryptMediaPayloadIfEnabled(media.data);
          const annexBData =
            process.env.BAICHUAN_TRY_DECRYPT_IFRAMES === "1"
              ? tryDecryptH264(raw, true, addHdr).annex
              : convertToAnnexB(raw);
          const isKeyframe = true;

          maybeCacheParamSets(annexBData, "Iframe");
          const outAnnex0 = prependParamSetsIfNeeded(annexBData);
          const outAnnex = filterAnnexBByNalTypes(outAnnex0, "Iframe");
          if (!outAnnex) continue;
          dumpNalSummary(outAnnex, "Iframe", media.microseconds);

          // Guard rail: do not emit invalid keyframes (prevents cascading SPS/PPS "out of range")
          if (!isValidH264AnnexBAccessUnit(outAnnex) || !isH264KeyframeAnnexB(outAnnex)) {
            if (process.env.BAICHUAN_DEBUG_H264 === "1") {
              console.warn(`[BaichuanVideoStream] Drop Iframe non valido (Annex-B) len=${outAnnex.length}`);
            }
            continue;
          }

          // Salva 1 volta campioni utili per analisi offline
          if (process.env.BAICHUAN_DEBUG_H264 === "1" && !this.debugSavedSamples) {
            try {
              const outDir = path.join(process.cwd(), "test", "frames-debug");
              fs.mkdirSync(outDir, { recursive: true });
              if (media.type === "Iframe" && hasStartCodes(annexBData)) {
                fs.writeFileSync(path.join(outDir, "iframe_annexb.bin"), annexBData);
              }
            } catch {
              // non bloccare lo streaming per debug
            }
          }

          // Targeted debug: if after conversion we still don't have a start code, the payload is
          // likely not Annex-B nor standard 4-byte AVCC. Log the first bytes to understand the format.
          if (this.debugH264LogsLeft > 0 && !hasStartCodes(annexBData)) {
            this.debugH264LogsLeft--;
            const b = media.data;
            const head = b.subarray(0, Math.min(24, b.length)).toString("hex");
            const headAnnex = annexBData.subarray(0, Math.min(24, annexBData.length)).toString("hex");
            const u32be = b.length >= 4 ? b.readUInt32BE(0) : null;
            const u32le = b.length >= 4 ? b.readUInt32LE(0) : null;
            const u16be = b.length >= 2 ? b.readUInt16BE(0) : null;
            const u16le = b.length >= 2 ? b.readUInt16LE(0) : null;
            const sc4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
            const sc3 = Buffer.from([0x00, 0x00, 0x01]);
            const idx4 = b.indexOf(sc4);
            const idx3 = b.indexOf(sc3);
            const idx4a = annexBData.indexOf(sc4);
            const idx3a = annexBData.indexOf(sc3);
            console.warn(
              `[BaichuanVideoStream][DEBUG] ${media.type} non-AnnexB: len=${b.length} head=${head} ` +
              `u32be=${u32be} u32le=${u32le} u16be=${u16be} u16le=${u16le} ` +
              `idxSC4=${idx4} idxSC3=${idx3} idxSC4a=${idx4a} idxSC3a=${idx3a} annexHead=${headAnnex}`
            );
          }

          this.emit("videoFrame", outAnnex);
          this.emit("videoAccessUnit", {
            data: outAnnex,
            isKeyframe,
            videoType: media.videoType,
            microseconds: media.microseconds,
            ...(media.type === "Iframe" && "time" in media ? (media.time !== undefined ? { time: media.time } : {}) : {}),
          });
                    videoFramesEmitted++;

          if (totalFramesReceived <= 5 || videoFramesEmitted <= 5) {
            const sc = hasStartCodes(annexBData) ? "yes" : "no";
            console.log(
              `[BaichuanVideoStream] Emitted ${media.type} (${media.videoType}) ${media.data.length} bytes -> ${annexBData.length} bytes (Annex-B, startCode:${sc})`
            );
          }
        } else if (media.type === "Pframe") {
          let chunk = decryptMediaPayloadIfEnabled(media.data);

          // Tentativo “best effort” di deoffuscazione: alcuni stream mostrano P-frame che NON sembrano
          // H.264 bytestream (often forbidden bit=1, no start code). In neolink there is
          // il concetto di payload binario con decrypt + encryptLen: qui proviamo una decifratura CFB
          // usando IV dall'additionalHeader (se presente) oppure l'IV default.
          //
          // Abilita questo tentativo con BAICHUAN_TRY_DECRYPT_PFRAMES=1.
          const startsWithStartCode = hasStartCodes(chunk);
          const looksAnnexBValid = startsWithStartCode && isValidH264AnnexBAccessUnit(chunk);
          let looksLikeHasVcl = false;
          if (startsWithStartCode) {
            const nals = splitAnnexBToNalPayloads(chunk);
            looksLikeHasVcl = nals.some((n) => {
              const t = (n[0] ?? 0) & 0x1f;
              return t === 1 || t === 5;
            });
          }

          if (
            process.env.BAICHUAN_TRY_DECRYPT_PFRAMES === "1" &&
            media.videoType === "H264" &&
            (this.client.enc.kind === "aes" || this.client.enc.kind === "full_aes") &&
            // try even if it "looks" Annex-B but is invalid / has no VCL (often a false positive on encrypted data)
            (!startsWithStartCode || !looksAnnexBValid || !looksLikeHasVcl)
          ) {
            const addHdr = Buffer.isBuffer((media as any).additionalHeader) ? (media as any).additionalHeader : undefined;
            const out = tryDecryptH264(chunk, false, addHdr);
            if (out.used) chunk = out.data;
          } else if (
            process.env.BAICHUAN_TRY_STREAM_PFRAME_CFB === "1" &&
            media.videoType === "H264" &&
            (this.client.enc.kind === "aes" || this.client.enc.kind === "full_aes") &&
            this.pframeStreamDecipher &&
            !hasStartCodes(chunk)
          ) {
            // Fallback: decrypt “streaming” (CFB stateful) solo sui P-frame che sembrano random.
            // Questo aiuta se la camera cifra i soli P-frame come stream continuo.
            try {
              const b0 = chunk[0];
              const forbidden = b0 === undefined ? 0 : b0 & 0x80;
              if (forbidden !== 0) {
                chunk = this.pframeStreamDecipher.update(chunk);
                if (process.env.BAICHUAN_DEBUG_H264 === "1") {
                  console.warn(`[BaichuanVideoStream] Pframe stream-decrypt applied len=${chunk.length}`);
                }
              }
            } catch {
              // ignore
            }
          }

          // P-frame: often not a complete access unit but an "RTP-like" payload (FU-A/STAP)
          // which must be depacketized with state. Do NOT run AVCC heuristics before depacketizing.
          // Prima prova conversione AVCC -> AnnexB (alcuni modelli mandano P-frame length-prefixed).
          // Se non otteniamo start code, proviamo il depacketizer RFC6184 (FU-A/STAP).
          const annexBOrRaw = hasStartCodes(chunk) ? chunk : convertToAnnexB(chunk);
          const parts = hasStartCodes(annexBOrRaw) ? [annexBOrRaw] : this.depacketizer.push(chunk);
          if (parts.length === 0) {
            // incomplete fragment (FU-A mid) or unrecognized payload: wait for more packets
            continue;
          }

          for (const p of parts) {
            maybeCacheParamSets(p, "Pframe");
            const outP0 = prependParamSetsIfNeeded(p);
            if (outP0.length === 0) continue;
            const outP = filterAnnexBByNalTypes(outP0, "Pframe");
            if (!outP) continue;
            dumpNalSummary(outP, "Pframe", media.microseconds);
            // Guard rail: drop only if the full NAL is invalid
            if (!isValidH264AnnexBAccessUnit(outP)) {
              if (process.env.BAICHUAN_DEBUG_H264 === "1" && this.debugH264LogsLeft > 0) {
                this.debugH264LogsLeft--;
                const head = outP.subarray(0, Math.min(24, outP.length)).toString("hex");
                console.warn(`[BaichuanVideoStream] Drop Pframe non valido: len=${outP.length} head=${head}`);
              }
              continue;
            }
            this.emit("videoFrame", outP);
            this.emit("videoAccessUnit", {
              data: outP,
              isKeyframe: false,
              videoType: media.videoType,
              microseconds: media.microseconds,
            });
            videoFramesEmitted++;
          }
        }
        
        // Emit audio frames
        if (media.type === "Aac" || media.type === "Adpcm") {
          audioFramesEmitted++;
          this.emit("audioFrame", media.data);
        }

        // Emit info frames for metadata
        if (media.type === "InfoV1" || media.type === "InfoV2") {
          // Could emit metadata event if needed
        }
      }
      
      // Log frame emission stats
      if (totalFramesReceived <= 10 || (totalFramesReceived % 20 === 0 && (videoFramesEmitted > 0 || audioFramesEmitted > 0))) {
        console.log(`[BaichuanVideoStream] Frame #${totalFramesReceived}: emitted ${videoFramesEmitted} video frames, ${audioFramesEmitted} audio frames`);
      }
      
      // Track total video frames emitted
      if (videoFramesEmitted > 0 && (totalFramesReceived <= 10 || totalFramesReceived % 50 === 0)) {
        let totalVideoFrames = 0;
        // Count would need to be tracked separately - for now just log
      }
    };

    this.client.on("push", this.videoFrameHandler);
    // Init decipher persistente (opzionale) per P-frame
    if (
      process.env.BAICHUAN_TRY_STREAM_PFRAME_CFB === "1" &&
      (this.client.enc.kind === "aes" || this.client.enc.kind === "full_aes")
    ) {
      try {
        this.pframeStreamDecipher = createDecipheriv("aes-128-cfb", this.client.enc.key, BC_AES_IV);
        this.pframeStreamDecipher.setAutoPadding(false);
      } catch {
        this.pframeStreamDecipher = null;
      }
    }
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
    
    // (streamAesDecipher rimosso: lo stream video viene trattato come non cifrato, come in neolink)
    
    // Clear codec buffer
    this.bcMediaCodec.clear();
    this.pframeStreamDecipher = null;

    // Stop the video stream if the API is available
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

