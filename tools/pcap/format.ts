import { describeCmdId, describeMessageClass } from "./cmd-names";
import type { AnnotatedFrame } from "./decrypt";

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
} as const;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
function c(color: keyof typeof COLORS, s: string): string {
  if (!useColor) return s;
  return `${COLORS[color]}${s}${COLORS.reset}`;
}

export function formatHeaderLine(af: AnnotatedFrame): string {
  const { header } = af.frame;
  const dirArrow = af.pcap.direction === "c2s" ? c("cyan", "→") : c("magenta", "←");
  const cmd = describeCmdId(header.cmdId);
  const cls = describeMessageClass(header.messageClass);
  const rc = `0x${header.responseCode.toString(16).padStart(4, "0")}`;
  const ts = new Date(af.pcap.timestamp * 1000).toISOString().substring(11, 23);
  const stream = `s${af.pcap.streamId}`;
  return [
    c("dim", ts),
    c("dim", `#${af.pcap.frameNumber.toString().padStart(5, " ")}`),
    c("dim", stream),
    dirArrow,
    c("bold", `cmd=${header.cmdId}`),
    cmd === `cmd_${header.cmdId}` ? c("dim", "(?)") : c("green", cmd),
    c("dim", `ch=${header.channelId}`),
    c("dim", `msg#${header.msgNum}`),
    c("dim", `rc=${rc}`),
    c("dim", cls),
    c("dim", `body=${header.bodyLen}`),
    af.decryptedAs ? c("yellow", `[${af.decryptedAs}]`) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatXml(xml: string, indent = 2): string {
  // Light pretty-printer: insert newlines between adjacent tags. Avoids the
  // overhead of a full DOM parse just for display.
  const pretty = xml
    .replace(/></g, ">\n<")
    .split("\n")
    .map((line) => line.trimEnd());

  let level = 0;
  const lines: string[] = [];
  for (const line of pretty) {
    const isClose = /^<\//.test(line);
    const isSelfClose = /\/>$/.test(line);
    const isOpenClose = /^<[^!?][^>]*>.*<\//.test(line);
    if (isClose) level = Math.max(0, level - 1);
    lines.push(" ".repeat(level * indent) + line);
    if (!isClose && !isSelfClose && !isOpenClose && /^<[^!?]/.test(line)) level += 1;
  }
  return lines.join("\n");
}

export function hexPreview(buf: Buffer, max = 64): string {
  const slice = buf.subarray(0, max);
  const hex = slice.toString("hex").match(/../g)?.join(" ") ?? "";
  const truncated = buf.length > max ? c("dim", ` …+${buf.length - max}B`) : "";
  return hex + truncated;
}

export function formatFrame(af: AnnotatedFrame, opts: { showXml?: boolean; showHex?: boolean } = {}): string {
  const head = formatHeaderLine(af);
  const lines = [head];
  if (opts.showXml ?? true) {
    if (af.decryptedExtensionXml) {
      lines.push(c("dim", "  ext:"));
      lines.push(indentBlock(formatXml(af.decryptedExtensionXml), 4));
    }
    if (af.decryptedXml) {
      lines.push(c("dim", "  body:"));
      lines.push(indentBlock(formatXml(af.decryptedXml), 4));
    } else if (af.frame.body.length > 0) {
      lines.push(c("dim", `  body (${af.frame.body.length}B, undecryptable): ${hexPreview(af.frame.body)}`));
    }
  }
  if (opts.showHex) {
    lines.push(c("dim", `  raw: ${hexPreview(af.frame.raw)}`));
  }
  return lines.join("\n");
}

function indentBlock(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
