// Debug/build marker used by downstream consumers to verify the exact bundled library version.
// Intentionally constant and human-readable.
export const BAICHUAN_JS_BUILD_ID = "vendored-in-scrypted-reolink-native-2025-12-30.1";

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
export * from "./reolink/baichuan/types";
export * from "./reolink/baichuan/recordingFileName";
export * from "./reolink/baichuan/endpoints-server";
export * from "./reolink/baichuan/capabilities";
// DeviceAbilities is already exported via export * above
export * from "./rtsp/urls";
export * from "./rtsp/server";
export * from "./scrypted/helpers";
export * from "./scrypted/rfc4571";
export * from "./scrypted/rfc4571-server";
export * from "./baichuan/stream/BaichuanVideoStream";
export * from "./baichuan/stream/BaichuanRtspServer";
export * from "./baichuan/stream/BaichuanHttpStreamServer";
export * from "./baichuan/stream/BcMediaParser";
export * from "./baichuan/stream/BcMediaCodec";
export * from "./baichuan/stream/H264Converter";
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

