#!/usr/bin/env node

// @ts-expect-error - Path resolution at runtime
import { createBaichuanEndpointsServer } from "../../index.js";
import { config } from "../env.js";

function die(msg: string): never {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

async function main() {
  if (!config.tcp.host) die("Missing TCP_HOST in .env");
  if (!config.tcp.password) die("Missing TCP_PASSWORD in .env");

  const listenPort = Number.parseInt((process.env.ENDPOINTS_PORT ?? "8099").trim(), 10);
  const listenHost = (process.env.ENDPOINTS_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const rtspListenHost = (process.env.ENDPOINTS_RTSP_HOST ?? "127.0.0.1").trim() || "127.0.0.1";

  if (!Number.isFinite(listenPort) || listenPort <= 0) die("Invalid ENDPOINTS_PORT");

  const server = createBaichuanEndpointsServer({
    listenPort,
    listenHost,
    rtspListenHost,
    baichuan: {
      host: config.tcp.host,
      username: config.tcp.username,
      password: config.tcp.password,
      transport: "tcp",
      debug: (process.env.DEBUG ?? "").trim() === "1",
    },
  });

  server.listen(listenPort, listenHost, () => {
    const base = `http://${listenHost}:${listenPort}`;
    console.log("\n=== BAICHUAN ENDPOINTS SERVER ===");
    console.log(`Listening: ${base}`);
    console.log("Endpoints:");
    console.log(`  GET ${base}/stream?channel=0&profile=main`);
    console.log(`  GET ${base}/recordings?mode=device&channel=0&today=1&count=50&timeoutMs=3000`);
    console.log(`  GET ${base}/recordings?mode=nvr&channel=1&today=1&count=50&timeoutMs=3000&source=baichuan`);
    console.log("  GET /download requires uid + fileName (from listRecordings)");
    console.log(`  GET ${base}/download?channel=0&uid=YOUR_UID&fileName=${encodeURIComponent("/mnt/sda/Mp4Record/2025/01/01/RecS01_20250101_000000_000100.mp4")}`);
    console.log("\nNOTE: /download currently depends on Baichuan cmdId=13 class=0x6482 working on your firmware.");
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
