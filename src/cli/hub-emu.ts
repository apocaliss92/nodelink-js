#!/usr/bin/env node
/**
 * Hub emulator CLI
 *
 * Goal: emulate Reolink Home Hub behaviours (TCP/6666 + UDP/7777), and optionally
 * trigger devices to connect via BCUDP "kick" (UDP 2015/2018).
 *
 * Typical flows:
 *  - Pair-ish: run with a pairing transcript (replay on 6666)
 *  - Unpair: run with an unpair transcript + send-first (hub-initiated first record)
 *
 * Example (unpair):
 *   node dist/cli/hub-emu.cjs unpair --bind-host 0.0.0.0 --transcript test/pcap/exports/unpair-6666-transcript.json --kick-host 192.168.1.139 --kick-uid 9527000HZ56U1ORU --exit-after-ms 60000
 */

import path from "node:path";
import { HubEmulator } from "../hub/HubEmulator";
import { BcUdpStream } from "../bcudp/BcUdpStream";

type Cmd = "run" | "pair" | "unpair";

type Options = {
  cmd: Cmd;
  bindHost: string;
  tcpPort: number;
  udp7777: boolean;

  transcript: string | undefined;
  replayVerbose: boolean;
  replayMutatePrefixToken: boolean;
  replaySendFirst: boolean;
  replaySendFirstRelMsMax: number;

  expectedHubMacHex: string | undefined;

  exitAfterMs: number;
  idleExitMs: number;
  capturePath: string | undefined;
  findAsciiNeedle: string | undefined;

  kick: boolean;
  kickHost: string | undefined;
  kickUid: string | undefined;
  kickMethod: "local-direct" | "local-broadcast";
  kickTimeoutMs: number;
};

function resolvePathMaybe(relOrAbs: string): string {
  return path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(process.cwd(), relOrAbs);
}

function parseBool(raw: string | undefined, def: boolean): boolean {
  if (raw == null) return def;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n") return false;
  return def;
}

function parseArgs(argv: string[]): Options {
  const args = argv.slice(2);

  let cmd: Cmd = "run";
  if (args[0] && !args[0]!.startsWith("--")) {
    const c = args.shift()!.trim().toLowerCase();
    if (c === "run" || c === "pair" || c === "unpair") cmd = c;
    else throw new Error(`Unknown command ${JSON.stringify(c)} (expected run|pair|unpair)`);
  }

  const opt: Options = {
    cmd,
    bindHost: "0.0.0.0",
    tcpPort: 6666,
    udp7777: true,

    transcript: undefined,
    replayVerbose: true,
    replayMutatePrefixToken: true,
    replaySendFirst: false,
    replaySendFirstRelMsMax: 0,

    expectedHubMacHex: process.env.NVR_MAC,

    exitAfterMs: 0,
    idleExitMs: 0,
    capturePath: undefined,
    findAsciiNeedle: undefined,

    kick: false,
    kickHost: process.env.UDP_HOST,
    kickUid: process.env.UDP_UID,
    kickMethod: "local-direct",
    kickTimeoutMs: 30_000,
  };

  for (let i = 0; i < args.length; i++) {
    let a = args[i]!;
    let next = args[i + 1];

    if (a.includes("=")) {
      const [k, v] = a.split("=", 2);
      a = k || a;
      next = v;
    }

    const eat = () => {
      if (!args[i]!.includes("=")) i++;
    };

    switch (a) {
      case "--bind-host":
        if (next) {
          opt.bindHost = next;
          eat();
        }
        break;
      case "--tcp-port":
        if (next) {
          opt.tcpPort = Number.parseInt(next, 10);
          eat();
        }
        break;
      case "--udp7777":
        opt.udp7777 = parseBool(next, true);
        if (next && !args[i]!.includes("=")) eat();
        break;
      case "--no-udp7777":
        opt.udp7777 = false;
        break;

      case "--transcript":
        if (next) {
          opt.transcript = next;
          eat();
        }
        break;

      case "--replay-verbose":
        opt.replayVerbose = parseBool(next, true);
        if (next && !args[i]!.includes("=")) eat();
        break;
      case "--replay-mutate-prefix-token":
        opt.replayMutatePrefixToken = parseBool(next, true);
        if (next && !args[i]!.includes("=")) eat();
        break;
      case "--replay-send-first":
        opt.replaySendFirst = parseBool(next, true);
        if (next && !args[i]!.includes("=")) eat();
        break;
      case "--replay-send-first-relms-max":
        if (next) {
          opt.replaySendFirstRelMsMax = Number.parseFloat(next);
          eat();
        }
        break;

      case "--expected-hub-mac":
        if (next) {
          opt.expectedHubMacHex = next;
          eat();
        }
        break;

      case "--exit-after-ms":
        if (next) {
          opt.exitAfterMs = Number.parseInt(next, 10);
          eat();
        }
        break;
      case "--idle-exit-ms":
        if (next) {
          opt.idleExitMs = Number.parseInt(next, 10);
          eat();
        }
        break;
      case "--capture":
        if (next) {
          opt.capturePath = next;
          eat();
        }
        break;
      case "--find-ascii":
        if (next) {
          opt.findAsciiNeedle = next;
          eat();
        }
        break;

      case "--kick":
        opt.kick = true;
        break;
      case "--kick-host":
        if (next) {
          opt.kick = true;
          opt.kickHost = next;
          eat();
        }
        break;
      case "--kick-uid":
        if (next) {
          opt.kick = true;
          opt.kickUid = next;
          eat();
        }
        break;
      case "--kick-method":
        if (next) {
          opt.kickMethod = next === "local-broadcast" ? "local-broadcast" : "local-direct";
          eat();
        }
        break;
      case "--kick-timeout-ms":
        if (next) {
          opt.kickTimeoutMs = Number.parseInt(next, 10);
          eat();
        }
        break;

      default:
        throw new Error(`Unknown arg ${JSON.stringify(a)}`);
    }
  }

  // Presets
  if (opt.cmd === "unpair") {
    opt.replaySendFirst = true;
    // if user didn't pass transcript, fall back to local dev default
    if (!opt.transcript) opt.transcript = "test/pcap/exports/unpair-6666-transcript.json";
  }

  return opt;
}

async function bcudpKick(host: string, uid: string, method: "local-direct" | "local-broadcast", timeoutMs: number): Promise<void> {
  const s = new BcUdpStream({
    mode: "uid",
    uid,
    directHost: host,
    discoveryMethod: method,
  });

  const startedAt = Date.now();
  try {
    await Promise.race([
      s.connect(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`kick timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    const dt = Date.now() - startedAt;
    // eslint-disable-next-line no-console
    console.log(`[hub-emu][kick] ok in ${dt}ms`);
  } finally {
    await s.close();
  }
}

async function main(): Promise<void> {
  const opt = parseArgs(process.argv);

  const transcriptPath = opt.transcript ? resolvePathMaybe(opt.transcript) : "";

  const hubOpts: import("../hub/HubEmulator").HubEmulatorOptions = {
    bindHost: opt.bindHost,
    tcpPort: opt.tcpPort,
    enableUdp7777: opt.udp7777,
    replayVerbose: opt.replayVerbose,
    replayMutatePrefixToken: opt.replayMutatePrefixToken,
    replaySendFirst: opt.replaySendFirst,
    replaySendFirstRelMsMax: opt.replaySendFirstRelMsMax,
    exitAfterMs: opt.exitAfterMs,
    idleExitMs: opt.idleExitMs,
  };
  if (transcriptPath) hubOpts.transcriptPath = transcriptPath;
  if (opt.expectedHubMacHex) hubOpts.expectedHubMacHex = opt.expectedHubMacHex;
  if (opt.capturePath) hubOpts.capturePath = resolvePathMaybe(opt.capturePath);
  if (opt.findAsciiNeedle) hubOpts.findAsciiNeedle = opt.findAsciiNeedle;

  const hub = new HubEmulator(hubOpts);

  hub.on("listening", (e) => {
    // eslint-disable-next-line no-console
    console.log(`[hub-emu] listening tcp=${e.bindHost}:${e.tcpPort} udp7777=${e.udp7777 ? 1 : 0}`);
    if (transcriptPath) console.log(`[hub-emu] transcript=${transcriptPath}`);
  });
  hub.on("udp7777", (p) => {
    // eslint-disable-next-line no-console
    console.log(`[hub-emu][udp7777] from=${p.from} len=${p.len} uid=${JSON.stringify(p.uid ?? "?")} seq=${p.seq ?? "?"} dataLen=${p.dataLen ?? "?"}`);
  });
  hub.on("tcp6666_rec", (r) => {
    // eslint-disable-next-line no-console
    console.log(`[hub-emu][tcp6666] ${r.remote} rec type=${r.type} len=${r.len} head=${r.payloadHeadHex}`);
  });
  hub.on("shutdown", (s) => {
    // eslint-disable-next-line no-console
    console.log(`[hub-emu] shutdown reason=${JSON.stringify(s.reason)}`);
  });

  const shutdown = async (reason: string) => {
    await hub.shutdown(reason);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await hub.start();

  if (opt.kick) {
    if (!opt.kickHost) throw new Error("Missing --kick-host (or UDP_HOST in env)");
    if (!opt.kickUid) throw new Error("Missing --kick-uid (or UDP_UID in env)");
    // eslint-disable-next-line no-console
    console.log(`[hub-emu][kick] host=${opt.kickHost} uid=${opt.kickUid} method=${opt.kickMethod} timeoutMs=${opt.kickTimeoutMs}`);
    await bcudpKick(opt.kickHost, opt.kickUid, opt.kickMethod, opt.kickTimeoutMs);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exitCode = 1;
});
