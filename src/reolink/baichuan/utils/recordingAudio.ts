import type { BcMediaAudioType } from "../../../baichuan/stream/BcMediaAnnexBDecoder";

/**
 * The audio a recording download carries, and the few facts a muxer needs to
 * take it as a second input without guessing.
 *
 * Both devices measured on 2026-09-20 (E1 Outdoor PoE v3.1.0.5223 standalone,
 * Home Hub v3.3.0.456 child channel 0) send **AAC-LC, 16 kHz, mono, one ADTS
 * frame per BcMedia packet**. An ADTS frame carries its own length, so the
 * concatenation in `data` is a complete elementary stream: `ffmpeg -f aac -i
 * <file> -c:a copy -bsf:a aac_adtstoasc` reads it with no side channel, which
 * is what keeps `-movflags +faststart`, a real duration and byte-Range on the
 * muxed MP4.
 */

/** Bytes of a fixed ADTS header (no CRC — `protection_absent` = 1). */
export const ADTS_HEADER_BYTES = 7;

/** An AAC access unit is always 1024 samples. */
export const ADTS_SAMPLES_PER_FRAME = 1024;

/** ADTS `sampling_frequency_index` table; index 13/14 are reserved. */
export const ADTS_SAMPLE_RATES: readonly (number | null)[] = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000,
  12_000, 11_025, 8_000, 7_350, null, null, null,
];

/** Names of the `profile` field, so a caller never re-derives them. */
export const ADTS_PROFILES: readonly string[] = [
  "Main",
  "LC",
  "SSR",
  "LTP",
];

export interface AdtsFrameHeader {
  /** 0..3; 1 is AAC-LC, which is what these cameras send. */
  profile: number;
  profileName: string;
  /** Hz, or `null` for a reserved `sampling_frequency_index`. */
  sampleRate: number | null;
  /** 1..7, or `null` when `channel_configuration` is 0 (in-band config). */
  channels: number | null;
  /** Bytes of the whole frame, header included. */
  frameLength: number;
}

/**
 * Read the ADTS header at the start of `frame`. Returns `null` when there is
 * no syncword, when the declared length cannot be a frame, or when the buffer
 * is too short — never a default, because "we could not read it" and "it is
 * 16 kHz mono" must not look the same to a muxer.
 */
export const parseAdtsHeader = (frame: Buffer): AdtsFrameHeader | null => {
  if (frame.length < ADTS_HEADER_BYTES) return null;
  const b0 = frame[0]!;
  const b1 = frame[1]!;
  if (b0 !== 0xff || (b1 & 0xf0) !== 0xf0) return null;

  const b2 = frame[2]!;
  const b3 = frame[3]!;
  const b4 = frame[4]!;
  const b5 = frame[5]!;

  const profile = (b2 >> 6) & 0x03;
  const sampleRateIndex = (b2 >> 2) & 0x0f;
  const channelConfig = ((b2 & 0x01) << 2) | ((b3 >> 6) & 0x03);
  const frameLength = ((b3 & 0x03) << 11) | (b4 << 3) | ((b5 >> 5) & 0x07);

  if (frameLength < ADTS_HEADER_BYTES) return null;

  return {
    profile,
    profileName: ADTS_PROFILES[profile] ?? "unknown",
    sampleRate: ADTS_SAMPLE_RATES[sampleRateIndex] ?? null,
    channels: channelConfig > 0 ? channelConfig : null,
    frameLength,
  };
};

/**
 * How `RecordingAudioTrack.data` is laid out.
 *
 * - `adts` — AAC in self-delimiting ADTS frames. Feed it to ffmpeg with
 *   `-f aac` and copy it with `-bsf:a aac_adtstoasc`.
 * - `adpcm` — Reolink's ADPCM blocks. No camera here produced one; the sample
 *   rate and channel count are NOT known from the wire, so they are `null`
 *   and a consumer must transcode (`-c:a aac`) rather than copy.
 * - `unknown` — audio packets arrived but the first one carries no readable
 *   ADTS header. Do not copy it blindly.
 */
export type RecordingAudioFormat = "adts" | "adpcm" | "unknown";

export interface RecordingAudioTrack {
  codec: BcMediaAudioType;
  format: RecordingAudioFormat;
  /** The concatenated frames, exactly as the camera sent them. */
  data: Buffer;
  frames: number;
  bytes: number;
  /** Hz, or `null` when the wire does not say. */
  sampleRate: number | null;
  /** or `null` when the wire does not say. */
  channels: number | null;
  /** Frames x 1024 / sampleRate for AAC; `null` when either is unknown. */
  durationSeconds: number | null;
}

/**
 * Assemble the audio track of a download. Returns `null` when no audio packet
 * arrived at all — an absent track and a silent one are different answers and
 * a caller is entitled to tell them apart.
 */
export const buildRecordingAudioTrack = (params: {
  codec: BcMediaAudioType | null;
  frames: readonly Buffer[];
}): RecordingAudioTrack | null => {
  const { codec, frames } = params;
  if (codec == null || frames.length === 0) return null;

  const data = frames.length === 1 ? frames[0]! : Buffer.concat([...frames]);

  if (codec === "Adpcm") {
    return {
      codec,
      format: "adpcm",
      data,
      frames: frames.length,
      bytes: data.length,
      sampleRate: null,
      channels: null,
      durationSeconds: null,
    };
  }

  const head = parseAdtsHeader(frames[0]!);
  if (head == null) {
    return {
      codec,
      format: "unknown",
      data,
      frames: frames.length,
      bytes: data.length,
      sampleRate: null,
      channels: null,
      durationSeconds: null,
    };
  }

  const durationSeconds =
    head.sampleRate != null && head.sampleRate > 0
      ? (frames.length * ADTS_SAMPLES_PER_FRAME) / head.sampleRate
      : null;

  return {
    codec,
    format: "adts",
    data,
    frames: frames.length,
    bytes: data.length,
    sampleRate: head.sampleRate,
    channels: head.channels,
    durationSeconds,
  };
};
