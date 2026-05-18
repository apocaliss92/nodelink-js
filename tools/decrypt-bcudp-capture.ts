/**
 * Offline decryption of a BCUDP pcap: peel BCUDP framing → reconstruct
 * Baichuan stream per direction → walk frames → derive AES key from the
 * login nonce → AES-decrypt all subsequent bodies → dump cmd_id + XML.
 *
 * Usage:
 *   ARGUS_PASSWORD=xxx npx tsx tools/decrypt-bcudp-capture.ts
 *
 * Hard-coded for the current capture (/tmp/argus-capture.pcapng).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeBcUdpPacket } from "../src/bcudp/packets";
import { BaichuanFrameParser } from "../src/protocol/framing";
import { aesDecrypt, bcDecrypt, deriveAesKey } from "../src/protocol/crypto";
import { getXmlText } from "../src/protocol/xml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PCAP = "/tmp/argus-capture.pcapng";
const CAM_IP = "192.168.1.139";
const MY_IP = "192.168.1.193";
const PASSWORD = process.env.ARGUS_PASSWORD;
if (!PASSWORD) {
  console.error("Set ARGUS_PASSWORD in env");
  process.exit(2);
}

const OUT = path.join(__dirname, "probe-ability-out", "argus-decrypted");
fs.mkdirSync(OUT, { recursive: true });

interface UdpPkt {
  frame: number;
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  payload: Buffer;
}

function tsharkDumpPackets(): UdpPkt[] {
  const r = spawnSync(
    "/opt/homebrew/bin/tshark",
    [
      "-r",
      PCAP,
      "-Y",
      "udp && data",
      "-T",
      "fields",
      "-e",
      "frame.number",
      "-e",
      "ip.src",
      "-e",
      "udp.srcport",
      "-e",
      "ip.dst",
      "-e",
      "udp.dstport",
      "-e",
      "data.data",
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout) {
    console.error("tshark failed", r.stderr);
    process.exit(1);
  }
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [a, b, c, d, e, hex] = line.split("\t");
      return {
        frame: Number(a),
        srcIp: b ?? "",
        srcPort: Number(c),
        dstIp: d ?? "",
        dstPort: Number(e),
        payload: Buffer.from(hex ?? "", "hex"),
      };
    });
}

function main(): void {
  const pkts = tsharkDumpPackets();
  console.log(`Total UDP packets w/ payload: ${pkts.length}`);

  const parsers = {
    "client->camera": new BaichuanFrameParser(),
    "camera->client": new BaichuanFrameParser(),
  } as const;
  const directions: Array<keyof typeof parsers> = [
    "client->camera",
    "camera->client",
  ];

  let nonce: string | undefined;
  let aesKey: Buffer | undefined;
  let cipherKind: "none" | "bc" | "aes" = "bc"; // before login

  const cmdSeen = new Map<string, { count: number; samples: Array<{ dir: string; xml: string; raw: Buffer; channelId: number; respCode: number; bodyLen: number }> }>();
  function record(
    dir: string,
    cmdId: number,
    channelId: number,
    respCode: number,
    body: Buffer,
    xml: string,
  ) {
    const key = `${cmdId}`;
    const entry = cmdSeen.get(key) ?? { count: 0, samples: [] };
    entry.count++;
    if (entry.samples.length < 4) {
      entry.samples.push({ dir, xml, raw: body, channelId, respCode, bodyLen: body.length });
    }
    cmdSeen.set(key, entry);
  }

  for (const p of pkts) {
    let dir: keyof typeof parsers | undefined;
    if (p.srcIp === MY_IP && p.dstIp === CAM_IP) dir = "client->camera";
    else if (p.srcIp === CAM_IP && p.dstIp === MY_IP) dir = "camera->client";
    if (!dir) continue;

    try {
      const dec = decodeBcUdpPacket(p.payload);
      if (dec.kind === "discovery") continue;
      const innerPayload = dec.payload;
      if (!innerPayload || innerPayload.length === 0) continue;
      const frames = parsers[dir].push(innerPayload);
      for (const f of frames) {
        const { cmdId, channelId, responseCode } = f.header;
        const body = f.body as Buffer;
        let xml = "";
        // Debug: log every cmd_id=1 we see
        if (cmdId === 1) {
          console.log(`[cmd1] dir=${dir} respCode=0x${responseCode.toString(16)} ch=${channelId} bodyLen=${f.header.bodyLen}`);
        }
        // Login nonce response: BC-encrypted, responseCode 0xDDxx
        if (cmdId === 1 && dir === "camera->client" && (responseCode >>> 8) === 0xdd) {
          const dec1 = bcDecrypt(body, channelId);
          xml = dec1.toString("utf-8");
          nonce = getXmlText(xml, "nonce") || nonce;
          const encType = responseCode & 0xff;
          if ((encType === 0x02 || encType === 0x12) && nonce) {
            aesKey = deriveAesKey(nonce, PASSWORD!);
            cipherKind = "aes";
            console.log(
              `[login] nonce=${nonce} encType=0x${encType.toString(16)} (${encType === 0x12 ? "full_aes" : "aes"}) → AES key derived`,
            );
          } else if (encType === 0x01) {
            cipherKind = "bc";
          }
          record(dir, cmdId, channelId, responseCode, body, xml);
          continue;
        }

        // Best-effort decrypt: try the active cipher; if it doesn't produce XML, fall back.
        const candidates: Array<() => Buffer> = [];
        if (cipherKind === "aes" && aesKey)
          candidates.push(() => aesDecrypt(body, aesKey!));
        candidates.push(() => bcDecrypt(body, channelId));
        candidates.push(() => body);
        let plain = body;
        let plainXml = "";
        for (const fn of candidates) {
          try {
            const b = fn();
            const s = b.toString("utf-8");
            if (s.startsWith("<?xml")) {
              plain = b;
              plainXml = s;
              break;
            }
          } catch {
            // try next
          }
        }
        record(dir, cmdId, channelId, responseCode, plain, plainXml);
      }
    } catch (e) {
      // skip; some BCUDP frames may legitimately fail to parse
    }
  }

  // Summary
  console.log("\n=== Cmd_id summary (decrypted) ===");
  const ordered = [...cmdSeen.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [cmdIdStr, entry] of ordered) {
    const cmdId = Number(cmdIdStr);
    const dirs = new Set(entry.samples.map((s) => s.dir));
    const sampleXml = entry.samples.find((s) => s.xml.startsWith("<?xml"));
    console.log(
      `cmd_id=${String(cmdId).padStart(3)} count=${entry.count} dirs=[${[...dirs].join(",")}] xml=${sampleXml ? "yes" : "no"}`,
    );
    // Dump every sample, split by direction
    for (let i = 0; i < entry.samples.length; i++) {
      const s = entry.samples[i]!;
      const dirShort = s.dir === "client->camera" ? "req" : "rsp";
      const ext = s.xml.startsWith("<?xml") ? "xml" : "bin";
      const file = path.join(OUT, `cmd${cmdId}__${i}__${dirShort}.${ext}`);
      fs.writeFileSync(file, ext === "xml" ? s.xml : s.raw);
    }
  }
  console.log(`\nSaved decoded files to ${OUT}`);
}

main();
