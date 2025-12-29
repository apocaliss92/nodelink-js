/**
 * Baichuan Video Stream - Builds a video stream from the native Baichuan protocol.
 *
 * Based on neolink: receives video frames via `push` events and exposes them as access units.
 *
 * Reference: neolink crates/core/src/bc_protocol/*
 */

import { BaichuanClient } from "../../client/BaichuanClient";
import type { BaichuanFrame } from "../../protocol/framing";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StreamProfile } from "../../reolink/baichuan/types";
import type { ReolinkBaichuanApi } from "../../reolink/baichuan/ReolinkBaichuanApi";
import type { EncryptionProtocol } from "../../protocol/crypto";
import { ensureDumpDir } from "../../debug/DebugConfig";
import { BcMediaCodec } from "./BcMediaCodec";
import { convertToAnnexB, hasStartCodes, H264RtpDepacketizer, isValidH264AnnexBAccessUnit, isH264KeyframeAnnexB, splitAnnexBToNalPayloads } from "./H264Converter";
import { convertToAnnexB as convertH265ToAnnexB, isValidH265AnnexBAccessUnit, isH265KeyframeAnnexB, splitAnnexBToNalPayloads as splitH265AnnexBToNalPayloads, extractVpsFromAnnexB, extractSpsFromAnnexB, extractPpsFromAnnexB, getH265NalType } from "./H265Converter";

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
  private spsById = new Map<number, Buffer>(); // NAL payload (without start code) - H.264
  private ppsById = new Map<number, { nal: Buffer; spsId: number }>(); // NAL payload + mapping - H.264
  private lastSps: Buffer | null = null; // H.264
  private lastPps: Buffer | null = null; // H.264
  private lastPrependedPpsId: number | null = null; // H.264
  // H.265 parameter sets
  private lastVps: Buffer | null = null; // H.265 VPS
  private lastSpsH265: Buffer | null = null; // H.265 SPS
  private lastPpsH265: Buffer | null = null; // H.265 PPS
  private lastPrependedParamSetsH265 = false; // Track if we've prepended H.265 param sets
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
    // Debug is configured on the client; the library must not read env vars.
    const dbg = this.client.getDebugConfig();
    this.debugH264LogsLeft = dbg.debugH264 ? 200 : 0;
    this.debugSavedSamples = false;
    this.dumpChunkIdx = 0;
    this.spsById = new Map();
    this.ppsById = new Map();
    this.lastSps = null;
    this.lastPps = null;
    this.lastPrependedPpsId = null;
    // H.265 parameter sets
    this.lastVps = null;
    this.lastSpsH265 = null;
    this.lastPpsH265 = null;
    this.lastPrependedParamSetsH265 = false;
  }

  /**
   * Start video stream.
   * Listens to `push` events and processes cmd_id=3 frames carrying BcMedia packets.
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

    // Listen to push events carrying BcMedia packets (cmd_id=3).
    let totalFramesReceived = 0;
    let totalMediaPackets = 0;
    this.videoFrameHandler = (frame: BaichuanFrame) => {
      // Only cmd_id=3 frames carry the media stream.
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

      // If the payload still contains XML+binary (missing payloadOffset), strip XML as a fallback.
      let dataToParse = rawCandidate;
      if (frame.payload.length === 0) {
        let searchStart = 0;
        const extensionEnd = rawCandidate.indexOf(Buffer.from("</Extension>"));
        const bodyEnd = rawCandidate.indexOf(Buffer.from("</body>"));
        if (extensionEnd !== -1) searchStart = extensionEnd + Buffer.from("</Extension>").length;
        else if (bodyEnd !== -1) searchStart = bodyEnd + Buffer.from("</body>").length;
        dataToParse = rawCandidate.subarray(searchStart);
      }

      // If the session uses encryption, some models send an encrypted stream at the frame level.
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

      const dbg = this.client.getDebugConfig();
      if (dbg.dumpEnabled) ensureDumpDir(dbg);

      // Dumps the exact chunks fed to the BcMedia decoder (neolink-style payload_stream()).
      if (dbg.dumpBcMedia && this.dumpChunkIdx < 200) {
        try {
          const outDir = dbg.dumpDir;
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
      // BcMediaCodec only handles transport fragmentation, not "half frames".
      let videoFramesEmitted = 0;
      let audioFramesEmitted = 0;
      
      for (const media of mediaPackets) {
        const maybeCacheParamSets = (annexB: Buffer, source: "Iframe" | "Pframe", videoType: "H264" | "H265") => {
          // Some models send parameter sets outside of I-frames (e.g. parameter set updates),
          // so we always allow caching from both I-frames and P-frames.

          if (videoType === "H264") {
            const nals = splitAnnexBToNalPayloads(annexB);
            for (const nal of nals) {
              const t = (nal[0] ?? 0) & 0x1f;
              if (t === 7) {
                const id = parseSpsIdFromNal(nal);
                if (id != null) {
                  if (!isPlausibleH264Sps(nal)) continue;
                  this.spsById.set(id, nal);
                  if (dbg.debugParamSets) {
                    console.warn(`[BaichuanVideoStream] Cached H.264 SPS id=${id} len=${nal.length}`);
                  }
                }
                if (isPlausibleH264Sps(nal)) this.lastSps = nal;
              }
              if (t === 8) {
                const ids = parsePpsIdsFromNal(nal);
                if (ids) {
                  // If the PPS points to an implausible SPS, drop it.
                  const sps = this.spsById.get(ids.spsId);
                  if (sps && !isPlausibleH264Sps(sps)) continue;
                  this.ppsById.set(ids.ppsId, { nal, spsId: ids.spsId });
                  if (dbg.debugParamSets) {
                    console.warn(`[BaichuanVideoStream] Cached H.264 PPS id=${ids.ppsId} (spsId=${ids.spsId}) len=${nal.length}`);
                  }
                }
                this.lastPps = nal;
              }
            }
          } else if (videoType === "H265") {
            // Cache H.265 parameter sets (VPS, SPS, PPS)
            const vps = extractVpsFromAnnexB(annexB);
            if (vps) {
              this.lastVps = vps;
              if (dbg.debugParamSets) {
                console.warn(`[BaichuanVideoStream] Cached H.265 VPS len=${vps.length}`);
              }
            }
            const sps = extractSpsFromAnnexB(annexB);
            if (sps) {
              this.lastSpsH265 = sps;
              if (dbg.debugParamSets) {
                console.warn(`[BaichuanVideoStream] Cached H.265 SPS len=${sps.length}`);
              }
            }
            const pps = extractPpsFromAnnexB(annexB);
            if (pps) {
              this.lastPpsH265 = pps;
              if (dbg.debugParamSets) {
                console.warn(`[BaichuanVideoStream] Cached H.265 PPS len=${pps.length}`);
              }
            }
          }
        };

        const prependParamSetsIfNeeded = (annexB: Buffer, videoType: "H264" | "H265"): Buffer => {
          if (videoType === "H264") {
            const nals = splitAnnexBToNalPayloads(annexB);
            if (nals.length === 0) return annexB;
            const types = nals.map((n) => ((n[0] ?? 0) & 0x1f));
            // If it already includes SPS/PPS, do not prepend
            if (types.includes(7) && types.includes(8)) return annexB;
            // If there is no VCL, there's nothing to prepend to.
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
            if (dbg.debugParamSets) {
              console.warn(`[BaichuanVideoStream] Slice references ppsId=${ppsId ?? "?"} lastPrepended=${this.lastPrependedPpsId ?? "?"}`);
            }

            // If we can't parse it, be conservative: only use the last seen SPS/PPS once at the beginning.
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
            // If the slice references a PPS we don't have, we cannot "invent it".
            // Drop the access unit until the correct PPS arrives (prevents black/garbled video).
            return Buffer.alloc(0);
          } else if (videoType === "H265") {
            // For H.265, prepend VPS, SPS, PPS if not already present
            const nals = splitH265AnnexBToNalPayloads(annexB);
            if (nals.length === 0) return annexB;
            
            const types = nals.map((n) => getH265NalType(n)).filter((t): t is number => t !== null);
            // If it already includes VPS/SPS/PPS, do not prepend
            if (types.includes(32) && types.includes(33) && types.includes(34)) return annexB;
            
            // If there is no VCL (IRAP or non-IRAP picture), there's nothing to prepend to.
            const hasVcl = types.some((t) => (t >= 0 && t <= 9) || (t >= 16 && t <= 23));
            if (!hasVcl) return annexB;
            
            // Only prepend once to avoid duplication
            if (this.lastPrependedParamSetsH265) return annexB;
            
            // Prepend VPS, SPS, PPS if we have them
            if (!this.lastVps || !this.lastSpsH265 || !this.lastPpsH265) return annexB;
            
            this.lastPrependedParamSetsH265 = true;
            if (dbg.debugParamSets) {
              console.warn(`[BaichuanVideoStream] Prepending H.265 VPS/SPS/PPS to frame`);
            }
            return Buffer.concat([
              NAL_START_CODE_4B, this.lastVps,
              NAL_START_CODE_4B, this.lastSpsH265,
              NAL_START_CODE_4B, this.lastPpsH265,
              annexB
            ]);
          }
          return annexB;
        };

        const dumpNalSummary = (annexB: Buffer, label: string, microseconds: number) => {
          if (!dbg.dumpNals) return;
          try {
            if (dbg.dumpEnabled) ensureDumpDir(dbg);
            const outDir = dbg.dumpDir;
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

        // Media payloads are expected to be plaintext here because we select the best
        // raw vs decrypted candidate before running BcMedia decoding (neolink-style).
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
        if (media.type === "Iframe") {
          // Convert to Annex-B format (different converters for H.264 and H.265)
          const annexBData = media.videoType === "H265" 
            ? convertH265ToAnnexB(media.data)
            : convertToAnnexB(media.data);
          const isKeyframe = true;

          maybeCacheParamSets(annexBData, "Iframe", media.videoType);
          const outAnnex = prependParamSetsIfNeeded(annexBData, media.videoType);
          if (outAnnex.length === 0) continue;
          dumpNalSummary(outAnnex, "Iframe", media.microseconds);

          // Guard rail: do not emit invalid keyframes (prevents cascading parameter set issues)
          if (media.videoType === "H264") {
            if (!isValidH264AnnexBAccessUnit(outAnnex) || !isH264KeyframeAnnexB(outAnnex)) {
              if (dbg.debugH264) {
                console.warn(`[BaichuanVideoStream] Dropping invalid H.264 Iframe (Annex-B) len=${outAnnex.length}`);
              }
              continue;
            }
          } else if (media.videoType === "H265") {
            // For H.265, validate access unit and check for keyframe (IRAP with VPS/SPS/PPS)
            if (!isValidH265AnnexBAccessUnit(outAnnex)) {
              if (dbg.debugH264) {
                console.warn(`[BaichuanVideoStream] Dropping invalid H.265 Iframe (Annex-B) len=${outAnnex.length}`);
              }
              continue;
            }
            // Check if it's a proper keyframe (should have VPS/SPS/PPS and IRAP)
            if (!isH265KeyframeAnnexB(outAnnex)) {
              if (dbg.debugH264) {
                console.warn(`[BaichuanVideoStream] H.265 Iframe missing VPS/SPS/PPS or IRAP, but continuing len=${outAnnex.length}`);
              }
              // Continue anyway - the parameter sets might be prepended
            }
          }

          // Save a one-off sample for offline analysis
          if (dbg.debugH264 && !this.debugSavedSamples) {
            try {
              const outDir = dbg.dumpDir;
              fs.mkdirSync(outDir, { recursive: true });
              if (media.type === "Iframe" && hasStartCodes(annexBData)) {
                fs.writeFileSync(path.join(outDir, "iframe_annexb.bin"), annexBData);
              }
            } catch {
              // do not block streaming for debug
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
          const chunk = media.data;

          // P-frame: often not a complete access unit but an "RTP-like" payload (FU-A/STAP)
          // which must be depacketized with state. Do NOT run AVCC heuristics before depacketizing.
          // First try AVCC/HVCC -> AnnexB (some models send P-frames length-prefixed).
          // If we still don't get start codes, try RFC6184 depacketizer (FU-A/STAP) for H.264.
          // Note: H.265 RTP depacketization is similar but uses different NAL unit types.
          const annexBOrRaw = hasStartCodes(chunk) 
            ? chunk 
            : (media.videoType === "H265" ? convertH265ToAnnexB(chunk) : convertToAnnexB(chunk));
          
          // For H.264, use the depacketizer. For H.265, we might need a similar depacketizer in the future.
          const parts = hasStartCodes(annexBOrRaw) 
            ? [annexBOrRaw] 
            : (media.videoType === "H265" ? [annexBOrRaw] : this.depacketizer.push(chunk));
          
          if (parts.length === 0) {
            // incomplete fragment (FU-A mid) or unrecognized payload: wait for more packets
            continue;
          }

          for (const p of parts) {
            maybeCacheParamSets(p, "Pframe", media.videoType);
            const outP0 = prependParamSetsIfNeeded(p, media.videoType);
            if (outP0.length === 0) continue;
            const outP = outP0;
            dumpNalSummary(outP, "Pframe", media.microseconds);
            // Guard rail: drop only if the access unit is invalid (codec-specific)
            const isValid =
              media.videoType === "H265" ? isValidH265AnnexBAccessUnit(outP) : isValidH264AnnexBAccessUnit(outP);
            if (!isValid) {
              if (dbg.debugH264 && this.debugH264LogsLeft > 0) {
                this.debugH264LogsLeft--;
                const head = outP.subarray(0, Math.min(24, outP.length)).toString("hex");
                console.warn(`[BaichuanVideoStream] Dropping invalid Pframe (${media.videoType}): len=${outP.length} head=${head}`);
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
    
    // Note: stream-level decipher is not used here; we pick decrypted/raw before BcMedia decoding.
    
    // Clear codec buffer
    this.bcMediaCodec.clear();

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

