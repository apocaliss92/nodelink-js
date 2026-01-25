#!/usr/bin/env node
/**
 * Decifra i payload Baichuan dal PCAP 192.168.1.161 events+cover+download.pcapng
 * per capire esattamente cosa viene inviato/ricevuto per FileInfoList
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import "dotenv/config";

const PCAP_PATH = process.argv[2] || "../../pcap/192.168.1.161 events+cover+download.pcapng";
const PASSWORD = process.env.NVR_PASSWORD || process.env.TCP_PASSWORD || "Ruocco123";

// Baichuan header constants
const BC_MAGIC = 0x0abcdef0;
const BC_HEADER_SIZE = 20;

// cmdId names
const CMD_NAMES = {
    1: "Login",
    3: "VideoStream",
    5: "Replay",
    13: "Download",
    14: "FileInfoList_OPEN",
    15: "FileInfoList_GET",
    16: "FileInfoList_CLOSE",
    145: "DevInfo_Push",
    272: "findAlarmVideo",
    273: "findAlarmVideo_GET",
    274: "findAlarmVideo_CLOSE",
    298: "CoverPreview",
};

// MD5 helpers for key derivation
const md5HexUpper = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex").toUpperCase();
const md5Str31 = (s) => md5HexUpper(s).slice(0, 31);

function deriveAesKey(nonce, password) {
    const keyStr = md5Str31(`${nonce}-${password}`).slice(0, 16);
    return Buffer.from(keyStr, "utf8");
}

// BC XOR decrypt (legacy)
const BC_XOR_KEY = [0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff];
function bcXorDecrypt(buf, offset) {
    const off = offset & 0xff;
    const out = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i < buf.length; i++) {
        out[i] = buf[i] ^ BC_XOR_KEY[(off + i) % BC_XOR_KEY.length] ^ off;
    }
    return out;
}

// AES-128-CFB decrypt with fixed IV
const BC_AES_IV = Buffer.from("0123456789abcdef", "utf8");

function aesDecrypt(key, data) {
    if (data.length === 0) return Buffer.alloc(0);
    const decipher = crypto.createDecipheriv("aes-128-cfb", key, BC_AES_IV);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(data), decipher.final()]);
}

// Parse pcapng
function* parsePcapng(buf) {
    let pos = 0;
    const interfaces = [];

    while (pos + 8 <= buf.length) {
        const blockType = buf.readUInt32LE(pos);
        const blockLen = buf.readUInt32LE(pos + 4);
        if (blockLen < 12 || pos + blockLen > buf.length) break;

        if (blockType === 0x0A0D0D0A) {
            // Section Header Block
        } else if (blockType === 0x00000001) {
            // Interface Description Block
            const linkType = buf.readUInt16LE(pos + 8);
            interfaces.push({ linkType, tsResol: 6 }); // default microseconds
        } else if (blockType === 0x00000006) {
            // Enhanced Packet Block
            const ifaceId = buf.readUInt32LE(pos + 8);
            const tsHi = buf.readUInt32LE(pos + 12);
            const tsLo = buf.readUInt32LE(pos + 16);
            const capturedLen = buf.readUInt32LE(pos + 20);
            const packetData = buf.subarray(pos + 28, pos + 28 + capturedLen);

            const iface = interfaces[ifaceId] || { linkType: 1, tsResol: 6 };
            const tsMs = (BigInt(tsHi) * BigInt(0x100000000) + BigInt(tsLo)) / BigInt(1000);

            yield { packetData, linkType: iface.linkType, tsMs: Number(tsMs) };
        }

        pos += blockLen;
    }
}

// Parse Ethernet + IP + TCP
function parseTcpPacket(pkt) {
    if (pkt.length < 14) return null;

    let ethType = pkt.readUInt16BE(12);
    let ipOffset = 14;
    if (ethType === 0x8100) { // VLAN
        ethType = pkt.readUInt16BE(16);
        ipOffset = 18;
    }
    if (ethType !== 0x0800) return null; // Not IPv4

    const ipHdrLen = (pkt[ipOffset] & 0x0f) * 4;
    const ipTotalLen = pkt.readUInt16BE(ipOffset + 2);
    const proto = pkt[ipOffset + 9];
    if (proto !== 6) return null; // Not TCP

    const srcIp = `${pkt[ipOffset + 12]}.${pkt[ipOffset + 13]}.${pkt[ipOffset + 14]}.${pkt[ipOffset + 15]}`;
    const dstIp = `${pkt[ipOffset + 16]}.${pkt[ipOffset + 17]}.${pkt[ipOffset + 18]}.${pkt[ipOffset + 19]}`;

    const tcpOffset = ipOffset + ipHdrLen;
    const srcPort = pkt.readUInt16BE(tcpOffset);
    const dstPort = pkt.readUInt16BE(tcpOffset + 2);
    const tcpDataOffset = (pkt[tcpOffset + 12] >> 4) * 4;

    const payload = pkt.subarray(tcpOffset + tcpDataOffset);

    return { srcIp, dstIp, srcPort, dstPort, payload };
}

// Parse Baichuan frame header
// Header layout:
// 0-3: magic (0xf0debc0a)
// 4-7: cmdId
// 8-11: bodyLen
// 12: channelId
// 13: streamType
// 14-15: msgNum
// 16-17: responseCode
// 18-19: messageClass
// 20-23: payloadOffset (only if messageClass indicates 24-byte header)
function parseBcHeader(buf) {
    if (buf.length < BC_HEADER_SIZE) return null;
    const magic = buf.readUInt32LE(0);
    if (magic !== BC_MAGIC) return null;

    const messageClass = buf.readUInt16LE(18);
    // Modern 24-byte header classes
    const is24Byte = messageClass === 0x6514 || messageClass === 0x6414 || messageClass === 0x0000;
    const headerLen = is24Byte && buf.length >= 24 ? 24 : 20;

    return {
        cmdId: buf.readUInt32LE(4),
        bodyLen: buf.readUInt32LE(8),
        channelId: buf.readUInt8(12),
        streamType: buf.readUInt8(13),
        msgNum: buf.readUInt16LE(14),
        responseCode: buf.readUInt16LE(16),
        messageClass,
        headerLen,
        payloadOffset: headerLen === 24 ? buf.readUInt32LE(20) : 0,
    };
}

// Main
async function main() {
    const pcapPath = path.resolve(process.cwd(), PCAP_PATH);
    console.log(`📂 PCAP: ${pcapPath}`);
    console.log(`🔑 Password: ${PASSWORD.slice(0, 3)}***\n`);

    const buf = fs.readFileSync(pcapPath);

    // Collect TCP segments by flow
    const flows = new Map();

    for (const { packetData, tsMs } of parsePcapng(buf)) {
        const tcp = parseTcpPacket(packetData);
        if (!tcp || tcp.payload.length === 0) continue;
        if (tcp.srcPort !== 9000 && tcp.dstPort !== 9000) continue;

        const flowKey = tcp.srcPort === 9000
            ? `${tcp.srcIp}:${tcp.srcPort} -> ${tcp.dstIp}:${tcp.dstPort}`
            : `${tcp.dstIp}:${tcp.dstPort} -> ${tcp.srcIp}:${tcp.srcPort}`;
        const dir = tcp.srcPort === 9000 ? "rx" : "tx";

        if (!flows.has(flowKey)) flows.set(flowKey, { tx: [], rx: [] });
        flows.get(flowKey)[dir].push({ payload: tcp.payload, tsMs });
    }

    // Process each flow
    for (const [flowKey, { tx, rx }] of flows) {
        console.log(`\n${"=".repeat(70)}`);
        console.log(`🔗 Flow: ${flowKey}`);
        console.log(`   TX packets: ${tx.length}, RX packets: ${rx.length}`);

        // Concatenate all TX and RX
        const txBuf = Buffer.concat(tx.map(p => p.payload));
        const rxBuf = Buffer.concat(rx.map(p => p.payload));

        // Find nonce from login response (cmdId=1, responseCode=0xDD02)
        let nonce = null;
        let aesKey = null;

        // Scan RX for login response
        let pos = 0;
        while (pos + BC_HEADER_SIZE <= rxBuf.length) {
            const magic = rxBuf.readUInt32LE(pos);
            if (magic !== BC_MAGIC) { pos++; continue; }

            const hdr = parseBcHeader(rxBuf.subarray(pos));
            if (!hdr) { pos++; continue; }

            const headerLen = hdr.headerLen || BC_HEADER_SIZE;
            const frameEnd = pos + headerLen + hdr.bodyLen;
            if (frameEnd > rxBuf.length) break;

            if (hdr.cmdId === 1 && (hdr.responseCode & 0xFF00) === 0xDD00) {
                const encType = hdr.responseCode & 0xFF;
                const body = rxBuf.subarray(pos + headerLen, frameEnd);

                // Try to extract nonce
                let xml;
                if (encType === 0x00) {
                    xml = body.toString("utf8");
                } else if (encType === 0x01) {
                    xml = bcXorDecrypt(body, hdr.channelId).toString("utf8");
                } else if (encType === 0x02 || encType === 0x12) {
                    // Need to find nonce from initial exchange - try BC decrypt first
                    xml = bcXorDecrypt(body, hdr.channelId).toString("utf8");
                }

                const nonceMatch = /<nonce>([^<]+)<\/nonce>/i.exec(xml);
                if (nonceMatch) {
                    nonce = nonceMatch[1];
                    aesKey = deriveAesKey(nonce, PASSWORD);
                    console.log(`\n   🔐 Found nonce: ${nonce}`);
                    console.log(`   🔑 Derived AES key: ${aesKey.toString("hex")}`);
                    console.log(`   📋 encType: 0x${encType.toString(16).padStart(2, "0")}`);
                    // Store encMode based on encType
                    global.encMode = encType === 0x12 ? "full_aes" : encType === 0x02 ? "aes" : encType === 0x01 ? "bc" : "none";
                }
            }

            pos = frameEnd;
        }

        if (!aesKey) {
            console.log("   ⚠️ Could not derive AES key - skipping decryption");
            continue;
        }

        const encMode = global.encMode || "aes";

        // Now parse and decrypt all frames
        console.log("\n   📤 TX Frames (client -> NVR):");
        parseAndPrintFrames(txBuf, aesKey, "tx", encMode);

        console.log("\n   📥 RX Frames (NVR -> client):");
        parseAndPrintFrames(rxBuf, aesKey, "rx", encMode);
    }
}

function parseAndPrintFrames(buf, aesKey, dir, encMode) {
    let pos = 0;
    let frameNum = 0;

    while (pos + BC_HEADER_SIZE <= buf.length) {
        const magic = buf.readUInt32LE(pos);
        if (magic !== BC_MAGIC) { pos++; continue; }

        const hdr = parseBcHeader(buf.subarray(pos));
        if (!hdr) { pos++; continue; }

        const headerLen = hdr.headerLen || BC_HEADER_SIZE;
        const frameEnd = pos + headerLen + hdr.bodyLen;
        if (frameEnd > buf.length) break;

        const body = buf.subarray(pos + headerLen, frameEnd);
        frameNum++;

        const cmdName = CMD_NAMES[hdr.cmdId] || `cmd${hdr.cmdId}`;

        // Only show interesting cmdIds
        const interestingCmds = [1, 14, 15, 16, 5, 13, 145, 272, 273, 274, 298];
        if (!interestingCmds.includes(hdr.cmdId)) {
            pos = frameEnd;
            continue;
        }

        console.log(`\n   [${frameNum}] ${cmdName} (cmdId=${hdr.cmdId})`);
        console.log(`       channelId=${hdr.channelId} msgNum=${hdr.msgNum} bodyLen=${hdr.bodyLen}`);
        console.log(`       responseCode=${hdr.responseCode} (0x${hdr.responseCode.toString(16)})`);

        // Try to decrypt body
        if (body.length > 0) {
            let xml = null;

            // After login, use AES decryption for all frames if encMode is aes/full_aes
            // For login response (cmdId=1, responseCode=0xDDxx), use BC or no encryption
            if (hdr.cmdId === 1 && (hdr.responseCode & 0xFF00) === 0xDD00) {
                // Login negotiation - BC or none
                const loginEncType = hdr.responseCode & 0xFF;
                if (loginEncType === 0x00) {
                    xml = body.toString("utf8");
                } else {
                    xml = bcXorDecrypt(body, hdr.channelId).toString("utf8");
                }
            } else if (encMode === "aes" || encMode === "full_aes") {
                // Post-login: AES encrypted
                try {
                    const decrypted = aesDecrypt(aesKey, body);
                    xml = decrypted.toString("utf8");
                } catch (e) {
                    xml = `[decrypt error: ${e.message}]`;
                }
            } else if (encMode === "bc") {
                xml = bcXorDecrypt(body, hdr.channelId).toString("utf8");
            } else {
                xml = body.toString("utf8");
            }

            if (xml && (xml.includes("<?xml") || xml.includes("<body>"))) {
                // Clean up and print XML
                const cleanXml = xml.replace(/\0+$/, "").trim();
                if (cleanXml.length < 3000) {
                    console.log(`       XML:\n${cleanXml.split("\n").map(l => "         " + l).join("\n")}`);
                } else {
                    console.log(`       XML (truncated): ${cleanXml.slice(0, 1000)}...`);
                }
            } else if (body.length < 100) {
                console.log(`       Body (hex): ${body.toString("hex")}`);
            } else {
                console.log(`       Body: ${body.length} bytes (binary/encrypted data)`);
            }
        }

        pos = frameEnd;
    }
}

main().catch(console.error);
