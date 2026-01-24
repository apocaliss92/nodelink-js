#!/usr/bin/env node

import fs from "node:fs";
import { bcDecrypt } from "../../dist/index.js";

const payloadPath =
    "pcap/reports/extracts/host-192.168.1.161_cmd298.rsp_ch53_st0_msg0.aesdec.body.binonly.unpacked2.inner.fromPayload.payload.bin";

const payload = fs.readFileSync(payloadPath);

function findSig(buf) {
    const jpgAt = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    const pngAt = buf.indexOf(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const ftypAt = buf.indexOf(Buffer.from("ftyp", "ascii"));
    const annexBAt = buf.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
    return { jpgAt, pngAt, ftypAt, annexBAt };
}

const offsets = [0, 1, 2, 3, 10, 32, 49, 53, 119, 161, 255];

for (const off of offsets) {
    const dec = bcDecrypt(payload, off);
    const sig = findSig(dec);
    const any = Object.values(sig).some((v) => v >= 0);
    if (any) {
        console.log(JSON.stringify({ offset: off, ...sig }));
    }
}
