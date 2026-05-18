/**
 * Decode a BCUDP pcap and extract Baichuan cmd_id usage + XML payloads.
 *
 * Reads `/tmp/argus-capture.pcapng`, uses tshark to dump UDP payloads as
 * hex, then peels the BCUDP framing (NEGO/ACK/DATA), reconstructs the
 * inner byte stream per (host, port, direction), and walks the Baichuan
 * binary frames inside.
 *
 * Output: counts of cmd_ids per direction, plus a few sample XML/JSON
 * bodies so we can see what `getAbility`-like command (if any) appears
 * for a standalone battery camera.
 */
import { spawnSync } from "node:child_process";
import { decodeBcUdpPacket } from "../src/bcudp/packets";

const PCAP = "/tmp/argus-capture.pcapng";
const CAM_IP = "192.168.1.139";
const MY_IP = "192.168.1.193";

interface UdpPkt {
  frame: number;
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  payload: Buffer;
}

function tsharkDumpPackets(): UdpPkt[] {
  const args = [
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
  ];
  const r = spawnSync("/opt/homebrew/bin/tshark", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) {
    console.error("tshark failed:", JSON.stringify({ status: r.status, signal: r.signal, err: r.error?.message, stderr: r.stderr?.slice(0, 400) }));
    process.exit(1);
  }
  const lines = r.stdout.split("\n").filter(Boolean);
  return lines.map((line) => {
    const [frameStr, srcIp, srcPortStr, dstIp, dstPortStr, hex] =
      line.split("\t");
    return {
      frame: Number(frameStr),
      srcIp: srcIp ?? "",
      srcPort: Number(srcPortStr),
      dstIp: dstIp ?? "",
      dstPort: Number(dstPortStr),
      payload: Buffer.from(hex ?? "", "hex"),
    };
  });
}

interface FlowState {
  buf: Buffer;
  cmdIdCounts: Map<number, number>;
  // store first 3 sample bodies per cmd_id for inspection
  samples: Map<number, Buffer[]>;
}

function newFlow(): FlowState {
  return { buf: Buffer.alloc(0), cmdIdCounts: new Map(), samples: new Map() };
}

// Baichuan frame: starts with magic 0xf0debc0a (4 bytes), then header
// (varies 20/24 bytes). cmd_id is at offset 4 (uint32 LE) in the legacy
// header. Body length at offset 8.
const BC_MAGIC = Buffer.from([0xf0, 0xde, 0xbc, 0x0a]);

function walkBaichuanFrames(flow: FlowState): void {
  while (flow.buf.length >= 20) {
    // Find next magic
    const idx = flow.buf.indexOf(BC_MAGIC);
    if (idx === -1) {
      // Drop everything before the next likely magic boundary, keep tail
      flow.buf = flow.buf.subarray(Math.max(0, flow.buf.length - 3));
      return;
    }
    if (idx > 0) flow.buf = flow.buf.subarray(idx);
    if (flow.buf.length < 20) return;

    const cmdId = flow.buf.readUInt32LE(4);
    const bodyLen = flow.buf.readUInt32LE(8);
    const headerLen = 20; // best-effort; some frames use 24
    const frameLen = headerLen + bodyLen;
    if (flow.buf.length < frameLen) return; // wait for more data
    const body = flow.buf.subarray(headerLen, headerLen + bodyLen);

    flow.cmdIdCounts.set(cmdId, (flow.cmdIdCounts.get(cmdId) ?? 0) + 1);
    if ((flow.samples.get(cmdId)?.length ?? 0) < 3) {
      const list = flow.samples.get(cmdId) ?? [];
      list.push(body);
      flow.samples.set(cmdId, list);
    }

    flow.buf = flow.buf.subarray(frameLen);
  }
}

function main(): void {
  const pkts = tsharkDumpPackets();
  console.log(`Total UDP packets w/ payload: ${pkts.length}`);

  // Two flows: client->camera (we send) and camera->client (responses)
  const flows: Record<string, FlowState> = {
    "client->camera": newFlow(),
    "camera->client": newFlow(),
  };
  let bcudpKinds = { discovery: 0, ack: 0, data: 0, error: 0 };
  let firstDiscoveryXml: string | undefined;
  let lastAckPayloadSamples: Buffer[] = [];

  for (const p of pkts) {
    let dir: keyof typeof flows | undefined;
    if (p.srcIp === MY_IP && p.dstIp === CAM_IP) dir = "client->camera";
    else if (p.srcIp === CAM_IP && p.dstIp === MY_IP) dir = "camera->client";
    if (!dir) continue;

    try {
      const decoded = decodeBcUdpPacket(p.payload);
      if (decoded.kind === "discovery") {
        bcudpKinds.discovery++;
        if (!firstDiscoveryXml) firstDiscoveryXml = decoded.xml;
        continue;
      }
      if (decoded.kind === "ack") {
        bcudpKinds.ack++;
        if (decoded.payload.length > 0) {
          if (lastAckPayloadSamples.length < 5) lastAckPayloadSamples.push(decoded.payload);
          flows[dir].buf = Buffer.concat([flows[dir].buf, decoded.payload]);
          walkBaichuanFrames(flows[dir]);
        }
        continue;
      }
      if (decoded.kind === "data") {
        bcudpKinds.data++;
        flows[dir].buf = Buffer.concat([flows[dir].buf, decoded.payload]);
        walkBaichuanFrames(flows[dir]);
        continue;
      }
    } catch (e) {
      bcudpKinds.error++;
    }
  }

  console.log("\nBCUDP packet kinds:", bcudpKinds);
  console.log("\n--- First discovery XML (truncated) ---");
  console.log((firstDiscoveryXml ?? "(none)").slice(0, 400));

  console.log("\n--- Sample ACK payload first bytes (camera→client) ---");
  for (const s of lastAckPayloadSamples.slice(0, 3)) {
    console.log("  hex:", s.subarray(0, 32).toString("hex"));
  }

  for (const [dir, flow] of Object.entries(flows)) {
    console.log(`\n=== ${dir} ===`);
    const ordered = [...flow.cmdIdCounts.entries()].sort((a, b) => b[1] - a[1]);
    console.log("cmd_id distribution (count):");
    for (const [cmdId, count] of ordered.slice(0, 25)) {
      console.log(`  cmd_id=${String(cmdId).padStart(4)}  ${count}x`);
    }
    console.log("\nSample bodies (first 200 bytes utf-8 best-effort):");
    for (const [cmdId, bodies] of [...flow.samples.entries()].sort((a, b) => a[0] - b[0]).slice(0, 12)) {
      const first = bodies[0];
      if (!first) continue;
      const printable = first
        .subarray(0, 240)
        .toString("utf-8")
        .replace(/[^\x20-\x7e\n]/g, "·");
      console.log(`  cmd_id=${cmdId} (len=${first.length}): ${printable}`);
    }
  }
}

main();
