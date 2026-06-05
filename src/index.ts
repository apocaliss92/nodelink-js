export * from "./protocol/constants";
export * from "./protocol/crypto";
export * from "./protocol/framing";
export type { BaichuanFrame } from "./protocol/framing";
export * from "./protocol/xml";
export * from "./client/BaichuanClient";
export * from "./bcudp/BcUdpStream";
export * from "./reolink/http/ReolinkHttpClient";
export * from "./reolink/http/types";
export * from "./reolink/types";
export * from "./reolink/cgi/ReolinkCgiApi";
export * from "./reolink/baichuan/ReolinkBaichuanApi";
export * from "./reolink/baichuan/HlsSessionManager";
export * from "./reolink/AutodiscoveryClient";
export * from "./reolink/baichuan/types";
export * from "./reolink/baichuan/recordingFileName";
export * from "./reolink/baichuan/endpoints-server";
export * from "./reolink/baichuan/capabilities";
export {
  decideSleepInferenceTransition,
  type SleepInferencePending,
  type SleepInferenceInput,
  type SleepInferenceDecision,
} from "./reolink/baichuan/utils/sleepInference";
// DeviceAbilities is already exported via export * above
export * from "./rtsp/urls";
export * from "./rtsp/server";
export {
  asLogger,
  createDebugGateLogger,
  createLogger,
  createNullLogger,
  createTaggedLogger,
  getGlobalLogger,
  setGlobalLogger,
} from "./logging/logger";
export type { LogLevel } from "./logging/logger";
export * from "./rfc/helpers";
export * from "./rfc/rfc4571";
export * from "./rfc/rfc4571-server";
export * from "./rfc/replay-http-server";
export * from "./baichuan/stream/BaichuanVideoStream";
export * from "./baichuan/stream/BaichuanRtspServer";
export * from "./baichuan/stream/Go2rtcTcpServer";
export * from "./baichuan/stream/MpegTsMuxer";
export * from "./baichuan/stream/BaichuanHttpStreamServer";
export * from "./baichuan/stream/BaichuanMjpegServer";
export * from "./baichuan/stream/BaichuanWebRTCServer";
export * from "./baichuan/stream/BaichuanHlsServer";
export * from "./baichuan/stream/MjpegTransformer";
export * from "./baichuan/stream/BcMediaParser";
export * from "./baichuan/stream/BcMediaCodec";
export * from "./baichuan/stream/H264Converter";
export {
  BcMediaAnnexBDecoder,
  detectVideoCodecFromNal,
  type BcMediaVideoType,
  type BcMediaAudioType,
  type BcMediaAudioFrame,
  type BcMediaVideoFrame,
  type BcMediaAnnexBInfo,
  type BcMediaAnnexBDecoderStats,
} from "./baichuan/stream/BcMediaAnnexBDecoder";
export {
  H265RtpDepacketizer,
  getH265NalType,
  isH265Irap,
  isValidH265AnnexBAccessUnit,
  isH265KeyframeAnnexB,
  splitAnnexBToNalPayloads as splitH265AnnexBToNalPayloads,
  hasStartCodes as hasH265StartCodes,
  convertToAnnexB as convertH265ToAnnexB,
  extractVpsFromAnnexB,
  extractSpsFromAnnexB,
  extractPpsFromAnnexB,
} from "./baichuan/stream/H265Converter";
export type { DebugOptions, DebugConfig } from "./debug/DebugConfig";
export * from "./debug/DiagnosticsTools";
export * from "./debug/zip";
export * from "./reolink/autodetect";
export * from "./reolink/discovery";
export * from "./multifocal/compositeStream";
export * from "./multifocal/compositeRtspServer";

// Motion zone bitmap helpers (encode/decode the camera's grid valueTable)
export {
  decodeMotionScopeBitmap,
  encodeMotionScopeBitmap,
  fullCoverageScope,
} from "./reolink/baichuan/utils/motionZone";
export type { MotionZoneScope } from "./reolink/baichuan/utils/motionZone";

// Privacy-mask (Shelter) helpers — normalized 0..1 rectangle codec.
export {
  DEFAULT_SHELTER_CANVAS,
  decodePrivacyMaskZones,
  decodeShelterCoord,
  encodeShelterCoord,
  encodeShelterListXml,
  encodeTrackShelterListXml,
  extractCanvasFromShelterXml,
  patchShelterXml,
} from "./reolink/baichuan/utils/privacyMask";
export type {
  PrivacyMaskZones,
  ShelterCanvas,
  ShelterRect,
  TrackShelterRect,
} from "./reolink/baichuan/utils/privacyMask";

// AI detect cfg helpers (cmd_id 342 GET / 345 SET full).
export {
  decodeAiDetectCfg,
  patchAiDetectCfgXml,
} from "./reolink/baichuan/utils/aiDetectCfg";
export type { AiDetectCfgZone } from "./reolink/baichuan/utils/aiDetectCfg";

// Motion sensitivity schedule (per-time-band) helpers.
export {
  encodeMotionSensitivityListXml,
  patchMotionSensitivityListXml,
} from "./reolink/baichuan/utils/motionSensitivity";
export type { MotionSensitivityBand } from "./reolink/baichuan/utils/motionSensitivity";

// Auxiliary public types referenced by ReolinkBaichuanApi method signatures
export type {
  XmlJsonPrimitive,
  XmlJsonValue,
  XmlJsonObject,
} from "./reolink/baichuan/utils/xml";
export type { FloodlightTaskState } from "./reolink/baichuan/utils/whiteLed";

// Audio helpers — IMA ADPCM encoder used to feed TalkSession.sendAudio() from
// raw 16-bit PCM, plus the μ-law / A-law decoders and integer-factor upsampler
// that the RTSP Backchannel bridge needs to translate RTP PCMU / PCMA payloads
// into the 16 kHz mono PCM that Reolink's TalkAbility advertises.
export { encodeImaAdpcm } from "./reolink/baichuan/utils/imaAdpcm";
export {
  mulawToPcm16,
  alawToPcm16,
} from "./reolink/baichuan/utils/audioMulaw";
export { upsamplePcm16 } from "./reolink/baichuan/utils/audioResample";

// RTSP backchannel: a per-camera RTSP listener that feeds inbound RTP
// PCMU / PCMA audio packets into a Reolink TalkSession so a 2-way audio
// client (Frigate via go2rtc, ffmpeg, ONVIF surveillance app) can talk
// to the camera. The dedicated `BaichuanRtspBackchannelServer` lives
// next to the per-profile `BaichuanRtspServer` instances and exposes a
// profile-independent path because TalkSession is per-camera, never
// per-stream-profile.
export {
  RtspBackchannel,
  parseRtpPacket,
} from "./baichuan/stream/RtspBackchannel";
export type {
  RtspBackchannelOptions,
  BackchannelCodec,
} from "./baichuan/stream/RtspBackchannel";
export { BaichuanRtspBackchannelServer } from "./baichuan/stream/BaichuanRtspBackchannelServer";
export type { BaichuanRtspBackchannelServerOptions } from "./baichuan/stream/BaichuanRtspBackchannelServer";

// Email-push SMTP intake + bus — re-exported so consumers (Scrypted
// plugin, manager app, integration tests) can stand up an instance
// without depending on app/-only modules.
export * from "./emailPush/index";
