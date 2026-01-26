/**
 * Baichuan Protocol Constants and Utilities
 * 
 * Shared module for all PCAP analyzer tools.
 */

import crypto from 'crypto';

// Baichuan magic number (little-endian)
export const BC_MAGIC = 0x0abcdef0;
export const BC_MAGIC_BYTES = Buffer.from([0xf0, 0xde, 0xbc, 0x0a]);

// XOR encryption key
export const BC_XOR_KEY = [0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff];

// AES IV (fixed)
export const BC_AES_IV = Buffer.from('0123456789abcdef', 'utf8');

// Header classes
export const BC_CLASS_LEGACY_20 = 0x6514;  // 20-byte header
export const BC_CLASS_MODERN_24 = 0x6414;  // 24-byte header

// Common command IDs
export const CMD_IDS = {
    1: 'Login',
    2: 'Logout',
    3: 'Preview',
    4: 'PreviewStop',
    5: 'FileInfoList_Replay',
    6: 'FileInfoList_Stop',
    10: 'Talk',
    13: 'FileDownload',
    14: 'FileDownloadStop',
    16: 'GetAbility',
    31: 'FileInfoList',
    33: 'SystemGeneral',
    35: 'ConfigGet',
    36: 'ConfigSet',
    37: 'DefaultConfig',
    38: 'SystemConfig',
    39: 'PtzControl',
    78: 'AlarmPush',
    80: 'DevInfo',
    93: 'NetPort',
    109: 'Snapshot',
    114: 'TimeZone',
    115: 'DaylightSaving',
    116: 'SetTime',
    146: 'HddInfo',
    151: 'Email',
    192: 'AudioCfg',
    198: 'VideoInput',
    202: 'TalkData',
    210: 'AlarmEvent',
    222: 'RecordCfg',
    234: 'CloudCfg',
    250: 'StreamInfo',
    256: 'PtzPreset',
    260: 'PtzTour',
    264: 'Shelter',
    286: 'PlaybackSeek',
    288: 'AudioPlayback',
    298: 'CoverPreview',
    302: 'FloodlightCfg',
    350: 'OsdCfg',
    382: 'WhiteLed',
    398: 'AiCfg',
    512: 'ChannelStatus',
    522: 'StorageInfo',
};

/**
 * Get command name by ID
 */
export function getCmdName(cmdId) {
    return CMD_IDS[cmdId] || `Unknown_${cmdId}`;
}

/**
 * Determine header size from messageClass
 */
export function getHeaderSize(messageClass) {
    return messageClass === BC_CLASS_LEGACY_20 ? 20 : 24;
}

/**
 * BC XOR decrypt/encrypt (symmetric)
 */
export function bcXor(buf, offset) {
    const off = offset & 0xff;
    const out = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i < buf.length; i++) {
        const key = BC_XOR_KEY[(off + i) % BC_XOR_KEY.length];
        out[i] = buf[i] ^ key ^ off;
    }
    return out;
}

/**
 * Derive AES key from nonce and password
 */
export function deriveAesKey(nonce, password) {
    const combined = `${nonce}-${password}`;
    const md5 = crypto.createHash('md5').update(combined, 'utf8').digest('hex').toUpperCase();
    return Buffer.from(md5.slice(0, 16), 'utf8');
}

/**
 * AES-128-CFB decrypt
 */
export function aesDecrypt(buf, key) {
    if (buf.length === 0) return Buffer.alloc(0);
    const decipher = crypto.createDecipheriv('aes-128-cfb', key, BC_AES_IV);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(buf), decipher.final()]);
}

/**
 * AES-128-CFB encrypt
 */
export function aesEncrypt(buf, key) {
    if (buf.length === 0) return Buffer.alloc(0);
    const cipher = crypto.createCipheriv('aes-128-cfb', key, BC_AES_IV);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(buf), cipher.final()]);
}

/**
 * Parse a Baichuan header from buffer
 */
export function parseHeader(buf, offset = 0) {
    if (buf.length < offset + 20) return null;

    const magic = buf.readUInt32LE(offset);
    if (magic !== BC_MAGIC) return null;

    const cmdId = buf.readUInt32LE(offset + 4);
    const bodyLen = buf.readUInt32LE(offset + 8);
    const channelId = buf.readUInt8(offset + 12);
    const streamType = buf.readUInt8(offset + 13);
    const msgNum = buf.readUInt16LE(offset + 14);
    const responseCode = buf.readUInt16LE(offset + 16);
    const messageClass = buf.readUInt16LE(offset + 18);

    const headerSize = getHeaderSize(messageClass);
    let payloadOffset = 0;
    if (headerSize === 24 && buf.length >= offset + 24) {
        payloadOffset = buf.readUInt32LE(offset + 20);
    }

    return {
        magic,
        cmdId,
        bodyLen,
        channelId,
        streamType,
        msgNum,
        responseCode,
        messageClass,
        headerSize,
        payloadOffset,
        cmdName: getCmdName(cmdId),
    };
}

/**
 * Format header for display
 */
export function formatHeader(header) {
    return [
        `cmdId=${header.cmdId} (${header.cmdName})`,
        `bodyLen=${header.bodyLen}`,
        `channelId=${header.channelId}`,
        `streamType=${header.streamType}`,
        `msgNum=${header.msgNum}`,
        `responseCode=${header.responseCode}`,
        `messageClass=0x${header.messageClass.toString(16)}`,
        `payloadOffset=${header.payloadOffset}`,
    ].join(' ');
}

/**
 * Check if buffer looks like XML
 */
export function looksLikeXml(buf) {
    if (!buf || buf.length === 0) return false;
    // Skip leading whitespace/nulls
    let i = 0;
    while (i < buf.length && (buf[i] === 0x00 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x20)) {
        i++;
    }
    if (i >= buf.length) return false;
    return buf[i] === 0x3c; // '<'
}

/**
 * Try to parse XML safely
 */
export function tryParseXml(buf) {
    try {
        const str = buf.toString('utf8').replace(/\0+$/, '').trim();
        if (!str.startsWith('<?xml') && !str.startsWith('<')) return null;
        return str;
    } catch {
        return null;
    }
}

/**
 * Extract nonce from login response XML
 */
export function extractNonceFromXml(xml) {
    const match = /<nonce>([^<]+)<\/nonce>/i.exec(xml);
    return match ? match[1] : null;
}

/**
 * Determine encryption type from login exchange
 */
export function determineEncryptionType(loginResponseXml) {
    if (!loginResponseXml) return 'unknown';
    if (loginResponseXml.includes('<encryptType>aes</encryptType>')) return 'full_aes';
    if (loginResponseXml.includes('<encryptType>aes_mixed</encryptType>')) return 'aes';
    if (loginResponseXml.includes('<encryptType>bc</encryptType>')) return 'bc';
    return 'none';
}

export default {
    BC_MAGIC,
    BC_MAGIC_BYTES,
    BC_XOR_KEY,
    BC_AES_IV,
    BC_CLASS_LEGACY_20,
    BC_CLASS_MODERN_24,
    CMD_IDS,
    getCmdName,
    getHeaderSize,
    bcXor,
    deriveAesKey,
    aesDecrypt,
    aesEncrypt,
    parseHeader,
    formatHeader,
    looksLikeXml,
    tryParseXml,
    extractNonceFromXml,
    determineEncryptionType,
};
