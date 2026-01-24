#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function readVarintAt(b, off) {
    let v = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
        if (off + i >= b.length) return null;
        const byte = b[off + i];
        v |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return { v, len: i + 1 };
        shift += 7n;
    }
    return null;
}

function hexHead(buf, n = 64) {
    return buf.subarray(0, Math.min(n, buf.length)).toString("hex");
}

function findXmlStart(buf) {
    const needle = Buffer.from("<?xml", "utf8");
    return buf.indexOf(needle);
}

function findExtensionStart(buf) {
    const needle = Buffer.from("<Extension", "utf8");
    return buf.indexOf(needle);
}

function findAllExtensionStarts(buf) {
    const needle = Buffer.from("<Extension", "utf8");
    const starts = [];
    let at = 0;
    while (at >= 0 && at < buf.length) {
        at = buf.indexOf(needle, at);
        if (at < 0) break;
        starts.push(at);
        at += 1;
    }
    return starts;
}

function findCloseExtension(buf, from = 0) {
    const closeTag = Buffer.from("</Extension>", "utf8");
    const closeAt = buf.indexOf(closeTag, from);
    if (closeAt < 0) return null;
    let splitAt = buf.indexOf(0x0a, closeAt + closeTag.length);
    if (splitAt < 0) splitAt = closeAt + closeTag.length;
    else splitAt += 1;
    return { closeAt, splitAt };
}

function extractTagText(xml, tag) {
    const re = new RegExp(`<${tag}>([^<]+)</${tag}>`, "i");
    const m = re.exec(xml);
    return m?.[1]?.trim() ?? null;
}

function trySplitLeadingExtension(buf) {
    // We accept both "<Extension ...>" and "<?xml ... <Extension ...>" at start.
    const startsLikeXml = buf.subarray(0, 5).toString("utf8") === "<?xml";
    const startsLikeExt = buf.subarray(0, 10).toString("utf8").startsWith("<Extension");
    if (!startsLikeXml && !startsLikeExt) return null;

    const split = findCloseExtension(buf, 0);
    if (!split) return null;
    const xml = buf.subarray(0, split.splitAt).toString("utf8");
    const payload = buf.subarray(split.splitAt);
    return { splitAt: split.splitAt, xml, payload };
}

function scanAllExtensions(buf, base) {
    const starts = findAllExtensionStarts(buf);
    if (starts.length === 0) return { count: 0, blocks: [], prefixLen: buf.length };

    const prefixLen = starts[0];
    if (prefixLen > 0) {
        fs.writeFileSync(`${base}.prefix.beforeFirstExtension.bin`, buf.subarray(0, prefixLen));
    }

    /** @type {any[]} */
    const blocks = [];
    for (let i = 0; i < starts.length; i++) {
        const start = starts[i];
        const nextStart = i + 1 < starts.length ? starts[i + 1] : buf.length;

        const split = findCloseExtension(buf, start);
        if (!split) {
            blocks.push({ index: i, start, error: "missing_close_extension" });
            continue;
        }

        const xmlBuf = buf.subarray(start, split.splitAt);
        const xml = xmlBuf.toString("utf8");
        const payloadStart = split.splitAt;
        const payloadEnd = Math.max(payloadStart, nextStart);
        const payload = buf.subarray(payloadStart, payloadEnd);

        const encryptLenText = extractTagText(xml, "EncryptLen");
        const encryptLen = encryptLenText ? Number.parseInt(encryptLenText, 10) : null;
        const binaryDataText = extractTagText(xml, "BinaryData");
        const binaryData = binaryDataText ? Number.parseInt(binaryDataText, 10) : null;

        const outXml = `${base}.ext.${String(i).padStart(4, "0")}.extension.xml`;
        const outPayload = `${base}.ext.${String(i).padStart(4, "0")}.payload.bin`;
        fs.writeFileSync(outXml, xml);
        fs.writeFileSync(outPayload, payload);

        blocks.push({
            index: i,
            start,
            closeAt: split.closeAt,
            splitAt: split.splitAt,
            nextStart,
            xmlLen: split.splitAt - start,
            payloadLen: payload.length,
            encryptLen,
            binaryData,
            out: { xml: outXml, payload: outPayload },
        });
    }

    return { count: blocks.length, blocks, prefixLen };
}

function tryParseLeadingProtobufBytesField(buf) {
    // Minimal: if the buffer starts with a length-delimited field (wire=2), extract it.
    const key = readVarintAt(buf, 0);
    if (!key) return null;
    const fieldNo = Number(key.v >> 3n);
    const wire = Number(key.v & 0x7n);
    if (wire !== 2) return null;

    const len = readVarintAt(buf, key.len);
    if (!len) return null;
    const L = Number(len.v);
    const start = key.len + len.len;
    const end = start + L;
    if (!Number.isFinite(L) || L < 0 || end > buf.length) return null;

    return {
        fieldNo,
        wire,
        keyLen: key.len,
        lenLen: len.len,
        bytesLen: L,
        bytes: buf.subarray(start, end),
        consumed: end,
        rest: buf.subarray(end),
    };
}

function extractInnerExtension(buf, base, label) {
    const xmlStart = findXmlStart(buf);
    if (xmlStart < 0) return null;

    const header = buf.subarray(0, xmlStart);
    const rest = buf.subarray(xmlStart);

    const innerSplit = findCloseExtension(rest, 0);
    if (!innerSplit) return null;

    const innerXml = rest.subarray(0, innerSplit.splitAt).toString("utf8");
    const innerPayload = rest.subarray(innerSplit.splitAt);

    const encryptLenText = extractTagText(innerXml, "EncryptLen");
    const encryptLen = encryptLenText ? Number.parseInt(encryptLenText, 10) : null;

    const outHeader = `${base}.inner.${label}.header.bin`;
    const outInnerXml = `${base}.inner.${label}.extension.xml`;
    const outInnerPayload = `${base}.inner.${label}.payload.bin`;
    fs.writeFileSync(outHeader, header);
    fs.writeFileSync(outInnerXml, innerXml);
    fs.writeFileSync(outInnerPayload, innerPayload);

    return {
        label,
        xmlStart,
        headerLen: header.length,
        headerHex: hexHead(header, 64),
        xmlLen: innerSplit.splitAt,
        payloadLen: innerPayload.length,
        encryptLen,
        out: { header: outHeader, xml: outInnerXml, payload: outInnerPayload },
    };
}

function main() {
    const input = process.argv[2];
    if (!input) {
        console.error(
            "Usage: node tools/pcap/unpack-binarydata.mjs <bodyOrBinOnly.bin> [--out <prefix>]",
        );
        process.exit(2);
    }

    let outPrefix = null;
    let scanAll = false;
    for (let i = 3; i < process.argv.length; i++) {
        if (process.argv[i] === "--out") outPrefix = String(process.argv[++i] ?? "");
        else if (process.argv[i] === "--scan-all") scanAll = true;
    }

    const buf = fs.readFileSync(input);
    const base = outPrefix ?? input;
    fs.mkdirSync(path.dirname(base), { recursive: true });

    const report = {
        input,
        len: buf.length,
        outer: null,
        protobufPrefix: null,
        inner: null,
        scanAll: null,
    };

    if (scanAll) {
        report.scanAll = scanAllExtensions(buf, base);
        const outReport = `${base}.unpack.report.json`;
        fs.writeFileSync(outReport, JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ ok: true, outReport }, null, 2));
        return;
    }

    // 1) Optional outer <Extension> at file start.
    let payload = buf;
    const outer = trySplitLeadingExtension(buf);
    if (outer) {
        const outOuterXml = `${base}.outer.extension.xml`;
        const outOuterPayload = `${base}.outer.payload.bin`;
        fs.writeFileSync(outOuterXml, outer.xml);
        fs.writeFileSync(outOuterPayload, outer.payload);

        report.outer = {
            splitAt: outer.splitAt,
            xmlLen: outer.splitAt,
            payloadLen: outer.payload.length,
            out: { xml: outOuterXml, payload: outOuterPayload },
        };
        payload = outer.payload;
    } else {
        // Still record a hint for debugging.
        report.outer = {
            splitAt: null,
            xmlLen: null,
            payloadLen: payload.length,
            out: null,
            headHex: hexHead(payload, 64),
        };
    }

    // 2) Optional leading protobuf bytes field (common in cmd143 afterBody: 0x0a <len> ...)
    let payloadAfterPrefix = payload;
    // NOTE: many of our blobs start with "\n-" (0x0a 0x2d) or "-" (0x2d).
    // That's not protobuf; it’s just a textual delimiter before a binary header.
    // Normalize by stripping only the leading newline when present.
    let pb = null;
    if (payload.length >= 2 && payload[0] === 0x0a && payload[1] === 0x2d) {
        report.protobufPrefix = {
            type: "newline-dash",
            consumed: 1,
            bytesHeadHex: hexHead(payload.subarray(0, 16), 16),
        };
        payloadAfterPrefix = payload.subarray(1);
    } else {
        pb = tryParseLeadingProtobufBytesField(payload);
    }
    if (pb) {
        const outPbBytes = `${base}.prefix.field${pb.fieldNo}.bin`;
        fs.writeFileSync(outPbBytes, pb.bytes);

        report.protobufPrefix = {
            type: "protobuf",
            fieldNo: pb.fieldNo,
            wire: pb.wire,
            keyLen: pb.keyLen,
            lenLen: pb.lenLen,
            bytesLen: pb.bytesLen,
            consumed: pb.consumed,
            bytesHeadHex: hexHead(pb.bytes, 64),
            restHeadHex: hexHead(pb.rest, 64),
            out: { bytes: outPbBytes },
        };
        payloadAfterPrefix = pb.rest;
    }

    // 3) Inner extension search.
    // Try in: (a) payload (after outer), (b) payload after protobuf prefix, (c) protobuf field bytes.
    let inner = extractInnerExtension(payload, base, "fromPayload");
    if (!inner && pb) inner = extractInnerExtension(pb.bytes, base, `fromProtobufField${pb.fieldNo}`);
    if (!inner && payloadAfterPrefix !== payload) inner = extractInnerExtension(payloadAfterPrefix, base, "fromAfterProtobufPrefix");
    if (inner) {
        report.inner = inner;
    } else {
        // For quick inspection, record where an <Extension> tag appears (if any)
        const extAtPayload = findExtensionStart(payload);
        const extAtAfter = findExtensionStart(payloadAfterPrefix);
        report.inner = {
            found: false,
            xmlStart: null,
            extensionTagAt: {
                payload: extAtPayload,
                afterProtobufPrefix: extAtAfter,
            },
        };
    }

    const outReport = `${base}.unpack.report.json`;
    fs.writeFileSync(outReport, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: true, outReport }, null, 2));
}

main();
