#!/usr/bin/env node
/**
 * CLI to start an RTSP server from console
 *
 * Usage:
 *   node dist/cli/rtsp-server.cjs --host 192.168.1.100 --username admin --password pass --channel 0 --profile main
 *
 * Options:
 *   --host <ip>           Camera IP address (required)
 *   --username <user>     Username (required)
 *   --password <pass>     Password (required)
 *   --channel <num>       Channel number (default: 0)
 *   --profile <profile>   Stream profile: main, sub, ext (default: main)
 *   --variant <variant>   Native variant: default, autotrack, telephoto (default: default)
 *   --port <port>         RTSP server port (default: 8554)
 *   --path <path>         RTSP path (default: /stream/<profile>)
 *   --uid <uid>           UID for battery cameras (optional)
 *   --transport <type>    Transport: tcp, udp, auto (default: auto)
 */

import { ReolinkBaichuanApi } from "../reolink/baichuan/ReolinkBaichuanApi";
import { BaichuanRtspServer } from "../baichuan/stream/BaichuanRtspServer";
import { autoDetectDeviceType } from "../reolink/autodetect";
import type { StreamProfile } from "../reolink/baichuan/types";

interface CliOptions {
  host: string;
  username: string;
  password: string;
  channel?: number;
  profile?: StreamProfile;
  variant?: "default" | "autotrack" | "telephoto";
  port?: number;
  path?: string;
  uid?: string;
  transport?: "tcp" | "udp" | "auto";
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: Partial<CliOptions> = {};

  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (!arg) continue;
    let next = args[i + 1];

    // Support --key=value format
    if (arg.includes("=")) {
      const [key, value] = arg.split("=", 2);
      arg = key || arg;
      next = value;
    }

    switch (arg) {
      case "--host":
        if (next) {
          options.host = next;
          if (!args[i]!.includes("=")) i++;
        }
        break;
      case "--username":
      case "--user":
      case "-u":
        if (next) {
          options.username = next;
          if (!args[i]!.includes("=")) i++;
        }
        break;
      case "--password":
      case "-p":
        if (next) {
          options.password = next;
          if (!args[i]!.includes("=")) i++;
        }
        break;
      case "--channel":
      case "-c":
        if (next) {
          options.channel = parseInt(next, 10);
          if (!args[i]!.includes("=")) i++;
        }
        break;
      case "--profile":
        if (next) {
          if (next === "main" || next === "sub" || next === "ext") {
            options.profile = next;
          }
          if (!args[i]!.includes("=")) i++;
        }
        break;
      case "--variant":
        if (next) {
          const v = next.trim().toLowerCase();
          if (v === "default" || v === "autotrack" || v === "telephoto") {
            options.variant = v as any;
          }
          if (!args[i]!.includes("=")) i++;
        }
        break;
      case "--port":
        if (next) {
          options.port = parseInt(next, 10);
          if (!args[i]!.includes("=")) i++;
        }
        break;
      case "--path":
        if (next) {
          options.path = next;
          if (!args[i]!.includes("=")) i++;
        }
        break;
      case "--uid":
        if (next) {
          options.uid = next;
          if (!args[i]!.includes("=")) i++;
        }
        break;
      case "--transport":
        if (next) {
          if (next === "tcp" || next === "udp" || next === "auto") {
            options.transport = next;
          }
          if (!args[i]!.includes("=")) i++;
        }
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
    }
  }

  return options as CliOptions;
}

function printHelp(): void {
  console.log(`
RTSP Server CLI for Reolink Baichuan

Usage:
  node dist/cli/rtsp-server.cjs [options]

Required options:
  --host <ip>           Camera IP address
  --username <user>     Username (or -u, --user)
  --password <pass>     Password (or -p)

Optional options:
  --channel <num>       Channel number (default: 0)
  --profile <profile>   Stream profile: main, sub, ext (default: main)
  --variant <variant>   Native variant: default, autotrack, telephoto (default: default)
  --port <port>         RTSP server port (default: 8554)
  --path <path>         RTSP path (default: /stream/<profile>)
  --uid <uid>           UID for battery cameras
  --transport <type>    Transport: tcp, udp, auto (default: auto)
  --help, -h            Show this message

Examples:
  # Basic RTSP server
  node dist/cli/rtsp-server.cjs --host 192.168.1.100 --username admin --password pass

  # Specific channel with sub profile
  node dist/cli/rtsp-server.cjs --host 192.168.1.100 --username admin --password pass --channel 1 --profile sub

  # TrackMix (NVR) tele/autotrack variant
  node dist/cli/rtsp-server.cjs --host 192.168.1.161 --username admin --password pass --channel 2 --profile sub --variant autotrack --port 8554 --path /tele_sub

  # Custom port
  node dist/cli/rtsp-server.cjs --host 192.168.1.100 --username admin --password pass --port 8555

  # Battery camera (UDP)
  node dist/cli/rtsp-server.cjs --host 192.168.1.100 --username admin --password pass --uid ABC123 --transport udp

  # Key=value format (supported)
  node dist/cli/rtsp-server.cjs --host=192.168.1.100 --user=admin --password=pass
`);
}

async function main(): Promise<void> {
  const options = parseArgs();

  // Validate required options
  if (!options.host || !options.username || !options.password) {
    console.error("Error: --host, --username and --password are required");
    console.error("Use --help to see usage");
    process.exit(1);
  }

  const channel = options.channel ?? 0;
  const profile = options.profile ?? "main";
  const variant = options.variant ?? "default";
  const port = options.port ?? 8554;
  const path = options.path ?? `/stream/${profile}`;
  const transport = options.transport ?? "auto";

  console.log(`[RTSP Server] Connecting to ${options.host}...`);
  console.log(
    `[RTSP Server] Channel: ${channel}, Profile: ${profile}, Variant: ${variant}`,
  );

  try {
    // Auto-detect device type if needed
    let detectedTransport: "tcp" | "udp" = "tcp";
    if (transport === "auto") {
      const detection = await autoDetectDeviceType({
        host: options.host,
        username: options.username,
        password: options.password,
        ...(options.uid ? { uid: options.uid } : {}),
        logger: console,
      });
      detectedTransport = detection.transport;
      console.log(
        `[RTSP Server] Device type: ${detection.type}, Transport: ${detectedTransport}`,
      );
    } else {
      detectedTransport = transport;
    }

    // Create API instance
    const api = new ReolinkBaichuanApi({
      host: options.host,
      username: options.username,
      password: options.password,
      transport: detectedTransport,
      ...(options.uid ? { uid: options.uid } : {}),
      logger: console,
    });

    // Login
    console.log(`[RTSP Server] Logging in...`);
    await api.login();
    console.log(`[RTSP Server] Login successful`);

    // Create and start RTSP server
    const rtspServer = new BaichuanRtspServer({
      api,
      channel,
      profile,
      ...(variant !== "default" ? { variant } : {}),
      listenPort: port,
      path,
      logger: console,
    });

    console.log(`[RTSP Server] Starting RTSP server...`);
    await rtspServer.start();

    const rtspUrl = rtspServer.getRtspUrl();
    console.log(`[RTSP Server] RTSP server started`);
    console.log(`[RTSP Server] URL: ${rtspUrl}`);
    console.log(`[RTSP Server] Waiting for connections...`);
    console.log(`[RTSP Server] Press Ctrl+C to stop`);

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log(`\n[RTSP Server] Shutting down server...`);
      try {
        await rtspServer.stop();
        await api.close();
        console.log(`[RTSP Server] Server stopped`);
        process.exit(0);
      } catch (error) {
        console.error(`[RTSP Server] Error during shutdown:`, error);
        process.exit(1);
      }
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Wait for server to be ready
    try {
      await rtspServer.waitUntilReady(30000);
      console.log(`[RTSP Server] Server ready and camera active`);
    } catch (error) {
      console.warn(`[RTSP Server] Warning: ${error}`);
      console.log(
        `[RTSP Server] Server is still listening, but camera may not be ready yet`,
      );
    }
  } catch (error) {
    console.error(`[RTSP Server] Error:`, error);
    process.exit(1);
  }
}

// Execute only if called directly
// Supports both ESM and CommonJS
const isMainModule = (() => {
  // CommonJS check
  try {
    if (
      typeof require !== "undefined" &&
      typeof (require as any).main !== "undefined"
    ) {
      const mainModule = (require as any).main;
      // @ts-ignore - module may not exist in ESM
      if (typeof module !== "undefined" && mainModule === module) {
        return true;
      }
    }
  } catch {
    // module not defined in ESM, continue to ESM check
  }
  // ESM check - use Function constructor to avoid CJS bundler warnings about import.meta
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const getImportMeta = new Function(
      "return typeof import.meta !== 'undefined' ? import.meta : undefined",
    );
    const meta = getImportMeta() as { url?: string } | undefined;
    if (meta?.url) {
      const filePath = process.argv[1];
      if (filePath) {
        try {
          const url = new URL(meta.url);
          const urlPath = decodeURIComponent(url.pathname);
          // Normalize paths for comparison
          const normalizedUrlPath = urlPath.replace(/\/$/, "");
          const normalizedFilePath = filePath.replace(/\/$/, "");
          return (
            normalizedUrlPath === normalizedFilePath ||
            normalizedUrlPath.endsWith(normalizedFilePath) ||
            normalizedFilePath.endsWith(normalizedUrlPath)
          );
        } catch {
          // Fallback: check if import.meta.url contains the filename
          const filename =
            filePath.split("/").pop() || filePath.split("\\").pop();
          return filename ? meta.url.includes(filename) : false;
        }
      }
    }
  } catch {
    // import.meta not available (CJS environment)
  }
  return false;
})();

if (isMainModule) {
  main().catch((error) => {
    console.error(`[RTSP Server] Fatal error:`, error);
    process.exit(1);
  });
}
