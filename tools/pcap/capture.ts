/**
 * Interactive live-capture helper for Baichuan analysis.
 *
 * Picks the right network interface, verifies the camera is reachable,
 * spawns tshark to record traffic to a pcapng file, and (optionally) packages
 * the capture into a ready-to-attach issue bundle.
 *
 * Designed for non-experts: the prompts walk the user through what to do
 * (start app, reproduce the action, press ENTER to stop).
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { networkInterfaces, hostname, platform, arch, release } from "node:os";
import { existsSync, mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { resolve as resolvePath, join as pathJoin, basename, dirname } from "node:path";
import * as net from "node:net";

export interface CaptureOpts {
  /** Pre-supplied camera IP. If absent, prompts. */
  host?: string;
  /** Pre-supplied interface name (as listed by `tshark -D`). If absent, prompts. */
  iface?: string;
  /** Output pcapng path. Default: `pcap/<host>-<ts>.pcapng`. */
  output?: string;
  /** TCP port to capture (default 9000). */
  port?: number;
  /** If true, also produce a tar.gz bundle suitable for a GitHub issue. */
  bundle?: boolean;
  /** Skip all prompts; fail if any required field is missing. */
  nonInteractive?: boolean;
  /** Optional human-readable label to include in the bundle README. */
  label?: string;
  /** Skip the two ENTER prompts: start immediately, stop on SIGINT. */
  auto?: boolean;
  /** Capture every protocol to/from the camera (TCP+UDP, all ports). */
  allTraffic?: boolean;
}

interface TsharkInterface {
  index: number;
  name: string;
  description?: string;
  ipv4?: string;
}

export async function runCapture(opts: CaptureOpts): Promise<void> {
  ensureTshark();

  const interfaces = listInterfaces();
  if (interfaces.length === 0) {
    fail("no network interfaces with IPv4 addresses found");
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const host = opts.host ?? (await prompt(rl, "Camera IP address: "));
    if (!host) fail("camera IP required");

    const port = opts.port ?? 9000;
    await ensureReachable(host, port);

    const iface = opts.iface
      ? interfaces.find((i) => i.name === opts.iface || String(i.index) === String(opts.iface))
      : await pickInterface(rl, interfaces, host);
    if (!iface) fail(`interface not found: ${opts.iface ?? "(none)"}`);

    const outPath = resolveOutputPath(opts.output, host);
    mkdirSync(dirname(outPath), { recursive: true });

    const filter = opts.allTraffic ? `host ${host}` : `host ${host} and tcp port ${port}`;
    process.stdout.write(
      [
        "",
        `Recording on ${iface.name}${iface.description ? ` (${iface.description})` : ""}` +
          `${iface.ipv4 ? ` [${iface.ipv4}]` : ""}`,
        `Filter:    ${filter}`,
        `Output:    ${outPath}`,
        "",
        opts.auto
          ? "Auto mode: capture starts immediately. Send SIGINT (Ctrl-C) or run `kill -INT <pid>` to stop."
          : "Next steps:\n" +
            "  1. Make sure the Reolink mobile/desktop app is closed.\n" +
            "  2. Press ENTER here to start recording.\n" +
            "  3. Open the Reolink app and reproduce the action.\n" +
            "  4. Press ENTER again to stop the capture.",
        "",
      ].join("\n"),
    );
    if (!opts.auto) {
      await prompt(rl, "[ENTER to start] ");
    }

    const stoppedAt = await runTsharkUntilEnter({
      ifaceName: iface.name,
      host,
      port,
      output: outPath,
      rl,
      stopOnSignal: opts.auto === true,
      filterOverride: opts.allTraffic ? `host ${host}` : undefined,
    });

    process.stdout.write(`\nCapture stopped at ${stoppedAt.toISOString()}\nSaved: ${outPath}\n`);

    if (opts.bundle) {
      const summary = await prompt(rl, "Brief description for the issue bundle (1 line): ");
      const bundlePath = makeBundle({
        pcapPath: outPath,
        cameraHost: host,
        ifaceName: iface.name,
        port,
        label: opts.label,
        description: summary,
      });
      process.stdout.write(`Bundle ready: ${bundlePath}\n`);
      process.stdout.write(
        "  Attach the .tar.gz to a new issue at https://github.com/apocaliss92/nodelink-js/issues/new\n",
      );
    }
  } finally {
    rl.close();
  }
}

function ensureTshark(): void {
  const r = spawnSync("tshark", ["-v"], { stdio: "ignore" });
  if (r.error || r.status !== 0) {
    fail("tshark not found on PATH (install Wireshark and re-run)");
  }
}

function listInterfaces(): TsharkInterface[] {
  const r = spawnSync("tshark", ["-D"], { encoding: "utf8" });
  if (r.status !== 0) {
    fail(`tshark -D failed: ${r.stderr?.trim()}`);
  }
  // Lines look like:  "2. en0 (Wi-Fi)"
  const re = /^(\d+)\.\s+(\S+)(?:\s+\((.+)\))?$/;
  const out: TsharkInterface[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = re.exec(line.trim());
    if (!m) continue;
    out.push({ index: Number(m[1]), name: m[2], description: m[3] });
  }
  // Enrich with local IPv4 from os.networkInterfaces.
  const os = networkInterfaces();
  for (const iface of out) {
    const addrs = os[iface.name];
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal) {
        iface.ipv4 = a.address;
        break;
      }
    }
  }
  return out;
}

async function pickInterface(
  rl: ReadlineInterface,
  interfaces: TsharkInterface[],
  cameraIp: string,
): Promise<TsharkInterface> {
  process.stdout.write("\nAvailable network interfaces:\n");
  // Reorder: interfaces that share a /24 with the camera first.
  const cameraPrefix = cameraIp.split(".").slice(0, 3).join(".");
  const sorted = [...interfaces].sort((a, b) => {
    const aMatch = a.ipv4?.startsWith(`${cameraPrefix}.`) ? 0 : 1;
    const bMatch = b.ipv4?.startsWith(`${cameraPrefix}.`) ? 0 : 1;
    return aMatch - bMatch;
  });
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i];
    const friendly = it.description ? ` — ${it.description}` : "";
    const ip = it.ipv4 ? `  ${it.ipv4}` : "";
    const sameSubnet = it.ipv4?.startsWith(`${cameraPrefix}.`) ? "  ← shares subnet with camera" : "";
    process.stdout.write(`  [${i + 1}]  ${it.name}${friendly}${ip}${sameSubnet}\n`);
  }
  const def = "1";
  const choice = (await prompt(rl, `Choose interface [${def}]: `)) || def;
  const idx = Number(choice) - 1;
  if (!Number.isFinite(idx) || idx < 0 || idx >= sorted.length) {
    fail(`invalid choice: ${choice}`);
  }
  return sorted[idx];
}

async function ensureReachable(host: string, port: number): Promise<void> {
  process.stdout.write(`Checking ${host}:${port} …`);
  const pingOk = await pingHost(host);
  process.stdout.write(pingOk ? " ping OK" : " ping FAIL");
  const tcpOk = await probeTcp(host, port);
  process.stdout.write(tcpOk ? `  tcp:${port} OK\n` : `  tcp:${port} CLOSED\n`);
  if (!tcpOk && !pingOk) {
    fail(`camera ${host} is unreachable (ping + tcp probe both failed)`);
  }
  if (!tcpOk) {
    process.stdout.write(
      `  warning: TCP ${port} did not answer — capture will still start, but the camera may be offline.\n`,
    );
  }
}

function pingHost(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const args = platform() === "darwin" || platform() === "linux"
      ? ["-c", "2", "-W", "2000", host]
      : ["-n", "2", "-w", "2000", host];
    const child = spawn("ping", args, { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function probeTcp(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.once("timeout", () => finish(false));
  });
}

interface CaptureSpawnOpts {
  ifaceName: string;
  host: string;
  port: number;
  output: string;
  rl: ReadlineInterface;
  /** Auto mode: stop on SIGINT instead of waiting for an ENTER prompt. */
  stopOnSignal?: boolean;
  /** Use a custom BPF filter instead of `host X and tcp port N`. */
  filterOverride?: string;
}

function runTsharkUntilEnter(opts: CaptureSpawnOpts): Promise<Date> {
  return new Promise((resolve, reject) => {
    const filter = opts.filterOverride ?? `host ${opts.host} and tcp port ${opts.port}`;
    const args = [
      "-i",
      opts.ifaceName,
      "-f",
      filter,
      "-w",
      opts.output,
      "-q",
    ];
    const child = spawn("tshark", args, { stdio: ["ignore", "pipe", "pipe"] });
    let packets = 0;
    const tick = setInterval(() => {
      process.stdout.write(`\r  capturing… (${packets} packets seen)`);
    }, 500);

    // tshark in `-q` mode prints to stderr lines like:
    //   "Capturing on 'Wi-Fi'"
    //   "121 "  (just the running counter, no "packets" word on macOS)
    // We accept both shapes so the live counter works on macOS and Linux.
    child.stderr.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      const m = /(\d+)(?:\s+packets?)?/g;
      let last: number | undefined;
      for (let match = m.exec(s); match !== null; match = m.exec(s)) {
        const n = Number(match[1]);
        if (Number.isFinite(n)) last = n;
      }
      if (last !== undefined) packets = last;
    });

    const stop = () => {
      clearInterval(tick);
      try {
        child.kill("SIGINT");
      } catch {
        /* ignore */
      }
    };

    if (opts.stopOnSignal) {
      // Auto mode: report own pid so a sibling shell can `kill -INT <pid>`.
      process.stdout.write(`  driver pid=${process.pid}\n`);
      const onSig = () => stop();
      process.on("SIGINT", onSig);
      process.on("SIGTERM", onSig);
    } else {
      opts.rl.question("[ENTER to stop] ", () => stop());
    }

    child.on("close", (code) => {
      clearInterval(tick);
      process.stdout.write("\n");
      if (code !== 0 && code !== 130 /* SIGINT exit on macOS */ && code !== null) {
        reject(new Error(`tshark exited with code ${code}`));
        return;
      }
      resolve(new Date());
    });
    child.on("error", (err) => {
      clearInterval(tick);
      reject(err);
    });
  });
}

interface BundleInput {
  pcapPath: string;
  cameraHost: string;
  ifaceName: string;
  port: number;
  label?: string;
  description?: string;
}

function makeBundle(input: BundleInput): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `baichuan-capture-${input.label ?? "session"}-${stamp}`;
  const dir = resolvePath(dirname(input.pcapPath), name);
  mkdirSync(dir, { recursive: true });

  // 1. copy the pcap as-is
  const pcapName = basename(input.pcapPath);
  spawnSync("cp", [input.pcapPath, pathJoin(dir, pcapName)], { stdio: "ignore" });

  // 2. write a README with reproduction context (no credentials!)
  const readme = `# Baichuan capture bundle

Generated: ${new Date().toISOString()}

## Reproduction context

- Description: ${input.description ?? "(not provided)"}
- Camera host: ${input.cameraHost}
- Capture interface: ${input.ifaceName}
- Capture filter: host ${input.cameraHost} and tcp port ${input.port}

## Environment

- OS: ${platform()} ${release()} (${arch()})
- Hostname: ${hostname()}
- Node: ${process.version}

## How to analyse locally

\`\`\`bash
npx tsx tools/pcap/analyzer.ts groups ${pcapName}
npx tsx tools/pcap/analyzer.ts analyze ${pcapName} --env .env
\`\`\`

> Passwords are auto-loaded from \`.env\` only on your machine — the .env
> file is **not** included in this bundle. The capture itself contains
> AES-encrypted XML; to decrypt it the reviewer needs the camera password
> used at capture time.
`;
  writeFileSync(pathJoin(dir, "README.md"), readme, "utf8");

  // 3. tar.gz the bundle
  const tarPath = `${dir}.tar.gz`;
  const r = spawnSync("tar", ["-czf", tarPath, "-C", dirname(dir), basename(dir)], {
    stdio: "ignore",
  });
  if (r.status !== 0) fail(`tar failed: ${r.stderr?.toString().trim()}`);
  return tarPath;
}

function resolveOutputPath(supplied: string | undefined, host: string): string {
  if (supplied) return resolvePath(supplied);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeHost = host.replace(/[^0-9a-z.]/gi, "_");
  return resolvePath(process.cwd(), "pcap", `${safeHost}-${ts}.pcapng`);
}

function prompt(rl: ReadlineInterface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
}

/** Parse positional argv for the `capture` subcommand into CaptureOpts. */
export function parseCaptureFlags(argv: string[]): CaptureOpts {
  const opts: CaptureOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") opts.host = argv[++i];
    else if (a === "--iface" || a === "-i") opts.iface = argv[++i];
    else if (a === "--output" || a === "-o") opts.output = argv[++i];
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--bundle") opts.bundle = true;
    else if (a === "--non-interactive") opts.nonInteractive = true;
    else if (a === "--label") opts.label = argv[++i];
  }
  return opts;
}

// Unused but exported so the bundle helper can be tested standalone.
export const _internal = { listInterfaces, probeTcp, pingHost, makeBundle };

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

void createWriteStream;
