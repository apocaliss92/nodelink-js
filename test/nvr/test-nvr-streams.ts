#!/usr/bin/env node
/**
 * Suite di test per streaming RTSP da NVR
 * Testa: main stream e sub stream per ogni canale disponibile
 */

import { createRtspProxyServer } from "../../dist/index.js";
import { ReolinkNvrHybridApi } from "../../dist/index.js";
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

async function testNvrStream(
  host: string,
  username: string,
  password: string,
  transport: "tcp" | "udp",
  profile: "main" | "sub",
  channel: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createRtspProxyServer({
      listenPort: config.rtsp.proxyPort,
      host,
      username,
      password,
      rtspTransport: transport,
    });

    server.on("error", (err) => {
      logError(`Errore server RTSP (${transport}/${profile}/ch${channel})`, err);
      resolve(false);
    });

    server.listen(config.rtsp.proxyPort, () => {
      const streamUrl = `http://localhost:${config.rtsp.proxyPort}/stream?channel=${channel}&profile=${profile}`;
      const outputFile = `test-nvr-${transport}-ch${channel}-${profile}-${Date.now()}.mp4`;

      console.log(`\n  📺 Testando ${transport.toUpperCase()} canale ${channel} ${profile} stream...`);
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
            logSuccess(`${transport.toUpperCase()} ch${channel} ${profile}: registrazione completata (${outputFile})`);
            resolve(true);
          } else {
            logError(`${transport.toUpperCase()} ch${channel} ${profile}: errore registrazione`, ffmpegError);
            resolve(false);
          }
        });
      });

      ffmpeg.on("error", (err) => {
        logError(`${transport.toUpperCase()} ch${channel} ${profile}: errore ffmpeg`, err);
        server.close(() => resolve(false));
      });
    });
  });
}

async function runNvrStreamTests() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║         TEST SUITE NVR STREAMS - REOLINK RTSP             ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfigurazione:`);
  console.log(`  NVR Host: ${config.nvr.host}`);
  console.log(`  Proxy Port: ${config.rtsp.proxyPort}`);
  console.log(`  Record Duration: ${config.rtsp.recordDuration} secondi\n`);

  // Prima otteniamo la lista dei canali
  const api = new ReolinkNvrHybridApi({
    cgi: {
      host: config.nvr.host,
      username: config.nvr.username,
      password: config.nvr.password,
      useHttps: false,
    },
  });

  let channels: number[] = [];

  try {
    await api.login();
    channels = await api.listChannels();
    await api.close();

    if (channels.length === 0) {
      console.log("⚠️  Nessun canale trovato - NVR potrebbe non avere videocamere collegate");
      return false;
    }

    console.log(`📺 Trovati ${channels.length} canali: ${channels.join(", ")}\n`);
  } catch (error) {
    logError("Errore durante recupero canali", error);
    return false;
  }

  const results: Record<string, boolean> = {};

  // Test TCP streams per ogni canale
  log("TEST STREAMS TCP");
  for (const channel of channels) {
    // Piccola pausa tra i test
    await new Promise((resolve) => setTimeout(resolve, 2000));

    results[`tcp-ch${channel}-main`] = await testNvrStream(
      config.nvr.host,
      config.nvr.username,
      config.nvr.password,
      "tcp",
      "main",
      channel
    );

    // Piccola pausa tra i test
    await new Promise((resolve) => setTimeout(resolve, 2000));

    results[`tcp-ch${channel}-sub`] = await testNvrStream(
      config.nvr.host,
      config.nvr.username,
      config.nvr.password,
      "tcp",
      "sub",
      channel
    );
  }

  // Test UDP streams (se disponibile)
  if (config.nvr.uid) {
    log("TEST STREAMS UDP");
    for (const channel of channels) {
      // Piccola pausa tra i test
      await new Promise((resolve) => setTimeout(resolve, 2000));

      results[`udp-ch${channel}-main`] = await testNvrStream(
        config.nvr.host,
        config.nvr.username,
        config.nvr.password,
        "udp",
        "main",
        channel
      );

      // Piccola pausa tra i test
      await new Promise((resolve) => setTimeout(resolve, 2000));

      results[`udp-ch${channel}-sub`] = await testNvrStream(
        config.nvr.host,
        config.nvr.username,
        config.nvr.password,
        "udp",
        "sub",
        channel
      );
    }
  }

  // Riepilogo
  console.log("\n\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║                RIEPILOGO TEST NVR STREAMS                 ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  for (const [key, success] of Object.entries(results)) {
    const name = key.replace(/-/g, " ").toUpperCase();
    console.log(`${name.padEnd(35)}: ${success ? "✅ SUCCESSO" : "❌ FALLITO"}`);
  }
  const successCount = Object.values(results).filter((r) => r).length;
  console.log(`\nTest completati con successo: ${successCount}/${Object.keys(results).length}\n`);

  return successCount === Object.keys(results).length;
}

// Esegui i test
runNvrStreamTests()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    logError("Errore fatale", error);
    process.exit(1);
  });

