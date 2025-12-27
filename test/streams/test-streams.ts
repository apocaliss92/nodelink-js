#!/usr/bin/env node
/**
 * Suite di test per streaming RTSP
 * Testa: main stream e sub stream su TCP e UDP
 */

import { createRtspProxyServer } from "../../dist/index.js";
import { spawn } from "node:child_process";
import { config } from "../env.js";

// Funzioni helper
function log(message: string, data?: unknown) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📹 ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
  console.log("=".repeat(60));
}

function logSuccess(message: string) {
  console.log(`\n✅ ${message}`);
}

function logError(message: string, error: unknown) {
  console.error(`\n❌ ERRORE: ${message}`);
  if (error instanceof Error) {
    console.error(`   Messaggio: ${error.message}`);
  } else {
    console.error(`   Dettagli: ${error}`);
  }
}

async function testStream(host: string, username: string, password: string, transport: "tcp" | "udp", profile: "main" | "sub", channel: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createRtspProxyServer({
      listenPort: config.rtsp.proxyPort,
      host,
      username,
      password,
      rtspTransport: transport,
    });

    server.on("error", (err) => {
      logError(`Errore server RTSP (${transport}/${profile})`, err);
      resolve(false);
    });

    server.listen(config.rtsp.proxyPort, () => {
      const streamUrl = `http://localhost:${config.rtsp.proxyPort}/stream?channel=${channel}&profile=${profile}`;
      const outputFile = `test-${transport}-${profile}-${Date.now()}.mp4`;

      console.log(`\n  📺 Testando ${transport.toUpperCase()} ${profile} stream...`);
      console.log(`  URL: ${streamUrl}`);

      const ffmpeg = spawn("ffmpeg", [
        "-i",
        streamUrl,
        "-t",
        String(config.rtsp.recordDuration),
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-y",
        outputFile,
      ]);

      let ffmpegError = "";

      ffmpeg.stderr.on("data", (data) => {
        ffmpegError += data.toString();
      });

      ffmpeg.on("close", (code) => {
        server.close(() => {
          if (code === 0) {
            logSuccess(`${transport.toUpperCase()} ${profile} stream: registrazione completata (${outputFile})`);
            resolve(true);
          } else {
            logError(`${transport.toUpperCase()} ${profile} stream: errore registrazione`, ffmpegError);
            resolve(false);
          }
        });
      });

      ffmpeg.on("error", (err) => {
        logError(`${transport.toUpperCase()} ${profile} stream: errore ffmpeg`, err);
        server.close(() => resolve(false));
      });
    });
  });
}

async function runStreamTests() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║         TEST SUITE STREAMS - REOLINK RTSP                ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfigurazione:`);
  console.log(`  TCP Host: ${config.tcp.host}`);
  console.log(`  UDP Host: ${config.udp.host}`);
  console.log(`  Proxy Port: ${config.rtsp.proxyPort}`);
  console.log(`  Record Duration: ${config.rtsp.recordDuration} secondi\n`);

  const results: Record<string, boolean> = {};

  // Test TCP streams
  if (config.tcp.host && config.tcp.password) {
    log("TEST STREAMS TCP");
    
    results["tcp-main"] = await testStream(
      config.tcp.host,
      config.tcp.username,
      config.tcp.password,
      "tcp",
      "main",
      0
    );

    // Piccola pausa tra i test
    await new Promise((resolve) => setTimeout(resolve, 2000));

    results["tcp-sub"] = await testStream(
      config.tcp.host,
      config.tcp.username,
      config.tcp.password,
      "tcp",
      "sub",
      0
    );
  } else {
    console.log("⚠️  Configurazione TCP non completa, salto test TCP streams");
  }

  // Test UDP streams (se disponibile)
  if (config.udp.host && config.udp.password) {
    log("TEST STREAMS UDP");
    
    // Piccola pausa tra i test
    await new Promise((resolve) => setTimeout(resolve, 2000));

    results["udp-main"] = await testStream(
      config.udp.host,
      config.udp.username,
      config.udp.password,
      "udp",
      "main",
      0
    );

    // Piccola pausa tra i test
    await new Promise((resolve) => setTimeout(resolve, 2000));

    results["udp-sub"] = await testStream(
      config.udp.host,
      config.udp.username,
      config.udp.password,
      "udp",
      "sub",
      0
    );
  } else {
    console.log("⚠️  Configurazione UDP non completa, salto test UDP streams");
  }

  // Riepilogo
  console.log("\n\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║                  RIEPILOGO TEST STREAMS                    ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  for (const [key, success] of Object.entries(results)) {
    const name = key.replace("-", " ").toUpperCase();
    console.log(`${name.padEnd(30)}: ${success ? "✅ SUCCESSO" : "❌ FALLITO"}`);
  }
  const successCount = Object.values(results).filter((r) => r).length;
  console.log(`\nTest completati con successo: ${successCount}/${Object.keys(results).length}\n`);

  return successCount === Object.keys(results).length;
}

// Esegui i test
runStreamTests()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    logError("Errore fatale", error);
    process.exit(1);
  });

