import type { Logger } from "../../debug/DebugConfig";
import { BcMediaCodec } from "./BcMediaCodec";
import type {
  BcMedia,
  BcMediaAac,
  BcMediaAdpcm,
  BcMediaInfoV1,
  BcMediaInfoV2,
} from "./BcMediaParser";
import {
  convertToAnnexB as convertH264ToAnnexB,
  isH264KeyframeAnnexB,
  splitAnnexBToNalPayloads as splitH264AnnexBToNalPayloads,
  hasStartCodes as hasH264StartCodes,
} from "./H264Converter";
import {
  convertToAnnexB as convertH265ToAnnexB,
  extractPpsFromAnnexB,
  extractSpsFromAnnexB,
  extractVpsFromAnnexB,
  isH265KeyframeAnnexB,
} from "./H265Converter";

const ANNEXB_START_CODE_4B = Buffer.from([0x00, 0x00, 0x00, 0x01]);

export type BcMediaVideoType = "H264" | "H265";
export type BcMediaAudioType = "Aac" | "Adpcm";

/**
 * Detect the actual video codec from raw NAL data.
 * Some cameras report wrong codec (e.g. "H264" but send H.265 data).
 * This function analyzes the NAL header to determine the real codec.
 *
 * @param data - Raw video data (either Annex-B or length-prefixed)
 * @returns Detected codec type or null if detection fails
 */
export function detectVideoCodecFromNal(data: Buffer): BcMediaVideoType | null {
  if (!data || data.length < 5) return null;

  // Find start code (00 00 00 01 or 00 00 01)
  let nalStart = -1;
  for (let i = 0; i < Math.min(data.length - 4, 100); i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 0 && data[i + 3] === 1) {
        nalStart = i + 4;
        break;
      }
      if (data[i + 2] === 1) {
        nalStart = i + 3;
        break;
      }
    }
  }

  // If no start code, try length-prefixed (AVCC/HVCC)
  if (nalStart < 0 && data.length >= 5) {
    // Try 4-byte length prefix
    const len = data.readUInt32BE(0);
    if (len > 0 && len < data.length - 4) {
      nalStart = 4;
    }
  }

  if (nalStart < 0 || nalStart >= data.length) return null;

  const nalByte = data[nalStart];
  if (nalByte === undefined) return null;

  // IMPORTANT: Check H.264 FIRST because H.264 NAL bytes can be misinterpreted as H.265.
  // Example: H.264 NAL byte 0x41 (non-IDR slice, nal_ref_idc=2) would be interpreted as
  // H.265 VPS (type 32) if we check H.265 first. Similarly, 0x21 would appear as H.265 BLA.

  // H.264/AVC: forbidden_zero_bit (bit 7) = 0, nal_ref_idc in bits 5-6, nal_unit_type in bits 0-4
  // NAL types: SPS=7, PPS=8, IDR=5, non-IDR=1
  const forbiddenBit264 = (nalByte >> 7) & 1;
  const h264Type = nalByte & 0x1f;

  if (forbiddenBit264 === 0 && h264Type > 0 && h264Type <= 12) {
    // Strong H.264 indicators: SPS, PPS (these types don't exist in H.265 in the same form)
    if (h264Type === 7 || h264Type === 8) {
      return "H264";
    }
    // IDR slice (type 5) - H.265 type 5 is RADL_R which is rare without VPS/SPS/PPS
    if (h264Type === 5) {
      return "H264";
    }
    // Non-IDR slice (type 1) - need to be more careful here as it could be H.265 TRAIL_R
    // For H.264 non-IDR, nal_ref_idc (bits 5-6) is typically non-zero for reference frames
    // For H.265, the second byte's bits 0-2 contain temporal_id_plus1 which must be 1-7
    if (h264Type === 1) {
      // Additional heuristic: if nal_ref_idc is 2 or 3, strongly prefer H.264
      // H.265 TRAIL_R (type 1) with forbidden=0 would have nalByte values 0x02 or 0x03
      // H.264 non-IDR with nal_ref_idc=2 has nalByte 0x41, with nal_ref_idc=1 has 0x21
      const nalRefIdc = (nalByte >> 5) & 0x03;
      if (nalRefIdc >= 1) {
        return "H264";
      }
    }
  }

  // H.265/HEVC: forbidden_zero_bit (bit 7) = 0, nal_unit_type in bits 1-6
  // NAL types: VPS=32, SPS=33, PPS=34, IDR=19/20, CRA=21, TRAIL=0/1
  // The second byte contains temporal_id_plus1 in bits 0-2 (must be non-zero)
  if (nalStart + 1 < data.length) {
    const nalByte2 = data[nalStart + 1];
    if (nalByte2 !== undefined) {
      const forbiddenBit = (nalByte >> 7) & 1;
      const hevcType = (nalByte >> 1) & 0x3f;
      const temporalId = nalByte2 & 0x07;

      // Valid H.265 NAL: forbidden=0, temporal_id_plus1 > 0, type in valid range
      if (forbiddenBit === 0 && temporalId > 0 && hevcType <= 40) {
        // Strong H.265 indicators: VPS, SPS, PPS (unique to H.265)
        if (hevcType === 32 || hevcType === 33 || hevcType === 34) {
          return "H265";
        }
        // IDR_W_RADL, IDR_N_LP, CRA_NUT
        if (hevcType === 19 || hevcType === 20 || hevcType === 21) {
          return "H265";
        }
        // TRAIL_N (0), TRAIL_R (1) - but only if we didn't already match H.264
        // These are weak indicators since H.264 type 1 is common
        if (hevcType <= 1 && nalByte <= 0x03) {
          // H.265 TRAIL with low NAL byte values (0x00-0x03) are more likely H.265
          return "H265";
        }
      }
    }
  }

  return null;
}

export type BcMediaAnnexBInfo = {
  type: "InfoV1" | "InfoV2";
  videoWidth: number;
  videoHeight: number;
  fps: number;
  startYear: number;
  startMonth: number;
  startDay: number;
  startHour: number;
  startMin: number;
  startSeconds: number;
  endYear: number;
  endMonth: number;
  endDay: number;
  endHour: number;
  endMin: number;
  endSeconds: number;
};

/**
 * Audio frame emitted by the decoder
 */
export type BcMediaAudioFrame = {
  /** Audio codec type */
  audioType: BcMediaAudioType;
  /** Raw audio data (AAC ADTS frames or ADPCM samples) */
  data: Buffer;
};

/**
 * Video frame emitted by the decoder
 */
export type BcMediaVideoFrame = {
  videoType: BcMediaVideoType;
  annexB: Buffer;
  microseconds: number;
  isKeyframe: boolean;
};

export type BcMediaAnnexBDecoderStats = {
  bytesIn: number;
  bytesOut: number;
  audioBytesOut: number;
  packets: number;
  videoPackets: number;
  audioPackets: number;
  aacPackets: number;
  adpcmPackets: number;
  keyframes: number;
  videoType: BcMediaVideoType | null;
  audioType: BcMediaAudioType | null;
  infos: BcMediaAnnexBInfo[];
  recoveredSkips: number;
};

export class BcMediaAnnexBDecoder {
  private readonly codec: BcMediaCodec;
  private readonly logger: Logger | undefined;
  private readonly onVideoAccessUnit:
    | ((p: BcMediaVideoFrame) => void)
    | undefined;
  private readonly onAudioFrame: ((p: BcMediaAudioFrame) => void) | undefined;

  private stats: BcMediaAnnexBDecoderStats = {
    bytesIn: 0,
    bytesOut: 0,
    audioBytesOut: 0,
    packets: 0,
    videoPackets: 0,
    audioPackets: 0,
    aacPackets: 0,
    adpcmPackets: 0,
    keyframes: 0,
    videoType: null,
    audioType: null,
    infos: [],
    recoveredSkips: 0,
  };

  private lastH264Sps: Buffer | null = null;
  private lastH264Pps: Buffer | null = null;

  private lastH265Vps: Buffer | null = null;
  private lastH265Sps: Buffer | null = null;
  private lastH265Pps: Buffer | null = null;

  constructor(params?: {
    strict?: boolean;
    logger?: Logger;
    onVideoAccessUnit?: (p: BcMediaVideoFrame) => void;
    onAudioFrame?: (p: BcMediaAudioFrame) => void;
  }) {
    this.logger = params?.logger;
    this.onVideoAccessUnit = params?.onVideoAccessUnit;
    this.onAudioFrame = params?.onAudioFrame;
    // Default non-strict: cmd143 often has preamble/junk before first magic.
    this.codec = new BcMediaCodec(params?.strict ?? false, this.logger);
  }

  getStats(): BcMediaAnnexBDecoderStats {
    return { ...this.stats, infos: [...this.stats.infos] };
  }

  /**
   * Push arbitrary bytes from a Baichuan/BcMedia transport into the decoder.
   * Emits complete Annex-B access units via callback.
   */
  push(chunk: Buffer): void {
    if (!chunk || chunk.length === 0) return;
    this.stats.bytesIn += chunk.length;

    const packets = this.codec.decode(chunk);
    this.stats.packets += packets.length;

    for (const media of packets) {
      this.handleMedia(media);
    }
  }

  private handleMedia(media: BcMedia): void {
    if (media.type === "InfoV1" || media.type === "InfoV2") {
      const info = media as BcMediaInfoV1 | BcMediaInfoV2;
      this.stats.infos.push({
        type: media.type,
        videoWidth: info.videoWidth,
        videoHeight: info.videoHeight,
        fps: info.fps,
        startYear: info.startYear,
        startMonth: info.startMonth,
        startDay: info.startDay,
        startHour: info.startHour,
        startMin: info.startMin,
        startSeconds: info.startSeconds,
        endYear: info.endYear,
        endMonth: info.endMonth,
        endDay: info.endDay,
        endHour: info.endHour,
        endMin: info.endMin,
        endSeconds: info.endSeconds,
      });
      return;
    }

    // Handle audio packets
    if (media.type === "Aac" || media.type === "Adpcm") {
      const audioMedia = media as BcMediaAac | BcMediaAdpcm;
      this.stats.audioPackets++;

      if (media.type === "Aac") {
        this.stats.aacPackets++;
      } else {
        this.stats.adpcmPackets++;
      }

      // Track first audio type
      if (this.stats.audioType == null) {
        this.stats.audioType = media.type;
      }

      // Emit audio frame if callback is registered
      if (this.onAudioFrame) {
        this.stats.audioBytesOut += audioMedia.data.length;
        this.onAudioFrame({
          audioType: media.type,
          data: audioMedia.data,
        });
      }
      return;
    }

    if (media.type !== "Iframe" && media.type !== "Pframe") return;

    this.stats.videoPackets++;

    const microseconds = media.microseconds;
    const raw = media.data;

    // Detect actual video type from NAL data (some cameras report wrong codec)
    let videoType: BcMediaVideoType = media.videoType;
    const detectedType = detectVideoCodecFromNal(raw);
    if (detectedType != null && detectedType !== videoType) {
      // Camera reported wrong codec - use detected one
      this.logger?.debug?.(
        `[BcMediaAnnexBDecoder] Codec mismatch: reported ${videoType}, detected ${detectedType}`,
      );
      videoType = detectedType;
    }

    if (this.stats.videoType == null) this.stats.videoType = videoType;

    let annexB =
      videoType === "H265"
        ? convertH265ToAnnexB(raw)
        : convertH264ToAnnexB(raw);

    const isKeyframe =
      media.type === "Iframe" ||
      (videoType === "H265"
        ? isH265KeyframeAnnexB(annexB)
        : isH264KeyframeAnnexB(annexB));

    // Update caches from the current access unit.
    if (videoType === "H264") {
      const nals = splitH264AnnexBToNalPayloads(annexB);
      for (const nal of nals) {
        const t = (nal[0] ?? 0) & 0x1f;
        if (t === 7) this.lastH264Sps = nal;
        if (t === 8) this.lastH264Pps = nal;
      }

      // If this looks like a keyframe but is missing SPS/PPS, prepend cached ones.
      if (isKeyframe) {
        const hasSps = nals.some((nal) => ((nal[0] ?? 0) & 0x1f) === 7);
        const hasPps = nals.some((nal) => ((nal[0] ?? 0) & 0x1f) === 8);
        const toPrepend: Buffer[] = [];
        if (!hasSps && this.lastH264Sps)
          toPrepend.push(ANNEXB_START_CODE_4B, this.lastH264Sps);
        if (!hasPps && this.lastH264Pps)
          toPrepend.push(ANNEXB_START_CODE_4B, this.lastH264Pps);
        if (toPrepend.length > 0)
          annexB = Buffer.concat([...toPrepend, annexB]);
      }
    } else {
      const vps = extractVpsFromAnnexB(annexB);
      const sps = extractSpsFromAnnexB(annexB);
      const pps = extractPpsFromAnnexB(annexB);
      if (vps) this.lastH265Vps = vps;
      if (sps) this.lastH265Sps = sps;
      if (pps) this.lastH265Pps = pps;

      if (isKeyframe) {
        const hasVps = vps != null;
        const hasSps = sps != null;
        const hasPps = pps != null;
        const toPrepend: Buffer[] = [];
        if (!hasVps && this.lastH265Vps)
          toPrepend.push(ANNEXB_START_CODE_4B, this.lastH265Vps);
        if (!hasSps && this.lastH265Sps)
          toPrepend.push(ANNEXB_START_CODE_4B, this.lastH265Sps);
        if (!hasPps && this.lastH265Pps)
          toPrepend.push(ANNEXB_START_CODE_4B, this.lastH265Pps);
        if (toPrepend.length > 0)
          annexB = Buffer.concat([...toPrepend, annexB]);
      }
    }

    if (isKeyframe) this.stats.keyframes++;

    this.stats.bytesOut += annexB.length;
    this.onVideoAccessUnit?.({ videoType, annexB, microseconds, isKeyframe });
  }
}
