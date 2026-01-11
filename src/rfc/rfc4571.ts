import net from 'node:net';
import crypto from 'node:crypto';

export type VideoType = 'H264' | 'H265';

export type AudioConfig =
    | {
        codec: 'aac';
        payloadType: number;
        sampleRate: number;
        channels: number;
        configHex: string;
    }
    | {
        codec: 'opus';
        payloadType: number;
        sampleRate: number;
        channels: number;
    };

export interface VideoParamSets {
    videoType: VideoType;
    payloadType: number;
    h264?: {
        sps: Buffer;
        pps: Buffer;
        profileLevelId?: string;
    };
    h265?: {
        vps: Buffer;
        sps: Buffer;
        pps: Buffer;
    };
}

export function buildRfc4571Sdp(video: VideoParamSets, audio?: AudioConfig): string {
    let out = 'v=0\r\n';
    out += 'o=- 0 0 IN IP4 0.0.0.0\r\n';
    out += 's=No Name\r\n';
    out += 't=0 0\r\n';

    out += `m=video 0 RTP/AVP ${video.payloadType}\r\n`;
    out += 'c=IN IP4 0.0.0.0\r\n';
    out += `a=rtpmap:${video.payloadType} ${video.videoType}/90000\r\n`;

    if (video.videoType === 'H264' && video.h264) {
        const spsB64 = video.h264.sps.toString('base64');
        const ppsB64 = video.h264.pps.toString('base64');
        const pli = video.h264.profileLevelId ? `profile-level-id=${video.h264.profileLevelId};` : '';
        out += `a=fmtp:${video.payloadType} packetization-mode=1;${pli}sprop-parameter-sets=${spsB64},${ppsB64}\r\n`;
    }

    if (video.videoType === 'H265' && video.h265) {
        const vpsB64 = video.h265.vps.toString('base64');
        const spsB64 = video.h265.sps.toString('base64');
        const ppsB64 = video.h265.pps.toString('base64');
        out += `a=fmtp:${video.payloadType} sprop-vps=${vpsB64};sprop-sps=${spsB64};sprop-pps=${ppsB64}\r\n`;
    }

    if (audio?.codec === 'aac') {
        out += `m=audio 0 RTP/AVP ${audio.payloadType}\r\n`;
        out += 'c=IN IP4 0.0.0.0\r\n';
        out += 'b=AS:128\r\n';
        out += `a=rtpmap:${audio.payloadType} MPEG4-GENERIC/${audio.sampleRate}/${audio.channels}\r\n`;
        out += `a=fmtp:${audio.payloadType} profile-level-id=1; mode=AAC-hbr; sizelength=13; indexlength=3; indexdeltalength=3; config=${audio.configHex}\r\n`;
    }

    if (audio?.codec === 'opus') {
        out += `m=audio 0 RTP/AVP ${audio.payloadType}\r\n`;
        out += 'c=IN IP4 0.0.0.0\r\n';
        out += 'b=AS:128\r\n';
        out += `a=rtpmap:${audio.payloadType} opus/${audio.sampleRate}/${audio.channels}\r\n`;
    }

    return out;
}

export function splitAnnexBToNals(annexB: Buffer): Buffer[] {
    // Returns NAL units WITHOUT start codes.
    // Keep behavior aligned with reolink-baichuan-js (no aggressive trimming), since some payloads
    // may legitimately end with 0x00.
    const nals: Buffer[] = [];
    const len = annexB.length;

    const isStartCodeAt = (i: number): number => {
        if (i + 3 <= len && annexB[i] === 0x00 && annexB[i + 1] === 0x00) {
            if (annexB[i + 2] === 0x01) return 3;
            if (i + 4 <= len && annexB[i + 2] === 0x00 && annexB[i + 3] === 0x01) return 4;
        }
        return 0;
    };

    let i = 0;
    // find first start code
    while (i < len) {
        const sc = isStartCodeAt(i);
        if (sc) break;
        i++;
    }

    while (i < len) {
        const sc = isStartCodeAt(i);
        if (!sc) {
            i++;
            continue;
        }
        const nalStart = i + sc;
        let j = nalStart;
        while (j < len) {
            const sc2 = isStartCodeAt(j);
            if (sc2) break;
            j++;
        }
        if (nalStart < j) {
            const nal = annexB.subarray(nalStart, j);
            if (nal.length > 0) nals.push(nal);
        }
        i = j;
    }

    return nals;
}

function findAnnexBStartCodeOffset(data: Buffer, maxScan = 64): number {
    if (!data?.length) return -1;
    const len = Math.min(data.length, Math.max(0, maxScan));
    for (let i = 0; i + 3 < len; i++) {
        if (data[i] !== 0x00 || data[i + 1] !== 0x00) continue;
        if (data[i + 2] === 0x01) return i;
        if (data[i + 2] === 0x00 && data[i + 3] === 0x01) return i;
    }
    return -1;
}

function stripLeadingAnnexBStartCode(data: Buffer): Buffer {
    if (data.length >= 4 && data[0] === 0x00 && data[1] === 0x00) {
        if (data[2] === 0x01) return data.subarray(3);
        if (data[2] === 0x00 && data[3] === 0x01) return data.subarray(4);
    }
    return data;
}

function splitLengthPrefixedToNals(data: Buffer, lengthSize: 1 | 2 | 3 | 4, endian: 'be' | 'le'): Buffer[] {
    // AVCC/HVCC style: [length][NAL bytes]...
    // lengthSize is typically 4, but some devices/streams use 2.
    const nals: Buffer[] = [];
    let offset = 0;

    const readLen = (buf: Buffer, at: number): number => {
        if (lengthSize === 4) return endian === 'be' ? buf.readUInt32BE(at) : buf.readUInt32LE(at);
        if (lengthSize === 2) return endian === 'be' ? buf.readUInt16BE(at) : buf.readUInt16LE(at);
        if (lengthSize === 3) {
            const b0 = buf[at]!;
            const b1 = buf[at + 1]!;
            const b2 = buf[at + 2]!;
            return endian === 'be'
                ? ((b0 << 16) | (b1 << 8) | b2) >>> 0
                : ((b2 << 16) | (b1 << 8) | b0) >>> 0;
        }
        return buf.readUInt8(at);
    };

    while (offset + lengthSize <= data.length) {
        const nalLen = readLen(data, offset);
        offset += lengthSize;

        // 0-length doesn't make sense for an access unit; treat as parse failure.
        if (!nalLen) return [];
        if (offset + nalLen > data.length) return [];

        const nal = data.subarray(offset, offset + nalLen);
        offset += nalLen;
        if (nal.length) nals.push(nal);
    }

    // Must consume the buffer cleanly; otherwise treat as unknown format.
    if (offset !== data.length) return [];
    return nals;
}

function scoreNals(videoType: VideoType | undefined, nals: Buffer[]): number {
    if (!nals.length) return Number.POSITIVE_INFINITY;

    let invalid = 0;
    for (const nal of nals) {
        if (!nal.length) {
            invalid++;
            continue;
        }

        // forbidden_zero_bit must be 0 for both H264 and H265
        if ((nal[0]! & 0x80) !== 0) {
            invalid += 10;
            continue;
        }

        if (videoType === 'H264') {
            const t = nal[0]! & 0x1f;
            // 1..23 are defined; 24..31 are aggreg/fragmentation/reserved and should not appear in raw AUs.
            if (t < 1 || t > 23) invalid++;
        }
        else if (videoType === 'H265') {
            if (nal.length < 2) {
                invalid++;
                continue;
            }
            const t = (nal[0]! >> 1) & 0x3f;
            // Reject reserved/forbidden types that strongly suggest mis-parsing.
            // Keep common types: 0-29 (VCL), 32-40 (VPS/SPS/PPS/AUD/SEI/etc), 48-50 (AP/FU/PACI)
            const isValid =
                (t >= 0 && t <= 29) ||
                (t >= 32 && t <= 40) ||
                (t >= 48 && t <= 50);
            if (!isValid) invalid++;
        }
    }

    return invalid;
}

function splitAccessUnitToNalsBestEffort(accessUnit: Buffer, videoType?: VideoType): Buffer[] {
    if (!accessUnit?.length) return [];

    const candidates: Buffer[][] = [];

    // Annex-B is only considered if a start code appears at the start (or shortly after);
    // scanning the entire buffer can false-positive on random 0x000001 sequences.
    const scOffset = findAnnexBStartCodeOffset(accessUnit, 64);
    if (scOffset >= 0) {
        const annex = scOffset === 0 ? accessUnit : accessUnit.subarray(scOffset);
        const nals = splitAnnexBToNals(annex);
        if (nals.length) candidates.push(nals);
    }

    // If it looks like AVCC/HVCC (often starts with 0x00 0x00 ..), try length-prefixed parsing.
    // Some Reolink streams appear to use 2-byte NAL lengths.
    candidates.push(splitLengthPrefixedToNals(accessUnit, 4, 'be'));
    candidates.push(splitLengthPrefixedToNals(accessUnit, 4, 'le'));
    candidates.push(splitLengthPrefixedToNals(accessUnit, 3, 'be'));
    candidates.push(splitLengthPrefixedToNals(accessUnit, 3, 'le'));
    candidates.push(splitLengthPrefixedToNals(accessUnit, 2, 'be'));
    candidates.push(splitLengthPrefixedToNals(accessUnit, 2, 'le'));
    candidates.push(splitLengthPrefixedToNals(accessUnit, 1, 'be'));

    // Single NAL without start code (or unknown packaging). Strip a leading start code if present.
    const stripped = stripLeadingAnnexBStartCode(accessUnit);
    if (stripped.length) candidates.push([stripped]);

    let best: Buffer[] = [];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const cand of candidates) {
        if (!cand.length) continue;
        const s = scoreNals(videoType, cand);
        if (s < bestScore) {
            bestScore = s;
            best = cand;
            if (bestScore === 0) break;
        }
    }

    return best;
}

export function extractH264ParamSetsFromAccessUnit(annexB: Buffer): { sps?: Buffer; pps?: Buffer; profileLevelId?: string } {
    const nals = splitAccessUnitToNalsBestEffort(annexB, 'H264');
    let sps: Buffer | undefined;
    let pps: Buffer | undefined;
    let profileLevelId: string | undefined;

    for (const nal of nals) {
        if (nal.length < 1) continue;
        const nalType = nal[0]! & 0x1f;
        if (nalType === 7) {
            sps = nal;
            if (nal.length >= 4) {
                const hex = Buffer.from([nal[1]!, nal[2]!, nal[3]!]).toString('hex');
                profileLevelId = hex;
            }
        }
        else if (nalType === 8) {
            pps = nal;
        }
    }

    const out: { sps?: Buffer; pps?: Buffer; profileLevelId?: string } = {};
    if (sps) out.sps = sps;
    if (pps) out.pps = pps;
    if (profileLevelId) out.profileLevelId = profileLevelId;
    return out;
}

export function extractH265ParamSetsFromAccessUnit(annexB: Buffer): { vps?: Buffer; sps?: Buffer; pps?: Buffer } {
    const nals = splitAccessUnitToNalsBestEffort(annexB, 'H265');
    let vps: Buffer | undefined;
    let sps: Buffer | undefined;
    let pps: Buffer | undefined;

    for (const nal of nals) {
        if (nal.length < 2) continue;
        const nalType = (nal[0]! >> 1) & 0x3f;
        if (nalType === 32) vps = nal;
        else if (nalType === 33) sps = nal;
        else if (nalType === 34) pps = nal;
    }

    const out: { vps?: Buffer; sps?: Buffer; pps?: Buffer } = {};
    if (vps) out.vps = vps;
    if (sps) out.sps = sps;
    if (pps) out.pps = pps;
    return out;
}

const aacSampleRates = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
    16000, 12000, 11025, 8000, 7350,
];

export function buildAacAudioSpecificConfigHex(params: { sampleRate: number; channels: number; audioObjectType?: number }): string | undefined {
    const { sampleRate, channels } = params;
    const audioObjectType = params.audioObjectType ?? 2; // AAC-LC
    const samplingFreqIndex = aacSampleRates.indexOf(sampleRate);
    if (samplingFreqIndex < 0) return;
    if (!Number.isFinite(channels) || channels <= 0 || channels > 15) return;
    if (!Number.isFinite(audioObjectType) || audioObjectType <= 0 || audioObjectType > 31) return;

    // AudioSpecificConfig (2 bytes, left-aligned)
    const asc = ((audioObjectType & 0x1f) << 11) | ((samplingFreqIndex & 0x0f) << 7) | ((channels & 0x0f) << 3);
    return asc.toString(16).padStart(4, '0');
}

export function parseAdtsHeader(adtsFrame: Buffer): { headerLength: number; sampleRate: number; channels: number; configHex: string } | null {
    if (adtsFrame.length < 7) return null;
    if (adtsFrame[0]! !== 0xff || (adtsFrame[1]! & 0xf0) !== 0xf0) return null;

    const protectionAbsent = (adtsFrame[1]! & 0x01) === 1;
    const profile = (adtsFrame[2]! & 0xc0) >> 6; // 0=Main,1=LC...
    const audioObjectType = profile + 1;
    const samplingFreqIndex = (adtsFrame[2]! & 0x3c) >> 2;
    const sampleRate = aacSampleRates[samplingFreqIndex] ?? 0;
    const channels = ((adtsFrame[2]! & 0x01) << 2) | ((adtsFrame[3]! & 0xc0) >> 6);

    if (!sampleRate || !channels) return null;

    const headerLength = protectionAbsent ? 7 : 9;
    if (adtsFrame.length < headerLength) return null;

    // AudioSpecificConfig (2 bytes, left-aligned)
    const asc = ((audioObjectType & 0x1f) << 11) | ((samplingFreqIndex & 0x0f) << 7) | ((channels & 0x0f) << 3);
    const configHex = asc.toString(16).padStart(4, '0');

    return { headerLength, sampleRate, channels, configHex };
}

export interface RtpPacketizationOptions {
    maxRtpPayload: number;
}

class RtpWriter {
    private seq = 0;
    private timestamp = 0;
    private ssrc = crypto.randomBytes(4).readUInt32BE(0);

    constructor(private payloadType: number) {
        this.seq = crypto.randomBytes(2).readUInt16BE(0);
    }

    setTimestamp(ts: number) {
        this.timestamp = ts >>> 0;
    }

    getTimestamp(): number {
        return this.timestamp >>> 0;
    }

    advanceTimestamp(delta: number) {
        this.timestamp = (this.timestamp + (delta >>> 0)) >>> 0;
    }

    writePacket(payload: Buffer, marker: boolean): Buffer {
        const header = Buffer.alloc(12);
        header[0] = 0x80;
        header[1] = (marker ? 0x80 : 0x00) | (this.payloadType & 0x7f);
        header.writeUInt16BE(this.seq & 0xffff, 2);
        header.writeUInt32BE(this.timestamp >>> 0, 4);
        header.writeUInt32BE(this.ssrc >>> 0, 8);
        this.seq = (this.seq + 1) & 0xffff;
        return Buffer.concat([header, payload]);
    }
}

export function packetizeH264(nal: Buffer, rtp: RtpWriter, opts: RtpPacketizationOptions, markerOnLast: boolean, isLastNal: boolean): Buffer[] {
    const max = opts.maxRtpPayload;
    const out: Buffer[] = [];
    if (nal.length <= max) {
        out.push(rtp.writePacket(nal, markerOnLast && isLastNal));
        return out;
    }

    const nal0 = nal[0]!;
    const f = nal0 & 0x80;
    const nri = nal0 & 0x60;
    const type = nal0 & 0x1f;
    const fuIndicator = f | nri | 28;

    const data = nal.subarray(1);
    let offset = 0;
    while (offset < data.length) {
        const remaining = data.length - offset;
        const chunkLen = Math.min(remaining, max - 2);
        const start = offset === 0;
        const end = offset + chunkLen >= data.length;
        const fuHeader = (start ? 0x80 : 0x00) | (end ? 0x40 : 0x00) | (type & 0x1f);
        const payload = Buffer.concat([Buffer.from([fuIndicator, fuHeader]), data.subarray(offset, offset + chunkLen)]);
        out.push(rtp.writePacket(payload, markerOnLast && isLastNal && end));
        offset += chunkLen;
    }

    return out;
}

export function packetizeH265(nal: Buffer, rtp: RtpWriter, opts: RtpPacketizationOptions, markerOnLast: boolean, isLastNal: boolean): Buffer[] {
    const max = opts.maxRtpPayload;
    const out: Buffer[] = [];
    if (nal.length <= max) {
        out.push(rtp.writePacket(nal, markerOnLast && isLastNal));
        return out;
    }

    if (nal.length < 3) return out;

    const nalHeader0 = nal[0]!;
    const nalHeader1 = nal[1]!;
    const nalType = (nalHeader0 >> 1) & 0x3f;

    // FU indicator: F + type=49 + layerId/tid bits preserved.
    const fuIndicator0 = (nalHeader0 & 0x81) | (49 << 1);
    const fuIndicator1 = nalHeader1;

    const data = nal.subarray(2);
    let offset = 0;
    while (offset < data.length) {
        const remaining = data.length - offset;
        const chunkLen = Math.min(remaining, max - 3);
        const start = offset === 0;
        const end = offset + chunkLen >= data.length;
        const fuHeader = (start ? 0x80 : 0x00) | (end ? 0x40 : 0x00) | (nalType & 0x3f);
        const payload = Buffer.concat([
            Buffer.from([fuIndicator0, fuIndicator1, fuHeader]),
            data.subarray(offset, offset + chunkLen),
        ]);
        out.push(rtp.writePacket(payload, markerOnLast && isLastNal && end));
        offset += chunkLen;
    }

    return out;
}

export function packetizeAacAdtsFrame(adts: Buffer, rtp: RtpWriter): { packets: Buffer[]; config?: { sampleRate: number; channels: number; configHex: string } } {
    const parsed = parseAdtsHeader(adts);
    if (!parsed) return { packets: [] };
    const raw = adts.subarray(parsed.headerLength);
    if (!raw.length) return { packets: [] };

    // RFC 3640: AU-headers-length (16 bits) + AU-header (16 bits)
    const auHeadersLength = Buffer.from([0x00, 0x10]);
    const auSize = raw.length & 0x1fff;
    const auHeader = Buffer.alloc(2);
    auHeader[0] = (auSize >> 5) & 0xff;
    auHeader[1] = (auSize & 0x1f) << 3;

    const payload = Buffer.concat([auHeadersLength, auHeader, raw]);
    return {
        packets: [rtp.writePacket(payload, true)],
        config: { sampleRate: parsed.sampleRate, channels: parsed.channels, configHex: parsed.configHex },
    };
}

export function packetizeAacRawFrame(raw: Buffer, rtp: RtpWriter): { packets: Buffer[] } {
    if (!raw?.length) return { packets: [] };

    // RFC 3640: AU-headers-length (16 bits) + AU-header (16 bits)
    const auHeadersLength = Buffer.from([0x00, 0x10]);
    const auSize = raw.length & 0x1fff;
    const auHeader = Buffer.alloc(2);
    auHeader[0] = (auSize >> 5) & 0xff;
    auHeader[1] = (auSize & 0x1f) << 3;

    const payload = Buffer.concat([auHeadersLength, auHeader, raw]);
    return {
        packets: [rtp.writePacket(payload, true)],
    };
}

export interface Rfc4571Client {
    socket: net.Socket;
    needsKeyframe: boolean;
    sentVideoConfig: boolean;
}

export class Rfc4571Muxer {
    private clients = new Set<Rfc4571Client>();
    private closed = false;

    private videoRtp: RtpWriter;
    private audioRtp: RtpWriter | undefined;

    // Timestamp tracking
    // bcmedia microseconds is a u32 clock that may wrap (2^32) and may reset on stream restarts.
    // Additionally, it may jump forward unexpectedly. Since we do not buffer, large forward jumps
    // cause downstream schedulers to detect discontinuities.
    //
    // Strategy:
    // - unwrap u32 wraps when likely
    // - treat backwards jumps as restarts
    // - use microseconds deltas only when "reasonable"; otherwise advance using a smoothed/fallback delta
    private videoLastUsRaw: number | undefined;
    private videoUsWrapOffset = 0;
    private videoLastAbsUs: number | undefined;
    private videoAvgDeltaUs: number | undefined;
    private readonly videoClockRate = 90000;
    private readonly fallbackVideoIncrement: number;
    private readonly fallbackVideoDeltaUs: number;
    private readonly maxTrustedDeltaUs = 500_000; // 0.5s
    private readonly emaAlpha = 0.1;

    // Throttled logging to avoid spamming in hot paths.
    private videoTimingLogState: {
        lastUntrustedDeltaLogMs: number;
        lastWrapLogMs: number;
        lastResetLogMs: number;
        untrustedDeltaCount: number;
        wrapCount: number;
        resetCount: number;
    } = {
        lastUntrustedDeltaLogMs: 0,
        lastWrapLogMs: 0,
        lastResetLogMs: 0,
        untrustedDeltaCount: 0,
        wrapCount: 0,
        resetCount: 0,
    };

    private cachedH264ParamSetsAnnexB: Buffer | undefined;
    private cachedH265ParamSetsAnnexB: Buffer | undefined;

    constructor(
        private logger: Console,
        private videoPayloadType: number,
        audioPayloadType: number | undefined,
        videoFpsFallback = 25,
        private maxRtpPayload = 1200,
    ) {
        this.videoRtp = new RtpWriter(videoPayloadType);
        if (audioPayloadType !== undefined) {
            this.audioRtp = new RtpWriter(audioPayloadType);
        }
        this.fallbackVideoIncrement = Math.max(1, Math.round(this.videoClockRate / Math.max(1, videoFpsFallback)));
        this.fallbackVideoDeltaUs = Math.max(1, Math.round((this.fallbackVideoIncrement * 1_000_000) / this.videoClockRate));
    }

    addClient(socket: net.Socket) {
        if (this.closed) {
            socket.destroy();
            return;
        }

        const client: Rfc4571Client = { socket, needsKeyframe: true, sentVideoConfig: false };
        this.clients.add(client);

        const cleanup = () => {
            this.clients.delete(client);
            try {
                socket.destroy();
            } catch {
                // ignore
            }
        };

        socket.on('error', cleanup);
        socket.on('close', cleanup);
    }

    private static readonly ANNEXB_START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);

    private static joinAnnexBNals(...nals: Array<Buffer | null | undefined>): Buffer | undefined {
        const present = nals.filter((n): n is Buffer => !!n && n.length > 0);
        if (!present.length) return;
        const parts: Buffer[] = [];
        for (const nal of present) {
            parts.push(Rfc4571Muxer.ANNEXB_START_CODE, nal);
        }
        return Buffer.concat(parts);
    }

    private updateVideoParamSetsFromAccessUnit(videoType: VideoType, accessUnit: Buffer): void {
        if (!accessUnit?.length) return;

        if (videoType === 'H264') {
            const { sps, pps } = extractH264ParamSetsFromAccessUnit(accessUnit);
            if (sps && pps) {
                this.cachedH264ParamSetsAnnexB = Rfc4571Muxer.joinAnnexBNals(sps, pps);
            }
            return;
        }

        const { vps, sps, pps } = extractH265ParamSetsFromAccessUnit(accessUnit);
        if (vps && sps && pps) {
            this.cachedH265ParamSetsAnnexB = Rfc4571Muxer.joinAnnexBNals(vps, sps, pps);
        }
    }

    private sendCachedVideoConfigToClient(videoType: VideoType, client: Rfc4571Client): void {
        if (this.closed) return;
        if (client.sentVideoConfig) return;

        const paramSetsAnnexB = videoType === 'H265' ? this.cachedH265ParamSetsAnnexB : this.cachedH264ParamSetsAnnexB;
        if (!paramSetsAnnexB?.length) return;

        const nals = splitAccessUnitToNalsBestEffort(paramSetsAnnexB, videoType);
        if (!nals.length) return;

        const opts: RtpPacketizationOptions = { maxRtpPayload: this.maxRtpPayload };
        for (let i = 0; i < nals.length; i++) {
            const nal = nals[i]!;
            const isLastNal = i === nals.length - 1;
            const packets = videoType === 'H265'
                ? packetizeH265(nal, this.videoRtp, opts, false, isLastNal)
                : packetizeH264(nal, this.videoRtp, opts, false, isLastNal);

            for (const pkt of packets) {
                this.writeRtpPacketToClient(client, pkt);
            }
        }

        client.sentVideoConfig = true;
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        for (const c of Array.from(this.clients)) {
            try {
                c.socket.destroy();
            } catch {
                // ignore
            }
        }
        this.clients.clear();
    }

    private writeRtpPacketToClient(client: Rfc4571Client, pkt: Buffer) {
        if (client.socket.destroyed || !client.socket.writable) return;

        const header = Buffer.alloc(2);
        header.writeUInt16BE(pkt.length & 0xffff, 0);
        const framed = Buffer.concat([header, pkt]);

        try {
            client.socket.write(framed);
        }
        catch {
            try {
                client.socket.destroy();
            }
            catch {
                // ignore
            }
        }
    }

    private writeRtpPacketToClients(pkt: Buffer, predicate: (client: Rfc4571Client) => boolean) {
        for (const c of this.clients) {
            if (!predicate(c)) continue;
            this.writeRtpPacketToClient(c, pkt);
        }
    }

    private resetVideoTimestampMapping(): void {
        // Reset microseconds tracking/mapping, but keep RTP writer state (seq/ssrc/timestamp).
        this.videoLastUsRaw = undefined;
        this.videoUsWrapOffset = 0;
        this.videoLastAbsUs = undefined;
        this.videoAvgDeltaUs = undefined;
    }

    private logVideoTiming(kind: 'untrusted-delta' | 'wrap' | 'reset', message: string): void {
        const now = Date.now();
        const intervalMs = 5000;
        const state = this.videoTimingLogState;
        if (kind === 'untrusted-delta') {
            state.untrustedDeltaCount++;
            if (now - state.lastUntrustedDeltaLogMs < intervalMs) return;
            state.lastUntrustedDeltaLogMs = now;
            this.logger.warn(`[rfc4571] video timing: ${message} (untrustedDeltaCount=${state.untrustedDeltaCount})`);
            return;
        }
        if (kind === 'wrap') {
            state.wrapCount++;
            if (now - state.lastWrapLogMs < intervalMs) return;
            state.lastWrapLogMs = now;
            this.logger.warn(`[rfc4571] video timing: ${message} (wrapCount=${state.wrapCount})`);
            return;
        }
        state.resetCount++;
        if (now - state.lastResetLogMs < intervalMs) return;
        state.lastResetLogMs = now;
        this.logger.warn(`[rfc4571] video timing: ${message} (resetCount=${state.resetCount})`);
    }

    private advanceVideoTimestampFallback(): void {
        this.videoRtp.advanceTimestamp(this.fallbackVideoIncrement);
    }

    setVideoTimestampFromMicroseconds(frameMicroseconds: number | null | undefined) {
        if (frameMicroseconds === null || frameMicroseconds === undefined) {
            this.advanceVideoTimestampFallback();
            return;
        }
        if (!Number.isFinite(frameMicroseconds)) {
            this.advanceVideoTimestampFallback();
            return;
        }

        const curUsRaw = (frameMicroseconds >>> 0) as number;

        if (this.videoLastUsRaw !== undefined) {
            const lastUsRaw = this.videoLastUsRaw;
            if (curUsRaw < lastUsRaw) {
                // Heuristic: treat as wrap only if last is near max and current is near min.
                const wrapLikely = lastUsRaw > 0xf0000000 && curUsRaw < 0x0fffffff;
                if (wrapLikely) {
                    this.videoUsWrapOffset += 0x1_0000_0000;
                    this.logVideoTiming('wrap', `detected u32 wrap (lastUsRaw=${lastUsRaw} curUsRaw=${curUsRaw} wrapOffset=${this.videoUsWrapOffset})`);
                } else {
                    // Likely stream restart / discontinuity: reset mapping.
                    this.logVideoTiming('reset', `detected backwards jump; resetting mapping (lastUsRaw=${lastUsRaw} curUsRaw=${curUsRaw})`);
                    this.resetVideoTimestampMapping();
                }
            }
        }

        this.videoLastUsRaw = curUsRaw;
        const absUs = this.videoUsWrapOffset + curUsRaw;

        if (this.videoLastAbsUs === undefined) {
            this.videoLastAbsUs = absUs;
            if (this.videoAvgDeltaUs === undefined) this.videoAvgDeltaUs = this.fallbackVideoDeltaUs;
            return;
        }

        const deltaUs = absUs - this.videoLastAbsUs;
        this.videoLastAbsUs = absUs;

        const trusted = Number.isFinite(deltaUs) && deltaUs > 0 && deltaUs <= this.maxTrustedDeltaUs;
        let effectiveDeltaUs: number;
        if (trusted) {
            const prevAvg = this.videoAvgDeltaUs ?? deltaUs;
            this.videoAvgDeltaUs = prevAvg + (deltaUs - prevAvg) * this.emaAlpha;
            effectiveDeltaUs = deltaUs;
        }
        else {
            this.logVideoTiming(
                'untrusted-delta',
                `discarded deltaUs=${deltaUs} (absUs=${absUs} lastAbsUs=${this.videoLastAbsUs} avgDeltaUs=${this.videoAvgDeltaUs ?? 'n/a'}); using fallback`);
            effectiveDeltaUs = this.videoAvgDeltaUs ?? this.fallbackVideoDeltaUs;
        }

        const inc = Math.max(1, Math.round((effectiveDeltaUs * this.videoClockRate) / 1_000_000));
        this.videoRtp.advanceTimestamp(inc);
    }

    sendVideoAccessUnit(videoType: VideoType, accessUnitAnnexB: Buffer, isKeyframe: boolean, microseconds: number | null | undefined) {
        if (this.closed) return;

        // Always attempt to learn current VPS/SPS/PPS (or SPS/PPS) even if no clients are connected,
        // so that the first client can be primed immediately.
        this.updateVideoParamSetsFromAccessUnit(videoType, accessUnitAnnexB);

        const nals = splitAccessUnitToNalsBestEffort(accessUnitAnnexB, videoType);
        if (!nals.length) return;

        // Some sources mislabel keyframes. Derive a best-effort keyframe flag from NAL types
        // to avoid per-client gating getting stuck (symptom: 1 frame per GOP).
        let derivedKeyframe = false;
        if (videoType === 'H264') {
            for (const nal of nals) {
                const t = nal[0]! & 0x1f;
                if (t === 5) { // IDR
                    derivedKeyframe = true;
                    break;
                }
            }
        }
        else {
            for (const nal of nals) {
                if (nal.length < 2) continue;
                const t = (nal[0]! >> 1) & 0x3f;
                // IRAP pictures: 16..23 (BLA/IDR/CRA)
                if (t >= 16 && t <= 23) {
                    derivedKeyframe = true;
                    break;
                }
            }
        }

        const effectiveKeyframe = isKeyframe || derivedKeyframe;

        // gate per-client until keyframe: do NOT stall existing synced clients.
        // If a new client connects (needsKeyframe=true), only that client will wait.
        const shouldSendTo = (c: Rfc4571Client) => effectiveKeyframe ? true : !c.needsKeyframe;
        let hasAnyTarget = false;
        for (const c of this.clients) {
            if (shouldSendTo(c)) {
                hasAnyTarget = true;
                break;
            }
        }
        // If no clients are ready for media yet (e.g. all are waiting for keyframe),
        // we can still send cached video config to help decoders initialize.
        if (!hasAnyTarget) {
            for (const c of this.clients) {
                if (!c.needsKeyframe) continue;
                this.sendCachedVideoConfigToClient(videoType, c);
            }
            return;
        }

        this.setVideoTimestampFromMicroseconds(microseconds);

        // Prime clients waiting for keyframe with VPS/SPS/PPS (or SPS/PPS) when available.
        for (const c of this.clients) {
            if (!c.needsKeyframe) continue;
            this.sendCachedVideoConfigToClient(videoType, c);
        }

        const opts: RtpPacketizationOptions = { maxRtpPayload: this.maxRtpPayload };
        for (let i = 0; i < nals.length; i++) {
            const nal = nals[i]!;
            const isLastNal = i === nals.length - 1;
            const packets = videoType === 'H265'
                ? packetizeH265(nal, this.videoRtp, opts, true, isLastNal)
                : packetizeH264(nal, this.videoRtp, opts, true, isLastNal);

            for (const pkt of packets) this.writeRtpPacketToClients(pkt, shouldSendTo);
        }

        // mark clients as started when the keyframe passes through
        if (effectiveKeyframe) {
            for (const c of this.clients) c.needsKeyframe = false;
        }
    }

    sendAudioAdtsFrame(adts: Buffer): { parsed?: { sampleRate: number; channels: number; configHex: string } } {
        if (this.closed) return {};
        if (!this.audioRtp) return {};

        const { packets, config } = packetizeAacAdtsFrame(adts, this.audioRtp);
        // keep audio aligned with video gating: only send once video has started.
        for (const pkt of packets) this.writeRtpPacketToClients(pkt, c => !c.needsKeyframe);

        // advance by 1024 samples per AAC-LC frame
        if (packets.length) this.audioRtp.advanceTimestamp(1024);

        return config ? { parsed: config } : {};
    }

    sendAudioAacRawFrame(raw: Buffer): void {
        if (this.closed) return;
        if (!this.audioRtp) return;

        const { packets } = packetizeAacRawFrame(raw, this.audioRtp);
        // keep audio aligned with video gating: only send once video has started.
        for (const pkt of packets) this.writeRtpPacketToClients(pkt, c => !c.needsKeyframe);

        // advance by 1024 samples per AAC-LC frame
        if (packets.length) this.audioRtp.advanceTimestamp(1024);
    }

    sendAudioRtpPacket(rtpPacket: Buffer): void {
        if (this.closed) return;
        if (!rtpPacket || rtpPacket.length < 12) return;
        const version = (rtpPacket[0]! >> 6) & 0x03;
        if (version !== 2) return;

        // keep audio aligned with video gating: only send once video has started.
        this.writeRtpPacketToClients(rtpPacket, (c) => !c.needsKeyframe);
    }

    private static parseRtpPayload(packet: Buffer): Buffer | undefined {
        if (!packet || packet.length < 12) return;
        const version = (packet[0]! >> 6) & 0x03;
        if (version !== 2) return;

        const padding = (packet[0]! & 0x20) !== 0;
        const extension = (packet[0]! & 0x10) !== 0;
        const csrcCount = packet[0]! & 0x0f;
        let offset = 12 + csrcCount * 4;
        if (offset > packet.length) return;

        if (extension) {
            if (offset + 4 > packet.length) return;
            const extLenWords = packet.readUInt16BE(offset + 2);
            offset += 4 + extLenWords * 4;
            if (offset > packet.length) return;
        }

        let end = packet.length;
        if (padding) {
            const padLen = packet[packet.length - 1]!;
            if (padLen <= 0 || padLen > packet.length) return;
            end = packet.length - padLen;
            if (end < offset) return;
        }

        if (end <= offset) return;
        return packet.subarray(offset, end);
    }

    private static isH264KeyframeLikeRtpPacket(packet: Buffer): boolean {
        const payload = Rfc4571Muxer.parseRtpPayload(packet);
        if (!payload || payload.length < 1) return false;

        const nalType = payload[0]! & 0x1f;

        // Single NAL
        if (nalType >= 1 && nalType <= 23) {
            return nalType === 5 || nalType === 7 || nalType === 8;
        }

        // STAP-A
        if (nalType === 24) {
            let offset = 1;
            while (offset + 2 <= payload.length) {
                const size = payload.readUInt16BE(offset);
                offset += 2;
                if (!size || offset + size > payload.length) break;
                const t = payload[offset]! & 0x1f;
                if (t === 5 || t === 7 || t === 8) return true;
                offset += size;
            }
            return false;
        }

        // FU-A
        if (nalType === 28 && payload.length >= 2) {
            const fuHeader = payload[1]!;
            const start = (fuHeader & 0x80) !== 0;
            const origType = fuHeader & 0x1f;
            if (!start) return false;
            return origType === 5 || origType === 7 || origType === 8;
        }

        return false;
    }

    private static isH265KeyframeLikeRtpPacket(packet: Buffer): boolean {
        const payload = Rfc4571Muxer.parseRtpPayload(packet);
        if (!payload || payload.length < 2) return false;

        const nalType = (payload[0]! >> 1) & 0x3f;

        const isKeyNalType = (t: number) => {
            // IRAP: 16..21, VPS/SPS/PPS: 32/33/34
            if (t >= 16 && t <= 21) return true;
            if (t === 32 || t === 33 || t === 34) return true;
            return false;
        };

        // Fragmentation Unit (FU): nalType==49, original nal type in payload[2]
        if (nalType === 49 && payload.length >= 3) {
            const fuHeader = payload[2]!;
            const start = (fuHeader & 0x80) !== 0;
            const origType = fuHeader & 0x3f;
            if (!start) return false;
            return isKeyNalType(origType);
        }

        return isKeyNalType(nalType);
    }

    sendVideoRtpPacket(videoType: VideoType, rtpPacket: Buffer): void {
        if (this.closed) return;
        if (!rtpPacket || rtpPacket.length < 12) return;
        const version = (rtpPacket[0]! >> 6) & 0x03;
        if (version !== 2) return;

        const isKeyframeLike = videoType === 'H265'
            ? Rfc4571Muxer.isH265KeyframeLikeRtpPacket(rtpPacket)
            : Rfc4571Muxer.isH264KeyframeLikeRtpPacket(rtpPacket);

        const shouldSendTo = (c: Rfc4571Client) => isKeyframeLike ? true : !c.needsKeyframe;
        this.writeRtpPacketToClients(rtpPacket, shouldSendTo);

        if (isKeyframeLike) {
            for (const c of this.clients) c.needsKeyframe = false;
        }
    }
}
