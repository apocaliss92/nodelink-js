#!/usr/bin/env node
/**
 * Produce a stable, human-readable diff between multiple PCAP summary JSON files.
 *
 * Usage:
 *   npm run test:build && node dist/test/pcap/test-pcap-baichuan-diff-summaries.js \
 *     test/artifacts/pcap/192.168.1.170_1.summary.json \
 *     test/artifacts/pcap/192.168.50.226_1.summary.json
 */

import fs from "node:fs";
import path from "node:path";

type Summary = {
  input: { pcapPath: string; host: string; port: number };
  cameraPorts?: {
    topByBytes?: Array<{ port: number; bytes: number }>;
    parsedPorts?: number[];
  };
  dirs: Array<{ dirKey: string; kind: string; segments: number; bytes: number; gaps: number; frames: number }>;
  byCmd: Record<
    string,
    {
      cmdId: number;
      req: number;
      rsp: number;
      reqMessageClass: Record<string, number>;
      rspMessageClass: Record<string, number>;
      rspCodes: Record<string, number>;
      channelIds: Record<string, number>;
      streamTypes: Record<string, number>;
      payloadOffset: Record<string, number>;
      bodyLenBuckets: Record<string, number>;
      payloadLenBuckets?: Record<string, number>;
      extLenBuckets?: Record<string, number>;
      bcMediaMagicOff: Record<string, number>;
      extra?: any;
    }
  >;
};

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function topN(map: Record<string, number> | undefined, n = 5): Array<[string, number]> {
  if (!map) return [];
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function fmtTop(map: Record<string, number> | undefined, n = 5): string {
  const t = topN(map, n);
  if (t.length === 0) return "-";
  return t.map(([k, v]) => `${k}:${v}`).join(" ");
}

function fileTag(p: string, s: Summary): string {
  const base = path.basename(p);
  return `${s.input.host} (${base})`;
}

function getCmd(s: Summary, cmdId: number): any {
  return s.byCmd[String(cmdId)];
}

function describeCmd(s: Summary, cmdId: number): Record<string, string> {
  const c = getCmd(s, cmdId);
  if (!c) return { present: "no" };

  const extra = c.extra ?? {};
  const cmd5Ack = cmdId === 5 ? extra.cmd5AckSamples : undefined;
  const cmd5Push = cmdId === 5 ? extra.cmd5PushAdditionalHeader : undefined;
  const cmd143 = cmdId === 143 ? extra.cmd143 : undefined;

  const ackTailSamples: string = Array.isArray(cmd5Ack)
    ? cmd5Ack
        .slice(0, 4)
        .map((x: any) => `msg=${x.msgNum} code=${x.responseCode} tailU32=${x.tailU32LE ?? "?"} pay=${x.payloadHex}`)
        .join(" | ")
    : "-";

  const ivSamples: string = cmd5Push && Array.isArray(cmd5Push.ivSamples)
    ? cmd5Push.ivSamples
        .slice(0, 3)
        .map((x: any) => `msg=${x.msgNum} off=${x.additionalHeaderOff} iv16=${x.iv16Hex}`)
        .join(" | ")
    : "-";

  const payloadBytes = typeof (c as any).payloadBytesTotal === "number" ? (c as any).payloadBytesTotal : undefined;
  const payloadBytesRsp = typeof (c as any).payloadBytesRsp === "number" ? (c as any).payloadBytesRsp : undefined;
  const extBytes = typeof (c as any).extBytesTotal === "number" ? (c as any).extBytesTotal : undefined;

  return {
    present: "yes",
    req: String(c.req),
    rsp: String(c.rsp),
    payloadBytes: payloadBytes == null ? "-" : String(payloadBytes),
    payloadBytesRsp: payloadBytesRsp == null ? "-" : String(payloadBytesRsp),
    extBytes: extBytes == null ? "-" : String(extBytes),
    rspCodes: fmtTop(c.rspCodes, 8),
    rspClass: fmtTop(c.rspMessageClass, 5),
    reqClass: fmtTop(c.reqMessageClass, 3),
    payloadOffset: fmtTop(c.payloadOffset, 6),
    bodyLen: fmtTop(c.bodyLenBuckets, 6),
    payloadLen: fmtTop(c.payloadLenBuckets, 6),
    extLen: fmtTop(c.extLenBuckets, 6),
    bcMediaMagicOff: fmtTop(c.bcMediaMagicOff, 6),
    cmd5AckTailSamples: ackTailSamples,
    cmd5AdditionalHeader: cmd5Push ? `present=${cmd5Push.present} absent=${cmd5Push.absent} offs=${fmtTop(cmd5Push.offsets, 6)}` : "-",
    cmd5IvSamples: ivSamples,
    cmd5PushPrefixU32le: cmd5Push ? fmtTop(cmd5Push.prefixU32le, 10) : "-",
    cmd5PushHeadSamples:
      cmd5Push && Array.isArray(cmd5Push.headSamples)
        ? cmd5Push.headSamples
            .slice(0, 3)
            .map((x: any) => `code=${x.responseCode} len=${x.payloadLen} head=${x.headHex}`)
            .join(" | ")
        : "-",
    cmd5PushCommonPrefix:
      cmd5Push && typeof cmd5Push.commonPrefixLen === "number"
        ? `len=${cmd5Push.commonPrefixLen} hex=${cmd5Push.commonPrefixHex ?? ""}`
        : "-",
    cmd5PushCommonPrefixAfter4:
      cmd5Push && typeof cmd5Push.commonPrefixAfter4Len === "number"
        ? `len=${cmd5Push.commonPrefixAfter4Len} hex=${cmd5Push.commonPrefixAfter4Hex ?? ""}`
        : "-",

    cmd143Summary:
      cmd143
        ? `rspFrames=${cmd143.rspFrames ?? "?"} payloadBytesRsp=${cmd143.payloadBytesRsp ?? "?"} mp4Likely=${cmd143.mp4Likely ?? "?"} annexBLikely=${cmd143.annexBLikely ?? "?"} adtsLikely=${cmd143.adtsLikely ?? "?"}`
        : "-",
    cmd143CommonPrefix: cmd143 && typeof cmd143.commonPrefixLen === "number" ? `len=${cmd143.commonPrefixLen} hex=${cmd143.commonPrefixHex ?? ""}` : "-",
    cmd143Mp4Known: cmd143 ? fmtTop(cmd143.mp4KnownTypes, 10) : "-",
    cmd143BcMediaOff256: cmd143 ? fmtTop(cmd143.bcMediaMagicOff256, 10) : "-",
    cmd143AdditionalHdrOff256: cmd143 ? fmtTop(cmd143.additionalHeaderMagicOff256, 10) : "-",
    cmd143IvSamples:
      cmd143 && Array.isArray(cmd143.iv16Samples)
        ? cmd143.iv16Samples
            .slice(0, 4)
            .map((x: any) => `len=${x.payloadLen} off=${x.additionalHeaderOff} iv16=${x.iv16Hex}`)
            .join(" | ")
        : "-",
    cmd143HeadSamples:
      cmd143 && Array.isArray(cmd143.headSamples)
        ? cmd143.headSamples
            .slice(0, 4)
            .map((x: any) => `code=${x.responseCode} len=${x.payloadLen} off=${x.payloadOffset} mp4=${x.mp4BoxType ?? "-"} hex=${x.headHex}`)
            .join(" | ")
        : "-",

    cmd143ReqSamples:
      cmd143 && Array.isArray((cmd143 as any).reqSamples)
        ? (cmd143 as any).reqSamples
            .slice(0, 2)
            .map((x: any) => {
              const b64: string = typeof x.payloadB64 === "string" ? x.payloadB64 : "";
              const b64Head = b64.length > 64 ? `${b64.slice(0, 64)}…` : b64;
              return `code=${x.responseCode} payloadLen=${x.payloadLen} payloadB64=${JSON.stringify(b64Head)} extLen=${x.extLen} extAscii=${JSON.stringify(x.extHeadAscii ?? "")}`;
            })
            .join(" | ")
        : "-",
    cmd143RspExtSamples:
      cmd143 && Array.isArray((cmd143 as any).rspExtSamples)
        ? (cmd143 as any).rspExtSamples
            .slice(0, 3)
            .map((x: any) => `code=${x.responseCode} payloadLen=${x.payloadLen} extLen=${x.extLen} extAscii=${JSON.stringify(x.extHeadAscii ?? "")}`)
            .join(" | ")
        : "-",
  };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    throw new Error("Usage: diff-summaries <summary1.json> <summary2.json> [more...]");
  }

  const inputs = args.map((p) => path.resolve(process.cwd(), p));
  const summaries = inputs.map((p) => ({ path: p, s: readJson(p) as Summary }));

  const baseCmdIds = [5, 3, 13, 8, 14, 15, 16, 272, 273, 274, 93];

  // Add top-N most frequent cmdIds seen in the summaries (useful for capturing negotiation/login).
  const totalsByCmd = new Map<number, number>();
  for (const { s } of summaries) {
    for (const [k, c] of Object.entries(s.byCmd ?? {})) {
      const cmdId = Number.parseInt(k, 10);
      if (!Number.isFinite(cmdId)) continue;
      const total = (c?.req ?? 0) + (c?.rsp ?? 0);
      totalsByCmd.set(cmdId, (totalsByCmd.get(cmdId) ?? 0) + total);
    }
  }

  const topCmdIds = [...totalsByCmd.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 25)
    .map(([cmdId]) => cmdId);

  const cmdIds = [...new Set([...baseCmdIds, ...topCmdIds])].sort((a, b) => a - b);

  const lines: string[] = [];
  lines.push(`# Baichuan PCAP summary diff\n`);
  lines.push(`Files:`);
  for (const x of summaries) lines.push(`- ${fileTag(x.path, x.s)}`);
  lines.push("");
  lines.push(`Included cmdIds: ${cmdIds.join(", ")}`);

  lines.push("");
  lines.push(`Camera ports (top by bytes):`);
  for (const x of summaries) {
    const top = x.s.cameraPorts?.topByBytes;
    const parsed = x.s.cameraPorts?.parsedPorts;
    const topStr = Array.isArray(top) && top.length
      ? top.slice(0, 6).map((p) => `${p.port}:${p.bytes}`).join(" ")
      : "-";
    const parsedStr = Array.isArray(parsed) && parsed.length ? parsed.join(",") : "-";
    lines.push(`- ${fileTag(x.path, x.s)} ports=${topStr} parsed=${parsedStr}`);
  }
  lines.push("");

  for (const cmdId of cmdIds) {
    lines.push(`## cmdId=${cmdId}`);
    for (const x of summaries) {
      const d = describeCmd(x.s, cmdId);
      lines.push(`### ${fileTag(x.path, x.s)}`);
      if (d.present === "no") {
        lines.push(`- present: no`);
        continue;
      }
      lines.push(`- req/rsp: ${d.req}/${d.rsp}`);
      lines.push(`- payloadBytesTotal: ${d.payloadBytes} (rsp=${d.payloadBytesRsp})`);
      lines.push(`- extBytesTotal: ${d.extBytes}`);
      lines.push(`- reqClass: ${d.reqClass}`);
      lines.push(`- rspClass: ${d.rspClass}`);
      lines.push(`- rspCodes: ${d.rspCodes}`);
      lines.push(`- payloadOffset: ${d.payloadOffset}`);
      lines.push(`- bodyLen: ${d.bodyLen}`);
      lines.push(`- extLen: ${d.extLen}`);
      lines.push(`- payloadLen: ${d.payloadLen}`);
      lines.push(`- bcMediaMagicOff: ${d.bcMediaMagicOff}`);
      if (cmdId === 5) {
        lines.push(`- cmd5 ACK tail samples: ${d.cmd5AckTailSamples}`);
        lines.push(`- cmd5 additionalHeader: ${d.cmd5AdditionalHeader}`);
        lines.push(`- cmd5 iv16 samples: ${d.cmd5IvSamples}`);
        lines.push(`- cmd5 push prefixU32le: ${d.cmd5PushPrefixU32le}`);
        lines.push(`- cmd5 push head samples: ${d.cmd5PushHeadSamples}`);
        lines.push(`- cmd5 push common prefix: ${d.cmd5PushCommonPrefix}`);
        lines.push(`- cmd5 push common prefix (after4): ${d.cmd5PushCommonPrefixAfter4}`);
      }
      if (cmdId === 143) {
        lines.push(`- cmd143 summary: ${d.cmd143Summary}`);
        lines.push(`- cmd143 common prefix: ${d.cmd143CommonPrefix}`);
        lines.push(`- cmd143 mp4 known: ${d.cmd143Mp4Known}`);
        lines.push(`- cmd143 bcMediaMagicOff (scan256): ${d.cmd143BcMediaOff256}`);
        lines.push(`- cmd143 additionalHeaderMagicOff (scan256): ${d.cmd143AdditionalHdrOff256}`);
        lines.push(`- cmd143 iv16 samples: ${d.cmd143IvSamples}`);
        lines.push(`- cmd143 head samples: ${d.cmd143HeadSamples}`);
        lines.push(`- cmd143 req samples: ${d.cmd143ReqSamples}`);
        lines.push(`- cmd143 rsp ext samples: ${d.cmd143RspExtSamples}`);
      }
      lines.push("");
    }
    lines.push("");
  }

  const outPath = path.resolve(process.cwd(), "test/artifacts/pcap/baichuan-summary-diff.md");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");

  process.stdout.write(`${outPath}\n`);
}

main();
