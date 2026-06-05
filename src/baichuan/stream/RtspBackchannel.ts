import type { Logger } from "../../debug/DebugConfig";
import type { TalkSession } from "../../reolink/baichuan/types";
import {
  alawToPcm16,
  mulawToPcm16,
} from "../../reolink/baichuan/utils/audioMulaw";
import { encodeImaAdpcm } from "../../reolink/baichuan/utils/imaAdpcm";
import { upsamplePcm16 } from "../../reolink/baichuan/utils/audioResample";

/** RTP payload types we accept on the backchannel; PCMU is RFC 3551 PT 0, PCMA PT 8. */
const RTP_PT_PCMU = 0;
const RTP_PT_PCMA = 8;
const RTP_FIXED_HEADER_BYTES = 12;

/** Source rate advertised by RFC 3551 G.711 (PCMU/PCMA). */
const G711_SOURCE_RATE_HZ = 8000;
/** Target rate Reolink TalkAbility advertises ("audioConfig.sampleRate=16000"). */
const TALK_TARGET_RATE_HZ = 16000;

export type BackchannelCodec = "pcmu" | "pcma";

export interface RtspBackchannelOptions {
  /** Lazy opener for the camera talk session. Called once on `start()`. */
  openTalkSession: () => Promise<TalkSession>;
  /** Used for diagnostic messages; defaults to silent. */
  logger?: Logger;
  /**
   * Maximum PCM (16-bit, 16 kHz) bytes to buffer before dropping older samples
   * to keep latency bounded. 96 000 bytes ≈ 3 s of audio at 16 kHz mono — much
   * smaller than that and a momentary stall will starve the camera; much bigger
   * and the operator hears their own voice with a noticeable delay.
   */
  maxPcmBacklogBytes?: number;
  /**
   * Override the auto-detected RTP payload type. Useful for clients that send
   * PCMA without a proper PT header.
   */
  forceCodec?: BackchannelCodec;
}

interface ParsedRtp {
  payloadType: number;
  payload: Buffer;
}

/**
 * Decode an RTP packet header far enough to extract its payload.
 * Returns `null` for malformed packets.
 *
 * Layout per RFC 3550 §5.1:
 *   2 bits V (=2) | 1 bit P | 1 bit X | 4 bits CC | 1 bit M | 7 bits PT | 16 bits seq
 *   32 bits timestamp | 32 bits SSRC | CC * 32 bits CSRC | optional extension | payload
 */
export function parseRtpPacket(packet: Buffer): ParsedRtp | null {
  if (packet.length < RTP_FIXED_HEADER_BYTES) return null;
  const b0 = packet.readUInt8(0);
  const version = b0 >> 6;
  if (version !== 2) return null;
  const padding = (b0 & 0x20) !== 0;
  const extension = (b0 & 0x10) !== 0;
  const csrcCount = b0 & 0x0f;

  const b1 = packet.readUInt8(1);
  const payloadType = b1 & 0x7f;

  let offset = RTP_FIXED_HEADER_BYTES + csrcCount * 4;
  if (offset > packet.length) return null;

  if (extension) {
    if (offset + 4 > packet.length) return null;
    const extensionLengthWords = packet.readUInt16BE(offset + 2);
    offset += 4 + extensionLengthWords * 4;
    if (offset > packet.length) return null;
  }

  let end = packet.length;
  if (padding) {
    if (end - offset < 1) return null;
    const padLength = packet.readUInt8(end - 1);
    if (padLength < 1 || padLength > end - offset) return null;
    end -= padLength;
  }

  if (end <= offset) return null;
  return {
    payloadType,
    payload: packet.subarray(offset, end),
  };
}

/**
 * Pipes RTP PCMU / PCMA audio packets coming from a Frigate-style RTSP RECORD
 * client into a Reolink Baichuan TalkSession.
 *
 * The handler is intentionally I/O-free: the surrounding RTSP server (or any
 * unit test) feeds it RTP packets via `feedRtp()`. Internally it decodes
 * G.711 → PCM16 @ 8 kHz → upsample to 16 kHz → IMA ADPCM blocks → talk session
 * `sendAudio()`, clamping a rolling PCM backlog so a stalled camera socket
 * cannot grow latency unboundedly.
 */
export class RtspBackchannel {
  private session: TalkSession | undefined = undefined;
  private pcmTail = new Int16Array(0); // residual samples below one full ADPCM block
  private pcmBacklogBytes = 0;
  private pumping = false;
  private active = false;
  private starting: Promise<TalkSession> | undefined = undefined;
  private stopping: Promise<void> | undefined = undefined;
  private lastBacklogClampLogMs = 0;
  private rtpPacketsReceived = 0;
  private rtpPacketsDropped = 0;
  private adpcmBlocksSent = 0;
  /** Lazily-set on the first decoded RTP packet so we log the negotiated codec exactly once. */
  private observedCodec: BackchannelCodec | undefined = undefined;
  /** Sampled every `STATS_LOG_INTERVAL_MS` while audio flows. */
  private lastStatsLogMs = 0;
  private lastStatsAdpcmBlocks = 0;
  private lastStatsRtpPackets = 0;
  private startedAtMs = 0;
  private static readonly STATS_LOG_INTERVAL_MS = 5000;

  constructor(private readonly opts: RtspBackchannelOptions) {}

  get isActive(): boolean {
    return this.active;
  }

  get stats(): Readonly<{
    rtpPacketsReceived: number;
    rtpPacketsDropped: number;
    adpcmBlocksSent: number;
  }> {
    return {
      rtpPacketsReceived: this.rtpPacketsReceived,
      rtpPacketsDropped: this.rtpPacketsDropped,
      adpcmBlocksSent: this.adpcmBlocksSent,
    };
  }

  /** Open the underlying TalkSession. Safe to call concurrently; resolves to the same session. */
  async start(): Promise<TalkSession> {
    if (this.session) return this.session;
    if (!this.starting) {
      const openStart = Date.now();
      this.opts.logger?.log?.(
        `[RtspBackchannel] opening TalkSession on camera…`,
      );
      this.starting = (async () => {
        const s = await this.opts.openTalkSession();
        this.session = s;
        this.active = true;
        this.startedAtMs = Date.now();
        this.lastStatsLogMs = this.startedAtMs;
        this.opts.logger?.log?.(
          `[RtspBackchannel] TalkSession opened ` +
            `channel=${s.info.channel} ` +
            `block=${s.info.blockSize} fullBlock=${s.info.fullBlockSize} ` +
            `audioType=${s.info.audioConfig.audioType} ` +
            `sampleRate=${s.info.audioConfig.sampleRate} ` +
            `samplePrecision=${s.info.audioConfig.samplePrecision} ` +
            `soundTrack=${s.info.audioConfig.soundTrack} ` +
            `openMs=${Date.now() - openStart}`,
        );
        return s;
      })().catch((e) => {
        this.starting = undefined;
        this.opts.logger?.log?.(
          `[RtspBackchannel] TalkSession open FAILED openMs=${Date.now() - openStart} error="${(e as Error).message}"`,
        );
        throw e;
      });
    }
    return this.starting;
  }

  /**
   * Feed one inbound RTP packet (as carried in TCP-interleaved framing or UDP
   * datagram). Discards malformed packets and packets received before `start()`.
   * The actual audio dispatch to the TalkSession is awaited internally; callers
   * may fire-and-forget.
   */
  feedRtp(packet: Buffer): void {
    this.rtpPacketsReceived++;
    if (!this.active || !this.session) {
      this.rtpPacketsDropped++;
      if (this.rtpPacketsDropped === 1) {
        this.opts.logger?.log?.(
          `[RtspBackchannel] dropping RTP packets — session not active yet (received ${packet.length}B before start())`,
        );
      }
      return;
    }
    const parsed = parseRtpPacket(packet);
    if (!parsed) {
      this.rtpPacketsDropped++;
      this.opts.logger?.log?.(
        `[RtspBackchannel] malformed RTP packet — dropping (len=${packet.length} firstByte=0x${packet.length ? (packet[0] ?? 0).toString(16) : "??"})`,
      );
      return;
    }

    const codec: BackchannelCodec =
      this.opts.forceCodec ??
      (parsed.payloadType === RTP_PT_PCMA ? "pcma" : "pcmu");
    if (this.observedCodec === undefined) {
      this.observedCodec = codec;
      const firstPacketMs = Date.now() - this.startedAtMs;
      this.opts.logger?.log?.(
        `[RtspBackchannel] first RTP packet — codec=${codec} payloadType=${parsed.payloadType} payload=${parsed.payload.length}B firstByteMs=${firstPacketMs}` +
          (this.opts.forceCodec ? " (forced by config)" : ""),
      );
    } else if (codec !== this.observedCodec) {
      // Don't spam, but flag mid-stream codec switches (rare; usually a sign
      // of a client sending mixed payload types).
      this.opts.logger?.log?.(
        `[RtspBackchannel] codec switched mid-stream ${this.observedCodec} → ${codec} (payloadType=${parsed.payloadType})`,
      );
      this.observedCodec = codec;
    }

    const decoded =
      codec === "pcma"
        ? alawToPcm16(parsed.payload)
        : mulawToPcm16(parsed.payload);
    if (decoded.length === 0) return;

    // RFC 3551 G.711 is always 8 kHz mono; Reolink TalkAbility wants 16 kHz mono.
    const upsampled = upsamplePcm16(decoded, TALK_TARGET_RATE_HZ / G711_SOURCE_RATE_HZ);
    this.enqueuePcm(upsampled);
    this.maybeLogStats();
  }

  /**
   * Throttled progress log (~every 5s while audio is flowing) so operators
   * can confirm the pipeline is making progress without per-packet noise.
   */
  private maybeLogStats(): void {
    const now = Date.now();
    if (now - this.lastStatsLogMs < RtspBackchannel.STATS_LOG_INTERVAL_MS) return;
    const elapsedSec = (now - this.lastStatsLogMs) / 1000;
    const rtpDelta = this.rtpPacketsReceived - this.lastStatsRtpPackets;
    const adpcmDelta = this.adpcmBlocksSent - this.lastStatsAdpcmBlocks;
    this.lastStatsLogMs = now;
    this.lastStatsRtpPackets = this.rtpPacketsReceived;
    this.lastStatsAdpcmBlocks = this.adpcmBlocksSent;
    this.opts.logger?.log?.(
      `[RtspBackchannel] stats codec=${this.observedCodec ?? "?"} ` +
        `rtpRx=${this.rtpPacketsReceived} (+${rtpDelta} in ${elapsedSec.toFixed(1)}s) ` +
        `dropped=${this.rtpPacketsDropped} ` +
        `adpcmBlocks=${this.adpcmBlocksSent} (+${adpcmDelta}) ` +
        `pcmBacklog=${this.pcmBacklogBytes}B`,
    );
  }

  /** Flush remaining audio and stop the talk session. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.active = false;
    this.stopping = (async () => {
      const s = this.session;
      this.session = undefined;
      this.pcmTail = new Int16Array(0);
      this.pcmBacklogBytes = 0;
      const durationMs = this.startedAtMs ? Date.now() - this.startedAtMs : 0;
      this.opts.logger?.log?.(
        `[RtspBackchannel] closing TalkSession ` +
          `durationMs=${durationMs} rtpRx=${this.rtpPacketsReceived} ` +
          `rtpDropped=${this.rtpPacketsDropped} adpcmBlocks=${this.adpcmBlocksSent} ` +
          `pcmBacklogResidual=${this.pcmBacklogBytes}B codec=${this.observedCodec ?? "(none)"}`,
      );
      if (s) {
        try {
          await s.stop();
        } catch (e) {
          this.opts.logger?.log?.(
            `[RtspBackchannel] TalkSession stop error: ${(e as Error).message}`,
          );
        }
      }
    })();
    return this.stopping;
  }

  private enqueuePcm(chunk: Int16Array): void {
    if (chunk.length === 0) return;

    const tailLen = this.pcmTail.length;
    const merged = new Int16Array(tailLen + chunk.length);
    merged.set(this.pcmTail, 0);
    merged.set(chunk, tailLen);
    this.pcmBacklogBytes = merged.length * 2;

    const maxBytes = Math.max(2, this.opts.maxPcmBacklogBytes ?? 96_000);
    if (this.pcmBacklogBytes > maxBytes) {
      const keepSamples = Math.floor(maxBytes / 2);
      const dropSamples = merged.length - keepSamples;
      this.pcmTail = merged.subarray(merged.length - keepSamples);
      this.pcmBacklogBytes = this.pcmTail.length * 2;

      const now = Date.now();
      if (now - this.lastBacklogClampLogMs > 2000) {
        this.lastBacklogClampLogMs = now;
        this.opts.logger?.log?.(
          `[RtspBackchannel] PCM backlog clamped — dropped ${dropSamples} samples, kept ${keepSamples}`,
        );
      }
    } else {
      this.pcmTail = merged;
    }

    void this.pumpAdpcm();
  }

  private async pumpAdpcm(): Promise<void> {
    if (this.pumping) return;
    const session = this.session;
    if (!session) return;
    this.pumping = true;
    try {
      const samplesPerBlock = session.info.blockSize * 2 + 1;
      const blockSizeBytes = session.info.blockSize;
      while (this.active && this.pcmTail.length >= samplesPerBlock) {
        const consumeSamples =
          Math.floor(this.pcmTail.length / samplesPerBlock) * samplesPerBlock;
        const head = this.pcmTail.subarray(0, consumeSamples);
        const adpcm = encodeImaAdpcm(head, blockSizeBytes);
        const blocksInBatch = consumeSamples / samplesPerBlock;
        this.pcmTail = this.pcmTail.slice(consumeSamples);
        this.pcmBacklogBytes = this.pcmTail.length * 2;
        try {
          await session.sendAudio(adpcm);
          this.adpcmBlocksSent += blocksInBatch;
        } catch (e) {
          this.opts.logger?.log?.(
            `[RtspBackchannel] sendAudio FAILED — disabling pipeline ` +
              `blocksInBatch=${blocksInBatch} adpcmBytes=${adpcm.length} ` +
              `pcmBacklogBefore=${this.pcmBacklogBytes + adpcm.length}B ` +
              `error="${(e as Error).message}"`,
          );
          // Discard the rest of the backlog so we don't loop on a dead session.
          this.pcmTail = new Int16Array(0);
          this.pcmBacklogBytes = 0;
          this.active = false;
          break;
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}
