import type { ReolinkBaichuanApi } from "../../reolink/baichuan/ReolinkBaichuanApi";
import { splitAnnexBToNalPayloads } from "./H264Converter";
import { extractPpsFromAnnexB, extractSpsFromAnnexB, extractVpsFromAnnexB } from "./H265Converter";

export type RtspTransport = "tcp" | "udp";
export type RtspVideoType = "H264" | "H265";

export type RtspFlowKey = `${RtspTransport}-${RtspVideoType}`;

export interface RtspFlow {
  readonly key: RtspFlowKey;
  readonly transport: RtspTransport;
  readonly videoType: RtspVideoType;

  /** ffmpeg demuxer for stdin. */
  readonly ffmpegFormat: "h264" | "hevc";

  /** SDP rtpmap codec token. */
  readonly sdpCodec: "H264" | "H265";

  /** Called on first frames to extract parameter sets used in SDP. */
  extractParameterSets(accessUnitAnnexB: Buffer): void;

  /** Returns fmtp value (without the leading "a=fmtp:96 "). */
  getFmtp(): { fmtp: string; hasParamSets: boolean };

  /** Called while native stream is active; may keep device awake (UDP/battery). */
  startKeepAlive(api: ReolinkBaichuanApi): Promise<void>;
  stopKeepAlive(): void;
}

function toKey(transport: RtspTransport, videoType: RtspVideoType): RtspFlowKey {
  return `${transport}-${videoType === "H264" ? "h264" : "h265"}` as RtspFlowKey;
}

abstract class BaseFlow implements RtspFlow {
  public readonly key: RtspFlowKey;
  public readonly transport: RtspTransport;
  public readonly videoType: RtspVideoType;
  public abstract readonly ffmpegFormat: "h264" | "hevc";
  public abstract readonly sdpCodec: "H264" | "H265";

  protected keepAliveTimer: NodeJS.Timeout | null = null;

  protected constructor(transport: RtspTransport, videoType: RtspVideoType) {
    this.transport = transport;
    this.videoType = videoType;
    this.key = toKey(transport, videoType);
  }

  async startKeepAlive(api: ReolinkBaichuanApi): Promise<void> {
    if (this.transport !== "udp") return;


    // Battery cams can be sensitive to overlapping keepalive calls.
    // Use a self-scheduling loop to guarantee at most one in-flight ping.
    if (this.keepAliveTimer) return;
    this.keepAliveStopped = false;

    const tick = async () => {
      if (this.keepAliveStopped) return;
      if (this.keepAliveInFlight) return;
      this.keepAliveInFlight = true;
      try {
        await api.ping();
      } catch {
        // Ignore keep-alive errors; stream should continue if possible.
      } finally {
        this.keepAliveInFlight = false;
      }
    };

    this.keepAliveTimer = setInterval(() => {
      void tick();
    }, 2000);
    (this.keepAliveTimer as any)?.unref?.();
  }

  stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this.keepAliveStopped = true;
    this.keepAliveInFlight = false;
  }

  abstract extractParameterSets(accessUnitAnnexB: Buffer): void;
  abstract getFmtp(): { fmtp: string; hasParamSets: boolean };
}

class H264Flow extends BaseFlow {
  public readonly ffmpegFormat = "h264" as const;
  public readonly sdpCodec = "H264" as const;

  private sps: Buffer | null = null;
  private pps: Buffer | null = null;

  public constructor(transport: RtspTransport) {
    super(transport, "H264");
  }

  extractParameterSets(accessUnitAnnexB: Buffer): void {
    const nals = splitAnnexBToNalPayloads(accessUnitAnnexB);
    for (const nal of nals) {
      if (nal.length < 1) continue;
      const nalType = (nal[0] ?? 0) & 0x1f;
      if (nalType === 7 && !this.sps) this.sps = nal;
      if (nalType === 8 && !this.pps) this.pps = nal;
      if (this.sps && this.pps) break;
    }
  }

  getFmtp(): { fmtp: string; hasParamSets: boolean } {
    let fmtp = "packetization-mode=1";
    if (this.sps && this.pps) {
      fmtp += `;sprop-parameter-sets=${this.sps.toString("base64")},${this.pps.toString("base64")}`;
      return { fmtp, hasParamSets: true };
    }
    return { fmtp, hasParamSets: false };
  }
}

class H265Flow extends BaseFlow {
  public readonly ffmpegFormat = "hevc" as const;
  public readonly sdpCodec = "H265" as const;

  private vps: Buffer | null = null;
  private sps: Buffer | null = null;
  private pps: Buffer | null = null;

  public constructor(transport: RtspTransport) {
    super(transport, "H265");
  }

  extractParameterSets(accessUnitAnnexB: Buffer): void {
    const vps = extractVpsFromAnnexB(accessUnitAnnexB);
    const sps = extractSpsFromAnnexB(accessUnitAnnexB);
    const pps = extractPpsFromAnnexB(accessUnitAnnexB);
    if (vps && !this.vps) this.vps = vps;
    if (sps && !this.sps) this.sps = sps;
    if (pps && !this.pps) this.pps = pps;
  }

  getFmtp(): { fmtp: string; hasParamSets: boolean } {
    // RFC 7798 uses sprop-vps/sprop-sps/sprop-pps.
    let fmtp = "";
    if (this.vps && this.sps && this.pps) {
      fmtp = `sprop-vps=${this.vps.toString("base64")};sprop-sps=${this.sps.toString("base64")};sprop-pps=${this.pps.toString("base64")}`;
      return { fmtp, hasParamSets: true };
    }
    return { fmtp, hasParamSets: false };
  }
}

export function createRtspFlow(transport: RtspTransport, videoType: RtspVideoType): RtspFlow {
  if (videoType === "H264") return new H264Flow(transport);
  return new H265Flow(transport);
}
