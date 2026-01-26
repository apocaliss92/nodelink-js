/**
 * Baichuan Video Stream - Builds a video stream from the native Baichuan protocol.
 *
 * Receives video frames via `push` events and exposes them as access units.
 */

import { BaichuanClient } from "../../client/BaichuanClient";
import type { BaichuanFrame } from "../../protocol/framing";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StreamProfile } from "../../reolink/baichuan/types";
import type { ReolinkBaichuanApi } from "../../reolink/baichuan/ReolinkBaichuanApi";
import type { NativeVideoStreamVariant } from "../../reolink/baichuan/types";
import type { EncryptionProtocol } from "../../protocol/crypto";
import { aesDecrypt, AesStreamDecryptor } from "../../protocol/crypto";
import { ensureDumpDir, type Logger } from "../../debug/DebugConfig";
import { BcMediaCodec } from "./BcMediaCodec";
import {
  convertToAnnexB,
  hasStartCodes,
  H264RtpDepacketizer,
  isValidH264AnnexBAccessUnit,
  isH264KeyframeAnnexB,
  splitAnnexBToNalPayloads,
} from "./H264Converter";
import {
  convertToAnnexB as convertH265ToAnnexB,
  isValidH265AnnexBAccessUnit,
  isH265KeyframeAnnexB,
  splitAnnexBToNalPayloads as splitH265AnnexBToNalPayloads,
  extractVpsFromAnnexB,
  extractSpsFromAnnexB,
  extractPpsFromAnnexB,
  getH265NalType,
  H265RtpDepacketizer,
} from "./H265Converter";
import { detectVideoCodecFromNal } from "./BcMediaAnnexBDecoder";

const NAL_START_CODE_4B = Buffer.from([0x00, 0x00, 0x00, 0x01]);

const WATCHDOG_TICK_MS = 1000;
const WATCHDOG_MAX_RESTARTS_PER_MINUTE = 3;

class AsyncFsQueue {
  private running = false;
  private readonly queue: Array<() => Promise<void>> = [];
  private readonly maxQueueSize: number;

  constructor(maxQueueSize: number) {
    this.maxQueueSize = maxQueueSize;
  }

  enqueue(task: () => Promise<void>): void {
    if (this.queue.length >= this.maxQueueSize) return;
    this.queue.push(task);
    this.pump();
  }

  private pump(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift();
        if (!task) continue;
        try {
          await task();
        } catch {
          // ignore
        }
      }
    } finally {
      this.running = false;
    }
  }
}

// --- Minimal H.264 bit parsing helpers (for SPS/PPS IDs + slice pps_id) ---
function removeEmulationPreventionBytes(rbsp: Buffer): Buffer {
  // Remove 0x03 after 00 00 (Annex-B emulation prevention)
  const out: number[] = [];
  for (let i = 0; i < rbsp.length; i++) {
    if (
      i >= 2 &&
      rbsp[i] === 0x03 &&
      rbsp[i - 1] === 0x00 &&
      rbsp[i - 2] === 0x00
    ) {
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

function parsePpsIdsFromNal(
  nalPayload: Buffer,
): { ppsId: number; spsId: number } | null {
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
  /** Native-only: TrackMix tele/autotrack variants (usually on NVR/Hub). */
  variant?: NativeVideoStreamVariant | undefined;
  logger?: Logger;

  /**
   * cmdId that carries the BcMedia payload.
   * Live stream typically uses 3; recording replay typically uses 5.
   */
  cmdId?: number;
  /**
   * If provided, frames with other msgNum will be discarded.
   * Useful for replay (where the caller reserves the msgNum).
   */
  msgNum?: number;
  /** If true, do not filter by streamType (only by cmdId/msgNum). */
  acceptAnyStreamType?: boolean;
}

/**
 * BaichuanVideoStream - Handles video streaming via the Baichuan protocol.
 *
 * Video frames arrive as `push` events from `BaichuanClient`.
 * This stream receives frames, decodes BcMedia packets and emits H.264/H.265 access units.
 *
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
  videoAccessUnit: [
    {
      data: Buffer;
      isKeyframe: boolean;
      videoType: "H264" | "H265";
      microseconds: number;
      time?: number;
    },
  ];
  audioFrame: [Buffer]; // Audio frame (if present)
  error: [Error];
  close: [];
}> {
  private client: BaichuanClient;
  private api: ReolinkBaichuanApi | undefined;
  private channel: number;
  private profile: StreamProfile;
  private variant: NativeVideoStreamVariant;
  private logger: Logger | undefined;
  private active = false;
  private videoFrameHandler: ((frame: BaichuanFrame) => void) | undefined;
  private readonly expectedStreamTypes: Set<number>;
  private activeMsgNum: number | undefined;
  private readonly cmdId: number;
  private readonly acceptAnyStreamType: boolean;
  private lockedChannelId: number | undefined;
  private bcMediaCodec: BcMediaCodec;
  private debugH264LogsLeft: number;
  private debugSavedSamples: boolean;
  private warnedNonAnnexBOnce = false;
  // "RTP-like" depacketizer (some models encapsulate NAL units in FU-A/STAP)
  private readonly depacketizer = new H264RtpDepacketizer();
  private readonly depacketizerH265 = new H265RtpDepacketizer();
  private dumpChunkIdx = 0;
  private dumpNalLines = 0;
  private readonly dumpIo = new AsyncFsQueue(200);
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

  // Stateful AES decryptor for fragmented BcMedia packets (full_aes mode)
  // In CFB mode, continuation frames must use the cipher state from previous frames.
  private aesStreamDecryptor: AesStreamDecryptor | null = null;

  private emitSafeError(err: Error): void {
    // If we're no longer active, this is almost always a late/rejected in-flight request.
    // Emitting 'error' with no listeners will crash the process, so guard both cases.
    if (!this.active) {
      this.logger?.warn?.(
        `[BaichuanVideoStream] Suppressed error after stop: ${err.message}`,
      );
      return;
    }

    if (this.listenerCount("error") === 0) {
      this.logger?.warn?.(
        `[BaichuanVideoStream] Unhandled stream error: ${err.message}`,
      );
      return;
    }

    this.emit("error", err);
  }
  private lastMediaAtMs = 0;
  private watchdogTimer: NodeJS.Timeout | undefined;
  private restarting = false;
  private restartWindowStartMs = 0;
  private restartCountInWindow = 0;
  private readonly idleRestartMs: number;
  // Note: reassembly happens at the BcMediaCodec transport level, so we do not
  // accumulate frames here.

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

  private chooseDecryptedOrRawCandidate(params: {
    raw: Buffer;
    enc: EncryptionProtocol;
    channelId: number;
    allowResync: boolean;
    encryptLen?: number;
  }): Buffer {
    const { raw, enc, channelId, allowResync, encryptLen } = params;

    // If encryptLen is provided, only decrypt the first encryptLen bytes
    // and keep the rest as-is. This is how Reolink partial encryption works.
    if (encryptLen !== undefined && encryptLen > 0 && encryptLen < raw.length) {
      const encryptedPart = raw.subarray(0, encryptLen);
      const clearPart = raw.subarray(encryptLen);
      const decryptedPart = this.client.tryDecryptBinary(
        encryptedPart,
        channelId,
        enc,
      );
      const chosen = Buffer.concat([decryptedPart, clearPart]);
      if (!allowResync) return chosen;
      const best = BaichuanVideoStream.scoreBcMediaLike(chosen);
      return best.first > 0 ? chosen.subarray(best.first) : chosen;
    }

    // --- Special handling for full_aes mode ---
    // In AES-128-CFB mode, decryption behavior differs between live and replay:
    //
    // LIVE STREAM (cmdId=3): Each Baichuan frame contains complete BcMedia packets.
    // Fresh IV decryption works correctly for every frame.
    //
    // PLAYBACK/REPLAY (cmdId=5):
    // - I-frames: Entire chunk is encrypted, fresh IV works.
    // - P-frames: Only the BcMedia HEADER is encrypted, video PAYLOAD is clear!
    //   Fresh IV decryption corrupts the clear payload.
    //   We must use partial decryption: decrypt header, keep payload as-is.
    //
    // Detection: After fresh decrypt, check if raw bytes at video payload offset
    // have H.264 start codes. If yes, use partial decryption.
    if (enc.kind === "full_aes") {
      const key = enc.key;
      const isReplayMode = this.cmdId === 5; // BC_CMD_ID_FILE_INFO_LIST_REPLAY

      // Try decryption with fresh IV
      const freshDecrypted = aesDecrypt(raw, key);
      const freshScore = BaichuanVideoStream.scoreBcMediaLike(freshDecrypted);
      const rawScore = BaichuanVideoStream.scoreBcMediaLike(raw);

      // Check if fresh-decrypted data starts with a BcMedia magic
      const startsWithMagic = freshScore.first === 0 && freshScore.score > 0;

      // For live stream (cmdId=3), always use fresh IV decryption
      if (!isReplayMode) {
        const chosen = freshScore.score > rawScore.score ? freshDecrypted : raw;
        if (!allowResync) return chosen;
        const best = BaichuanVideoStream.scoreBcMediaLike(chosen);
        return best.first > 0 ? chosen.subarray(best.first) : chosen;
      }

      // --- Replay mode: handle partial encryption for P-frames ---

      if (startsWithMagic && freshDecrypted.length >= 24) {
        // Parse BcMedia header to determine if we need partial decryption
        const magic = freshDecrypted.readUInt32LE(0);
        const isIFrame = magic >= 0x63643030 && magic <= 0x63643039;
        const isPFrame = magic >= 0x63643130 && magic <= 0x63643139;

        if ((isIFrame || isPFrame) && freshDecrypted.length >= 24) {
          // Video frame: magic(4) + videoType(4) + payloadSize(4) + additionalHeaderSize(4) + microseconds(4) + unknown(4) + additionalHeader + payload
          const additionalHeaderSize = freshDecrypted.readUInt32LE(12);
          const headerLen = 24 + additionalHeaderSize;

          if (headerLen > 0 && headerLen < raw.length) {
            // Check if raw bytes at headerLen have H.264 start codes (clear payload indicator)
            const rawPayloadStart = raw.subarray(headerLen, headerLen + 4);
            const hasRawStartCode =
              rawPayloadStart.length >= 4 &&
              rawPayloadStart[0] === 0 &&
              rawPayloadStart[1] === 0 &&
              (rawPayloadStart[2] === 1 ||
                (rawPayloadStart[2] === 0 && rawPayloadStart[3] === 1));

            if (hasRawStartCode) {
              // P-frame case: header is encrypted, payload is clear
              // Use partial decryption: decrypt only the header
              const headerDecrypted = aesDecrypt(
                raw.subarray(0, headerLen),
                key,
              );
              const clearPayload = raw.subarray(headerLen);
              const chosen = Buffer.concat([headerDecrypted, clearPayload]);
              if (!allowResync) return chosen;
              const best = BaichuanVideoStream.scoreBcMediaLike(chosen);
              return best.first > 0 ? chosen.subarray(best.first) : chosen;
            }
          }
        }

        // I-frame case: Reolink encrypts only the first 1024 bytes of the BcMedia frame.
        // Bytes 0-1023 are encrypted, bytes 1024+ are clear (unencrypted).
        // This is a form of partial encryption for efficiency (64 AES blocks).
        const IFRAME_ENCRYPT_BOUNDARY = 1024;

        if (raw.length > IFRAME_ENCRYPT_BOUNDARY) {
          // Partial encryption: decrypt first 1024 bytes, keep rest as-is
          const encryptedPart = raw.subarray(0, IFRAME_ENCRYPT_BOUNDARY);
          const clearPart = raw.subarray(IFRAME_ENCRYPT_BOUNDARY);
          const decryptedPart = aesDecrypt(encryptedPart, key);
          const chosen = Buffer.concat([decryptedPart, clearPart]);
          if (!allowResync) return chosen;
          const best = BaichuanVideoStream.scoreBcMediaLike(chosen);
          return best.first > 0 ? chosen.subarray(best.first) : chosen;
        }

        // Small frame (<=1024 bytes): full decryption needed
        {
          const chosen = freshDecrypted;
          if (!allowResync) return chosen;
          const best = BaichuanVideoStream.scoreBcMediaLike(chosen);
          return best.first > 0 ? chosen.subarray(best.first) : chosen;
        }
      }

      // Check if raw data already looks like valid BcMedia (not encrypted)
      if (rawScore.first === 0 && rawScore.score > freshScore.score) {
        // Data is not encrypted - use raw
        // Note: we don't reset the decryptor here since the stream may be mixed
        const chosen = raw;
        if (!allowResync) return chosen;
        const best = BaichuanVideoStream.scoreBcMediaLike(chosen);
        return best.first > 0 ? chosen.subarray(best.first) : chosen;
      }

      // Continuation frame - use stateful decryptor if available
      if (this.aesStreamDecryptor && this.aesStreamDecryptor.isInitialized()) {
        const statefulDecrypted = this.aesStreamDecryptor.update(raw);
        // Continuation frames don't start with magic, so we return as-is
        // (the BcMediaCodec will append to its buffer)
        return statefulDecrypted;
      }

      // Fallback: no stateful decryptor yet - might be first frame or stream desync
      // Try fresh decryption as last resort
      const chosen = freshScore.score > rawScore.score ? freshDecrypted : raw;
      if (!allowResync) return chosen;
      const best = BaichuanVideoStream.scoreBcMediaLike(chosen);
      return best.first > 0 ? chosen.subarray(best.first) : chosen;
    }

    // --- Standard handling for other encryption modes ---
    const rawScore = BaichuanVideoStream.scoreBcMediaLike(raw);
    const dec =
      this.client.enc.kind === "aes" || this.client.enc.kind === "bc"
        ? this.client.tryDecryptBinary(raw, channelId, enc)
        : raw;
    const decScore = BaichuanVideoStream.scoreBcMediaLike(dec);
    const chosen = decScore.score > rawScore.score ? dec : raw;

    // WARNING: trimming to the first magic boundary can drop bytes that belong to a
    // fragmented BcMedia packet (spanning across frames). Only do this when we know
    // the chunk may contain non-media bytes (e.g. XML) at the start.
    if (!allowResync) return chosen;
    const best = BaichuanVideoStream.scoreBcMediaLike(chosen);
    return best.first > 0 ? chosen.subarray(best.first) : chosen;
  }

  constructor(options: BaichuanVideoStreamOptions) {
    super();
    this.client = options.client;
    this.api = options.api;
    this.channel = options.channel;
    this.profile = options.profile;
    this.variant = options.variant ?? "default";
    this.logger = options.logger;
    this.cmdId = options.cmdId ?? 3;
    this.acceptAnyStreamType = options.acceptAnyStreamType ?? false;
    // Stream type varies across firmwares:
    // - some use 0/1 for main/sub (even for tele on Hub/NVR)
    // - others use 2/3 for autotrack/telephoto variants
    // Accept both and rely on msgNum filtering when available.
    this.expectedStreamTypes =
      this.profile === "sub" ? new Set([1, 3]) : new Set([0, 2]);
    // Hub/NVR tele selection uses Preview v1.1 while keeping header streamType=0.
    // Without this, native_sub telephoto would discard all frames and timeout.
    if (this.variant === "telephoto") this.expectedStreamTypes.add(0);
    // this.logger?.log(
    //   `[BaichuanVideoStream] constructor: channel=${this.channel}, profile=${this.profile}, variant=${this.variant}, expectedStreamTypes=[${[
    //     ...this.expectedStreamTypes,
    //   ].join(",")}]`
    // );
    this.bcMediaCodec = new BcMediaCodec(false, this.logger); // non-strict mode for error recovery
    // Debug is configured on the client; the library must not read env vars.
    const dbg = this.client.getDebugConfig();
    this.debugH264LogsLeft = dbg.traceNativeStream ? 200 : 0;
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

    // If the caller knows the msgNum (e.g. replay), lock to it immediately.
    if (options.msgNum !== undefined) {
      this.activeMsgNum = options.msgNum;
    }

    // Internal defaults (no external knobs): if the stream goes idle for too long,
    // best-effort restart the native stream request.
    // NOTE: UDP (battery/BCUDP) can legitimately take longer to wake and begin streaming.
    // Keep this relatively high to avoid causing reconnect storms.
    const transport = this.client.getTransport?.();
    this.idleRestartMs = transport === "udp" ? 60_000 : 15_000;
  }

  private noteMediaActivity(): void {
    this.lastMediaAtMs = Date.now();
  }

  private startWatchdog(): void {
    // Only useful when we can re-request the stream via API.
    if (!this.api) return;
    if (this.watchdogTimer) return;

    this.restartWindowStartMs = Date.now();
    this.restartCountInWindow = 0;
    this.watchdogTimer = setInterval(() => {
      void this.watchdogTick();
    }, WATCHDOG_TICK_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }

  private async watchdogTick(): Promise<void> {
    if (!this.active) return;
    if (!this.api) return;
    if (this.restarting) return;
    if (this.lastMediaAtMs <= 0) return;

    const now = Date.now();
    const idleMs = now - this.lastMediaAtMs;
    if (idleMs < this.idleRestartMs) return;

    // Rate-limit restarts to avoid loops.
    if (now - this.restartWindowStartMs > 60_000) {
      this.restartWindowStartMs = now;
      this.restartCountInWindow = 0;
    }
    if (this.restartCountInWindow >= WATCHDOG_MAX_RESTARTS_PER_MINUTE) {
      this.logger?.warn(
        `[BaichuanVideoStream] Watchdog: idle for ${idleMs}ms, but restart budget exceeded (${WATCHDOG_MAX_RESTARTS_PER_MINUTE}/min); leaving stream as-is`,
      );
      // Avoid spamming: reset lastMediaAt to delay the next restart attempt.
      this.lastMediaAtMs = now;
      return;
    }
    this.restartCountInWindow++;

    void this.restartNativeStream({ reason: `idle ${idleMs}ms` });
  }

  private async restartNativeStream(params: { reason: string }): Promise<void> {
    if (!this.api) return;
    if (!this.active) return;
    if (this.restarting) return;
    this.restarting = true;

    try {
      const transport = this.client.getTransport?.() ?? "unknown";
      const msgNum = this.activeMsgNum ?? "unknown";
      this.logger?.warn(
        `[BaichuanVideoStream] Watchdog restarting native stream (channel=${this.channel} profile=${this.profile} expectedStreamTypes=[${[
          ...this.expectedStreamTypes,
        ].join(
          ",",
        )}] msgNum=${msgNum} transport=${transport} reason=${params.reason})`,
      );

      // Reset parsers to avoid carrying corrupt state across a restart.
      this.depacketizer.reset();
      this.depacketizerH265.reset();
      this.bcMediaCodec.clear();
      this.activeMsgNum = undefined;
      this.lockedChannelId = undefined;
      this.lastPrependedPpsId = null;
      this.lastPrependedParamSetsH265 = false;

      // Best-effort stop/start: some firmwares behave better with a full reset.
      try {
        await this.api.stopVideoStream(this.channel, this.profile, {
          variant: this.variant,
        });
      } catch {
        // ignore
      }

      await this.api.startVideoStream(this.channel, this.profile, {
        variant: this.variant,
      });

      try {
        const getMsgNum = (this.api as any).getActiveVideoMsgNumWithVariant as
          | ((
              ch: number,
              p: StreamProfile,
              v?: NativeVideoStreamVariant,
            ) => number | undefined)
          | undefined;
        const v =
          typeof getMsgNum === "function"
            ? getMsgNum(this.channel, this.profile, this.variant)
            : undefined;
        if (v !== undefined) this.activeMsgNum = v;
      } catch {
        // keep current activeMsgNum (may have been learned from frames)
      }

      // Avoid immediate re-trigger if the camera takes a moment.
      this.lastMediaAtMs = Date.now();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emitSafeError(err);
    } finally {
      this.restarting = false;
    }
  }

  /**
   * Start video stream.
   * Listens to `push` events and processes cmd_id=3 frames carrying BcMedia packets.
   */
  async start(): Promise<void> {
    if (this.active) {
      throw new Error("Video stream already active");
    }

    // Ensure depacketizers start from a clean state.
    this.depacketizer.reset();
    this.depacketizerH265.reset();

    // Listen to push events carrying BcMedia packets (cmd_id=3).
    // IMPORTANT: register this handler BEFORE awaiting the VIDEO start response.
    // Some NVR/Hub firmwares are slow to reply, but begin streaming earlier.
    let totalFramesReceived = 0;
    let totalMediaPackets = 0;
    this.videoFrameHandler = (frame: BaichuanFrame) => {
      // Only frames with the configured cmdId carry the media stream.
      if (frame.header.cmdId !== this.cmdId) return;

      // Filter by msgNum if we were able to capture it from the API.
      // Some firmwares reuse streamType but keep msgNum distinct per stream.
      // NOTE: Some cameras (e.g., TrackMix PoE) always respond with msgNum=0 regardless
      // of what msgNum we used in the request. When acceptAnyStreamType is true (replay mode),
      // we also accept msgNum=0 as a fallback.
      if (
        this.activeMsgNum !== undefined &&
        frame.header.msgNum !== this.activeMsgNum
      ) {
        // Accept msgNum=0 as fallback when in permissive mode (replay)
        const allowMsgNum0Fallback =
          this.acceptAnyStreamType && frame.header.msgNum === 0;
        if (!allowMsgNum0Fallback) {
          const frameCount = ((this as any)._msgNumMismatchCount =
            ((this as any)._msgNumMismatchCount || 0) + 1);
          if (frameCount <= 5) {
            this.logger?.log(
              `[BaichuanVideoStream] Frame msgNum mismatch: received=${frame.header.msgNum}, expected=${this.activeMsgNum}, channel=${this.channel}, profile=${this.profile}, variant=${this.variant} (frame discarded)`,
            );
          }
          return;
        }
      }

      // Filter by expected streamType(s). Some devices use 0/1, others 2/3 for variants.
      if (
        !this.acceptAnyStreamType &&
        !this.expectedStreamTypes.has(frame.header.streamType)
      ) {
        const frameCount = ((this as any)._streamTypeMismatchCount =
          ((this as any)._streamTypeMismatchCount || 0) + 1);
        if (frameCount <= 5) {
          this.logger?.log(
            `[BaichuanVideoStream] Frame streamType mismatch: received=${frame.header.streamType}, expectedAny=[${[
              ...this.expectedStreamTypes,
            ].join(
              ",",
            )}], channel=${this.channel}, profile=${this.profile}, variant=${this.variant} (frame discarded)`,
          );
        }
        return;
      }

      // Additional safety net for multi-stream scenarios:
      // If multiple streams share the same BaichuanClient/socket and msgNum filtering is unavailable,
      // frames from different channelIds can interleave and manifest as stutter/picture loss.
      // Lock to the first observed channelId and discard mismatches.
      if (this.lockedChannelId === undefined) {
        this.lockedChannelId = frame.header.channelId;
      } else if (frame.header.channelId !== this.lockedChannelId) {
        const frameCount = ((this as any)._channelIdMismatchCount =
          ((this as any)._channelIdMismatchCount || 0) + 1);
        if (frameCount <= 5) {
          this.logger?.warn(
            `[BaichuanVideoStream] Frame channelId mismatch: received=${frame.header.channelId}, locked=${this.lockedChannelId}, streamType=${frame.header.streamType}, msgNum=${frame.header.msgNum}, activeMsgNum=${this.activeMsgNum ?? "unknown"}, channel=${this.channel}, profile=${this.profile}, variant=${this.variant} (frame discarded)`,
          );
        }
        return;
      }

      totalFramesReceived++;

      const dbg = this.client.getDebugConfig();
      const rtspDebug = dbg.debugRtsp;
      if (totalFramesReceived === 1) {
        // Always log first frame info for debugging variant issues
        // this.logger?.log(
        //   `[BaichuanVideoStream] First frame accepted: streamType=${frame.header.streamType}, expectedAny=[${[
        //     ...this.expectedStreamTypes,
        //   ].join(",")}], msgNum=${frame.header.msgNum}, activeMsgNum=${this.activeMsgNum}, channelId=${frame.header.channelId}, bodyLen=${frame.body.length}, variant=${this.variant}`
        // );
        if (rtspDebug) {
          this.logger?.log(
            `[BaichuanVideoStream] First cmd_id=${this.cmdId} frame received (bodyLen: ${frame.body.length}, channelId: ${frame.header.channelId})`,
          );
        }
      }
      if (totalFramesReceived % 10 === 0 || totalFramesReceived <= 5) {
        if (rtspDebug) {
          this.logger?.log(
            `[BaichuanVideoStream] Received ${totalFramesReceived} Baichuan frames (cmd_id=${this.cmdId})`,
          );
        }
      }

      // Note: the media stream is often NOT encrypted like control messages.
      // So we first try to parse the `payload` directly (if present), and only as a fallback
      // we try stateless decryption.
      const enc = this.client.enc;
      const rawCandidate =
        frame.payload.length > 0 ? frame.payload : frame.body;

      // If the payload still contains XML+binary (missing payloadOffset), strip XML as a fallback.
      let dataToParse = rawCandidate;
      if (frame.payload.length === 0) {
        let searchStart = 0;
        const extensionEnd = rawCandidate.indexOf(Buffer.from("</Extension>"));
        const bodyEnd = rawCandidate.indexOf(Buffer.from("</body>"));
        if (extensionEnd !== -1)
          searchStart = extensionEnd + Buffer.from("</Extension>").length;
        else if (bodyEnd !== -1)
          searchStart = bodyEnd + Buffer.from("</body>").length;
        dataToParse = rawCandidate.subarray(searchStart);
      }

      // If the session uses encryption, some models send an encrypted stream at the frame level.
      // If we find a BcMedia magic in the raw payload, it's not a guarantee the content is NOT encrypted
      // (it can be a false positive). So we also try stateless decryption and pick
      // the most "BcMedia-like" candidate (decrypt before deserializing).

      const dataAfterXml = this.chooseDecryptedOrRawCandidate({
        raw: dataToParse,
        enc,
        channelId: frame.header.channelId,
        // Some NVR/Hub streams appear to include non-media bytes even when payloadOffset is present.
        // Allow a one-time resync at startup to avoid delaying the first keyframe.
        allowResync:
          frame.payload.length === 0 ||
          (totalFramesReceived <= 10 && totalMediaPackets === 0),
      });

      // If we are currently aligned (no pending buffered bytes) and we receive a tiny chunk that
      // contains no recognizable BcMedia magic anywhere, it's very likely out-of-band data.
      // Dropping it avoids repeated recover/resync loops (commonly 528/1056-byte patterns on some NVRs).
      if (
        this.bcMediaCodec.getRemainingBuffer().length === 0 &&
        dataAfterXml.length <= 600
      ) {
        const s = BaichuanVideoStream.scoreBcMediaLike(dataAfterXml);
        if (s.first < 0) {
          return;
        }
      }
      if (totalFramesReceived === 1) {
        if (rtspDebug) {
          this.logger?.log(
            `[BaichuanVideoStream] Data after XML: ${dataAfterXml.length} bytes, first 32 bytes: ${dataAfterXml
              .subarray(0, Math.min(32, dataAfterXml.length))
              .toString("hex")}`,
          );
        }
      }
      if (dbg.dumpEnabled) ensureDumpDir(dbg);

      // Dumps the exact chunks fed to the BcMedia decoder.
      if (dbg.dumpBcMedia && this.dumpChunkIdx < 200) {
        const outDir = dbg.dumpDir;
        const idx = String(this.dumpChunkIdx).padStart(4, "0");
        const chunkPath = path.join(outDir, `bcmedia_chunk_${idx}.bin`);
        const infoPath = path.join(outDir, "bcmedia_info.json");
        const chunk = Buffer.from(dataAfterXml);
        const writeInfo = this.dumpChunkIdx === 0;
        const infoJson = writeInfo
          ? JSON.stringify(
              {
                note: "Chunks fed into the BcMedia decoder (after XML stripping/alignment).",
                profile: this.profile,
                channel: this.channel,
                encKind: this.client.enc.kind,
              },
              null,
              2,
            )
          : "";

        // Non-blocking: sync FS calls can starve BCUDP ACK/keepalive and abort the stream.
        this.dumpIo.enqueue(async () => {
          await fs.promises.writeFile(chunkPath, chunk);
          if (writeInfo) {
            await fs.promises.writeFile(infoPath, infoJson);
          }
        });
        this.dumpChunkIdx++;
      }

      const mediaPackets = this.bcMediaCodec.decode(dataAfterXml);
      totalMediaPackets += mediaPackets.length;

      // Count packet types
      const packetTypes = new Map<string, number>();
      for (const pkt of mediaPackets) {
        packetTypes.set(pkt.type, (packetTypes.get(pkt.type) || 0) + 1);
      }

      // Log detailed info for first few frames and periodically
      // Disabled for production - enable for debugging only
      // if (totalFramesReceived <= 10 || totalFramesReceived % 100 === 0) {
      //   const remainingBuffer = this.bcMediaCodec.getRemainingBuffer();
      //   const typesStr = Array.from(packetTypes.entries())
      //     .map(([t, c]) => `${t}:${c}`)
      //     .join(", ");
      //   console.log(
      //     `[BaichuanVideoStream] Frame #${totalFramesReceived}: dataToParse=${dataAfterXml.length} bytes, parsed ${mediaPackets.length} BcMedia packets (${typesStr || "none"}), total: ${totalMediaPackets}, remaining buffer: ${remainingBuffer.length} bytes`,
      //   );
      // }

      // Process complete BcMedia packets.
      // Each BcMedia::Iframe/Pframe already contains a complete frame (access unit).
      // BcMediaCodec only handles transport fragmentation, not "half frames".
      let videoFramesEmitted = 0;
      let audioFramesEmitted = 0;

      for (const media of mediaPackets) {
        const maybeCacheParamSets = (
          annexB: Buffer,
          source: "Iframe" | "Pframe",
          videoType: "H264" | "H265",
        ) => {
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
                  if (dbg.traceNativeStream) {
                    this.logger?.warn(
                      `[BaichuanVideoStream] Cached H.264 SPS id=${id} len=${nal.length}`,
                    );
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
                  if (dbg.traceNativeStream) {
                    this.logger?.warn(
                      `[BaichuanVideoStream] Cached H.264 PPS id=${ids.ppsId} (spsId=${ids.spsId}) len=${nal.length}`,
                    );
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
              if (dbg.traceNativeStream) {
                this.logger?.warn(
                  `[BaichuanVideoStream] Cached H.265 VPS len=${vps.length}`,
                );
              }
            }
            const sps = extractSpsFromAnnexB(annexB);
            if (sps) {
              this.lastSpsH265 = sps;
              if (dbg.traceNativeStream) {
                this.logger?.warn(
                  `[BaichuanVideoStream] Cached H.265 SPS len=${sps.length}`,
                );
              }
            }
            const pps = extractPpsFromAnnexB(annexB);
            if (pps) {
              this.lastPpsH265 = pps;
              if (dbg.traceNativeStream) {
                this.logger?.warn(
                  `[BaichuanVideoStream] Cached H.265 PPS len=${pps.length}`,
                );
              }
            }
          }
        };

        const prependParamSetsIfNeeded = (
          annexB: Buffer,
          videoType: "H264" | "H265",
        ): Buffer => {
          if (videoType === "H264") {
            const nals = splitAnnexBToNalPayloads(annexB);
            if (nals.length === 0) return annexB;
            const types = nals.map((n) => (n[0] ?? 0) & 0x1f);
            // If it already includes SPS/PPS, do not prepend
            if (types.includes(7) && types.includes(8)) return annexB;
            // If there is no VCL, there's nothing to prepend to.
            const hasVcl = types.some(
              (t) => t === 1 || t === 5 || t === 19 || t === 20,
            );
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
            if (dbg.traceNativeStream) {
              this.logger?.warn(
                `[BaichuanVideoStream] Slice references ppsId=${ppsId ?? "?"} lastPrepended=${this.lastPrependedPpsId ?? "?"}`,
              );
            }

            // If we can't parse it, be conservative: only use the last seen SPS/PPS once at the beginning.
            if (ppsId == null || ppsId > 255) {
              if (this.lastPrependedPpsId != null) return annexB;
              if (!this.lastSps || !this.lastPps) return annexB;
              this.lastPrependedPpsId = -1;
              return Buffer.concat([
                NAL_START_CODE_4B,
                this.lastSps,
                NAL_START_CODE_4B,
                this.lastPps,
                annexB,
              ]);
            }

            // Only prepend when ppsId changes (reduces duplication and instability)
            if (this.lastPrependedPpsId === ppsId) return annexB;

            const pps = this.ppsById.get(ppsId);
            if (pps) {
              const sps = this.spsById.get(pps.spsId);
              if (sps) {
                this.lastPrependedPpsId = ppsId;
                return Buffer.concat([
                  NAL_START_CODE_4B,
                  sps,
                  NAL_START_CODE_4B,
                  pps.nal,
                  annexB,
                ]);
              }
            }
            // If the slice references a PPS we don't have, we cannot "invent it".
            // Drop the access unit until the correct PPS arrives (prevents black/garbled video).
            return Buffer.alloc(0);
          } else if (videoType === "H265") {
            // For H.265, prepend VPS, SPS, PPS if not already present
            const nals = splitH265AnnexBToNalPayloads(annexB);
            if (nals.length === 0) return annexB;

            const types = nals
              .map((n) => getH265NalType(n))
              .filter((t): t is number => t !== null);
            // If it already includes VPS/SPS/PPS, do not prepend
            if (types.includes(32) && types.includes(33) && types.includes(34))
              return annexB;

            // If there is no VCL (IRAP or non-IRAP picture), there's nothing to prepend to.
            const hasVcl = types.some(
              (t) => (t >= 0 && t <= 9) || (t >= 16 && t <= 23),
            );
            if (!hasVcl) return annexB;

            // Only prepend once to avoid duplication
            if (this.lastPrependedParamSetsH265) return annexB;

            // Prepend VPS, SPS, PPS if we have them
            if (!this.lastVps || !this.lastSpsH265 || !this.lastPpsH265)
              return annexB;

            this.lastPrependedParamSetsH265 = true;
            if (dbg.traceNativeStream) {
              this.logger?.warn(
                `[BaichuanVideoStream] Prepending H.265 VPS/SPS/PPS to frame`,
              );
            }
            return Buffer.concat([
              NAL_START_CODE_4B,
              this.lastVps,
              NAL_START_CODE_4B,
              this.lastSpsH265,
              NAL_START_CODE_4B,
              this.lastPpsH265,
              annexB,
            ]);
          }
          return annexB;
        };

        const dumpNalSummary = (
          annexB: Buffer,
          label: string,
          microseconds: number,
        ) => {
          if (!dbg.dumpNals) return;
          try {
            if (dbg.dumpEnabled) ensureDumpDir(dbg);
            const outDir = dbg.dumpDir;
            const nals = splitAnnexBToNalPayloads(annexB);
            const types = nals.map((n) => (n[0] ?? 0) & 0x1f);
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
            // Keep this non-blocking: sync FS writes can starve BCUDP ACK/keepalive.
            // Also cap total dumped lines to avoid unbounded I/O.
            if (this.dumpNalLines >= 20_000) return;
            const line =
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
              }) + "\n";
            this.dumpNalLines++;
            const outPath = path.join(outDir, "nal_dump.ndjson");
            this.dumpIo.enqueue(async () => {
              await fs.promises.appendFile(outPath, line);
            });
          } catch {
            // ignore
          }
        };

        // Media payloads are expected to be plaintext here because we select the best
        // raw vs decrypted candidate before running BcMedia decoding.
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
          // Detect actual video codec from NAL data (some cameras report wrong codec in BcMedia header)
          let videoType = media.videoType;
          const detectedCodec = detectVideoCodecFromNal(media.data);
          if (detectedCodec && detectedCodec !== videoType) {
            if (dbg.traceNativeStream) {
              this.logger?.warn(
                `[BaichuanVideoStream] Codec mismatch in Iframe: header says ${videoType}, NAL says ${detectedCodec} - using ${detectedCodec}`,
              );
            }
            videoType = detectedCodec;
          }

          // Convert to Annex-B format (different converters for H.264 and H.265)
          const annexBData =
            videoType === "H265"
              ? convertH265ToAnnexB(media.data)
              : convertToAnnexB(media.data);

          const isKeyframe = true;

          maybeCacheParamSets(annexBData, "Iframe", videoType);
          const outAnnex = prependParamSetsIfNeeded(annexBData, videoType);

          if (outAnnex.length === 0) {
            if (dbg.traceNativeStream) {
              this.logger?.warn(
                `[BaichuanVideoStream] Iframe DROPPED: outAnnex is empty`,
              );
            }
            continue;
          }

          dumpNalSummary(outAnnex, "Iframe", media.microseconds);

          // Guard rail: do not emit invalid keyframes (prevents cascading parameter set issues)
          if (videoType === "H264") {
            if (
              !isValidH264AnnexBAccessUnit(outAnnex) ||
              !isH264KeyframeAnnexB(outAnnex)
            ) {
              if (dbg.traceNativeStream) {
                this.logger?.warn(
                  `[BaichuanVideoStream] Dropping invalid H.264 Iframe (Annex-B) len=${outAnnex.length}`,
                );
              }
              continue;
            }
          } else if (videoType === "H265") {
            // For H.265, validate access unit and check for keyframe (IRAP with VPS/SPS/PPS)
            if (!isValidH265AnnexBAccessUnit(outAnnex)) {
              if (dbg.traceNativeStream) {
                this.logger?.warn(
                  `[BaichuanVideoStream] Dropping invalid H.265 Iframe (Annex-B) len=${outAnnex.length} first16=${outAnnex.subarray(0, 16).toString("hex")}`,
                );
              }
              continue;
            }
            // Check if it's a proper keyframe (should have VPS/SPS/PPS and IRAP)
            if (!isH265KeyframeAnnexB(outAnnex)) {
              if (dbg.traceNativeStream) {
                this.logger?.warn(
                  `[BaichuanVideoStream] H.265 Iframe missing VPS/SPS/PPS or IRAP, but continuing len=${outAnnex.length}`,
                );
              }
              // Continue anyway - the parameter sets might be prepended
            }
          }

          // Save a one-off sample for offline analysis
          if (dbg.traceNativeStream && !this.debugSavedSamples) {
            try {
              const outDir = dbg.dumpDir;
              fs.mkdirSync(outDir, { recursive: true });
              if (media.type === "Iframe" && hasStartCodes(annexBData)) {
                fs.writeFileSync(
                  path.join(outDir, "iframe_annexb.bin"),
                  annexBData,
                );
              }
            } catch {
              // do not block streaming for debug
            }
          }

          // If debug is off, still emit a single warning the first time we see non-AnnexB output.
          // This helps diagnose models that prepend headers or use nonstandard framing.
          if (!this.warnedNonAnnexBOnce && !hasStartCodes(annexBData)) {
            this.warnedNonAnnexBOnce = true;
            const b = media.data;
            const head = b.subarray(0, Math.min(24, b.length)).toString("hex");
            const headAnnex = annexBData
              .subarray(0, Math.min(24, annexBData.length))
              .toString("hex");
            this.logger?.warn(
              `[BaichuanVideoStream] WARNING: non-AnnexB frame after conversion (${media.type} ${media.videoType}) ` +
                `len=${b.length} head=${head} convertedLen=${annexBData.length} convertedHead=${headAnnex}`,
            );
          }

          this.emit("videoFrame", outAnnex);
          this.emit("videoAccessUnit", {
            data: outAnnex,
            isKeyframe,
            videoType, // Use the detected/corrected videoType, not media.videoType
            microseconds: media.microseconds,
            ...(media.type === "Iframe" && "time" in media
              ? media.time !== undefined
                ? { time: media.time }
                : {}
              : {}),
          });
          videoFramesEmitted++;

          if (totalFramesReceived <= 5 || videoFramesEmitted <= 5) {
            const sc = hasStartCodes(annexBData) ? "yes" : "no";
            if (rtspDebug) {
              this.logger?.log(
                `[BaichuanVideoStream] Emitted ${media.type} (${media.videoType}) ${media.data.length} bytes -> ${annexBData.length} bytes (Annex-B, startCode:${sc})`,
              );
            }
          }
        } else if (media.type === "Pframe") {
          const chunk = media.data;

          // Detect actual video codec from NAL data (some cameras report wrong codec in BcMedia header)
          let videoType = media.videoType;
          const detectedCodec = detectVideoCodecFromNal(chunk);
          if (detectedCodec && detectedCodec !== videoType) {
            videoType = detectedCodec;
          }

          // P-frame: often not a complete access unit but an "RTP-like" payload (FU-A/STAP)
          // which must be depacketized with state. Do NOT run AVCC heuristics before depacketizing.
          // First try AVCC/HVCC -> AnnexB (some models send P-frames length-prefixed).
          // If we still don't get start codes, try RFC6184 depacketizer (FU-A/STAP) for H.264.
          // Note: H.265 RTP depacketization is similar but uses different NAL unit types.
          const annexBOrRaw = hasStartCodes(chunk)
            ? chunk
            : videoType === "H265"
              ? convertH265ToAnnexB(chunk)
              : convertToAnnexB(chunk);

          // For H.264, use the depacketizer. For H.265, we might need a similar depacketizer in the future.
          const parts = hasStartCodes(annexBOrRaw)
            ? [annexBOrRaw]
            : videoType === "H265"
              ? this.depacketizerH265.push(chunk)
              : this.depacketizer.push(chunk);

          if (parts.length === 0) {
            // incomplete fragment (FU-A mid) or unrecognized payload: wait for more packets
            continue;
          }

          for (const p of parts) {
            maybeCacheParamSets(p, "Pframe", videoType);
            const outP0 = prependParamSetsIfNeeded(p, videoType);
            if (outP0.length === 0) continue;
            const outP = outP0;
            dumpNalSummary(outP, "Pframe", media.microseconds);
            // Guard rail: drop only if the access unit is invalid (codec-specific)
            const isValid =
              videoType === "H265"
                ? isValidH265AnnexBAccessUnit(outP)
                : isValidH264AnnexBAccessUnit(outP);
            if (!isValid) {
              if (dbg.traceNativeStream && this.debugH264LogsLeft > 0) {
                this.debugH264LogsLeft--;
                const head = outP
                  .subarray(0, Math.min(24, outP.length))
                  .toString("hex");
                this.logger?.warn(
                  `[BaichuanVideoStream] Dropping invalid Pframe (${videoType}): len=${outP.length} head=${head}`,
                );
              }
              continue;
            }
            this.emit("videoFrame", outP);
            this.emit("videoAccessUnit", {
              data: outP,
              isKeyframe: false,
              videoType: videoType,
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
      if (
        totalFramesReceived <= 10 ||
        (totalFramesReceived % 20 === 0 &&
          (videoFramesEmitted > 0 || audioFramesEmitted > 0))
      ) {
        if (rtspDebug) {
          this.logger?.log(
            `[BaichuanVideoStream] Frame #${totalFramesReceived}: emitted ${videoFramesEmitted} video frames, ${audioFramesEmitted} audio frames`,
          );
        }
      }

      // Mark liveness only when we actually produced media (not just transport frames).
      if (videoFramesEmitted > 0 || audioFramesEmitted > 0) {
        this.noteMediaActivity();
      }

      // Track total video frames emitted
      if (
        videoFramesEmitted > 0 &&
        (totalFramesReceived <= 10 || totalFramesReceived % 50 === 0)
      ) {
        let totalVideoFrames = 0;
        // Count would need to be tracked separately - for now just log
      }
    };

    this.client.on("push", this.videoFrameHandler);
    this.active = true;
    this.startWatchdog();

    // Seed liveness so the watchdog doesn't immediately restart while we are still negotiating.
    this.lastMediaAtMs = Date.now();

    // Request the video stream if the API is available.
    if (this.api) {
      try {
        // Best-effort stop: stop any existing stream on this channel/profile.
        // This ensures we start fresh when switching between variants.
        if (this.variant === "default") {
          // Default stream: best-effort stop default before starting.
          try {
            await this.api.stopVideoStream(this.channel, this.profile, {
              variant: "default",
            });
          } catch {
            // ignore
          }
        } else {
          // Variant stream: stop ONLY the same variant. Do not forcibly stop the default stream.
          // Rationale:
          // - BaichuanClient subscriptions are per msgNum, so different streams can coexist without mixing.
          // - Stopping default streams on some NVRs can add several seconds of renegotiation delay.
          try {
            await this.api.stopVideoStream(this.channel, this.profile, {
              variant: this.variant,
            });
            this.logger?.log(
              `[BaichuanVideoStream] Successfully stopped existing variant stream: ${this.variant}`,
            );
          } catch (e) {
            this.logger?.log(
              `[BaichuanVideoStream] Error stopping variant stream ${this.variant} (may not exist): ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }

        // Small delay to ensure the device has processed the stop commands
        await new Promise((resolve) => setTimeout(resolve, 100));

        // this.logger?.log(
        //   `[BaichuanVideoStream] start() calling startVideoStream: channel=${this.channel}, profile=${this.profile}, variant=${this.variant}`
        // );

        const startPromise = this.api.startVideoStream(
          this.channel,
          this.profile,
          { variant: this.variant },
        );

        // On UDP/battery cams the stream typically will NOT start automatically; wait for the response.
        // On TCP/NVR/Hub the response can be very slow; do not block stream processing on it.
        if (this.client.getTransport?.() === "udp") {
          await startPromise;
        } else {
          // Give it a brief window to fail fast (bad credentials, disconnected).
          await Promise.race([
            startPromise,
            new Promise<void>((resolve) => setTimeout(resolve, 400)),
          ]);
        }

        const updateActiveMsgNum = () => {
          try {
            const getMsgNum = (this.api as any)
              .getActiveVideoMsgNumWithVariant as
              | ((
                  ch: number,
                  p: StreamProfile,
                  v?: NativeVideoStreamVariant,
                ) => number | undefined)
              | undefined;
            const v =
              typeof getMsgNum === "function"
                ? getMsgNum(this.channel, this.profile, this.variant)
                : undefined;
            if (v !== undefined) this.activeMsgNum = v;
          } catch {
            // keep current activeMsgNum (may have been learned from frames)
          }
        };

        updateActiveMsgNum();
        void startPromise
          .then(() => updateActiveMsgNum())
          .catch((e) => {
            const err = e instanceof Error ? e : new Error(String(e));
            this.emitSafeError(err);
          });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (this.client.getTransport?.() === "udp") {
          this.stopWatchdog();
          this.active = false;
          if (this.videoFrameHandler)
            this.client.off("push", this.videoFrameHandler);
          this.videoFrameHandler = undefined;
          throw err;
        }
        this.emitSafeError(err);
      }
    }
  }

  // isVideoFrame, isAudioFrame, and extractVideoData are no longer needed
  // BcMediaParser handles all frame parsing and extraction

  /**
   * Stop video stream.
   */
  async stop(): Promise<void> {
    if (!this.active) return;

    this.stopWatchdog();

    // Ensure depacketizers don't keep FU state across restarts.
    this.depacketizer.reset();
    this.depacketizerH265.reset();

    if (this.videoFrameHandler) {
      this.client.removeListener("push", this.videoFrameHandler);
    }
    this.videoFrameHandler = undefined;

    // Note: stream-level decipher is not used here; we pick decrypted/raw before BcMedia decoding.

    // Clear codec buffer
    this.bcMediaCodec.clear();

    this.activeMsgNum = undefined;

    // Stop the video stream if the API is available
    if (this.api) {
      try {
        await this.api.stopVideoStream(this.channel, this.profile, {
          variant: this.variant,
        });
      } catch (error) {
        // Log error but continue
        this.emitSafeError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    this.active = false;
    this.emit("close");
  }

  isActive(): boolean {
    return this.active;
  }
}
