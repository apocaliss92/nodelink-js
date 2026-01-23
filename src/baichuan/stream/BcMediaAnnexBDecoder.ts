import type { Logger } from "../../debug/DebugConfig";
import { BcMediaCodec } from "./BcMediaCodec";
import type { BcMedia, BcMediaInfoV1, BcMediaInfoV2 } from "./BcMediaParser";
import {
  convertToAnnexB as convertH264ToAnnexB,
  isH264KeyframeAnnexB,
  splitAnnexBToNalPayloads as splitH264AnnexBToNalPayloads,
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

export type BcMediaAnnexBDecoderStats = {
  bytesIn: number;
  bytesOut: number;
  packets: number;
  videoPackets: number;
  audioPackets: number;
  keyframes: number;
  videoType: BcMediaVideoType | null;
  infos: BcMediaAnnexBInfo[];
  recoveredSkips: number;
};

export class BcMediaAnnexBDecoder {
  private readonly codec: BcMediaCodec;
  private readonly logger: Logger | undefined;
  private readonly onVideoAccessUnit:
    | ((p: {
    videoType: BcMediaVideoType;
    annexB: Buffer;
    microseconds: number;
    isKeyframe: boolean;
  }) => void)
    | undefined;

  private stats: BcMediaAnnexBDecoderStats = {
    bytesIn: 0,
    bytesOut: 0,
    packets: 0,
    videoPackets: 0,
    audioPackets: 0,
    keyframes: 0,
    videoType: null,
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
    onVideoAccessUnit?: (p: {
      videoType: BcMediaVideoType;
      annexB: Buffer;
      microseconds: number;
      isKeyframe: boolean;
    }) => void;
  }) {
    this.logger = params?.logger;
    this.onVideoAccessUnit = params?.onVideoAccessUnit;
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

    if (media.type === "Aac" || media.type === "Adpcm") {
      this.stats.audioPackets++;
      return;
    }

    if (media.type !== "Iframe" && media.type !== "Pframe") return;

    this.stats.videoPackets++;

    const videoType: BcMediaVideoType = media.videoType;
    if (this.stats.videoType == null) this.stats.videoType = videoType;

    const microseconds = media.microseconds;
    const raw = media.data;

    let annexB = videoType === "H265" ? convertH265ToAnnexB(raw) : convertH264ToAnnexB(raw);

    const isKeyframe = media.type === "Iframe" || (videoType === "H265" ? isH265KeyframeAnnexB(annexB) : isH264KeyframeAnnexB(annexB));

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
        const hasSps = nals.some((nal) => (((nal[0] ?? 0) & 0x1f) === 7));
        const hasPps = nals.some((nal) => (((nal[0] ?? 0) & 0x1f) === 8));
        const toPrepend: Buffer[] = [];
        if (!hasSps && this.lastH264Sps) toPrepend.push(ANNEXB_START_CODE_4B, this.lastH264Sps);
        if (!hasPps && this.lastH264Pps) toPrepend.push(ANNEXB_START_CODE_4B, this.lastH264Pps);
        if (toPrepend.length > 0) annexB = Buffer.concat([...toPrepend, annexB]);
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
        if (!hasVps && this.lastH265Vps) toPrepend.push(ANNEXB_START_CODE_4B, this.lastH265Vps);
        if (!hasSps && this.lastH265Sps) toPrepend.push(ANNEXB_START_CODE_4B, this.lastH265Sps);
        if (!hasPps && this.lastH265Pps) toPrepend.push(ANNEXB_START_CODE_4B, this.lastH265Pps);
        if (toPrepend.length > 0) annexB = Buffer.concat([...toPrepend, annexB]);
      }
    }

    if (isKeyframe) this.stats.keyframes++;

    this.stats.bytesOut += annexB.length;
    this.onVideoAccessUnit?.({ videoType, annexB, microseconds, isKeyframe });
  }
}
