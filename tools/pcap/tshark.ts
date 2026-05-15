import { spawn } from "node:child_process";

/**
 * Single TCP payload chunk extracted from a pcap, in capture order.
 *
 * `streamId` is tshark's `tcp.stream` index (unique per TCP connection).
 * `direction` is which side authored the bytes, resolved by which endpoint
 * uses the target port (9000 by default for Baichuan).
 */
export interface PcapTcpPayload {
  frameNumber: number;
  timestamp: number;
  streamId: number;
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  direction: "c2s" | "s2c";
  payload: Buffer;
}

export interface TsharkOptions {
  port?: number;
  /** Filter to only the given TCP stream id(s). */
  streamIds?: number[];
  /** Path to tshark binary (defaults to PATH lookup). */
  bin?: string;
}

/**
 * Extract Baichuan-flavoured TCP payloads from a pcap/pcapng file.
 *
 * Uses tshark with `-T fields` so we get one row per TCP segment. We do NOT
 * rely on tshark's reassembly: the `BaichuanFrameParser` already buffers
 * partial frames across segments, so feeding raw bytes per direction works.
 *
 * Throws if `tshark` is missing or returns no Baichuan traffic.
 */
export async function extractBaichuanPayloads(
  pcapPath: string,
  options: TsharkOptions = {},
): Promise<PcapTcpPayload[]> {
  const port = options.port ?? 9000;
  const bin = options.bin ?? "tshark";

  const filter = options.streamIds?.length
    ? `tcp.port == ${port} && tcp.len > 0 && (${options.streamIds
        .map((id) => `tcp.stream == ${id}`)
        .join(" || ")})`
    : `tcp.port == ${port} && tcp.len > 0`;

  const args = [
    "-r",
    pcapPath,
    "-Y",
    filter,
    "-T",
    "fields",
    "-E",
    "separator=|",
    "-E",
    "occurrence=f",
    "-e",
    "frame.number",
    "-e",
    "frame.time_epoch",
    "-e",
    "tcp.stream",
    "-e",
    "ip.src",
    "-e",
    "tcp.srcport",
    "-e",
    "ip.dst",
    "-e",
    "tcp.dstport",
    "-e",
    "tcp.payload",
  ];

  const { stdout, stderr, code } = await runTshark(bin, args);
  if (code !== 0) {
    throw new Error(`tshark exited with code ${code}: ${stderr.trim()}`);
  }

  const out: PcapTcpPayload[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split("|");
    if (fields.length < 8) continue;
    const [frameStr, tsStr, streamStr, srcIp, srcPortStr, dstIp, dstPortStr, payloadHex] = fields;
    if (!payloadHex) continue;
    const srcPort = Number(srcPortStr);
    const dstPort = Number(dstPortStr);
    out.push({
      frameNumber: Number(frameStr),
      timestamp: Number(tsStr),
      streamId: Number(streamStr),
      srcIp: srcIp ?? "",
      srcPort,
      dstIp: dstIp ?? "",
      dstPort,
      direction: dstPort === port ? "c2s" : "s2c",
      payload: Buffer.from(payloadHex.replace(/:/g, ""), "hex"),
    });
  }

  return out;
}

function runTshark(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (b) => stdoutChunks.push(b));
    child.stderr.on("data", (b) => stderrChunks.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        code: code ?? -1,
      });
    });
  });
}

/**
 * Group payloads into per-stream-per-direction byte streams, preserving order.
 * Each value is the in-order concatenation of TCP payloads for that direction.
 */
export function groupByStreamDirection(
  payloads: PcapTcpPayload[],
): Map<string, PcapTcpPayload[]> {
  const grouped = new Map<string, PcapTcpPayload[]>();
  for (const p of payloads) {
    const key = `${p.streamId}:${p.direction}`;
    const list = grouped.get(key);
    if (list) list.push(p);
    else grouped.set(key, [p]);
  }
  return grouped;
}
