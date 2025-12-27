#!/usr/bin/env node
/**
 * Test TCP: Lista stream disponibili e registra 5 secondi da ognuno
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, buildRtspUrl } from "../../index.js";
import { config } from "../env.js";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
    if (error.stack) {
      console.error(`   Stack: ${error.stack.split("\n").slice(0, 3).join("\n")}`);
    }
  } else {
    console.error(`   Dettagli: ${error}`);
  }
}

/**
 * Registra uno stream RTSP per 5 secondi usando ffmpeg
 */
async function recordStream(
  rtspUrl: string,
  outputFile: string,
  duration: number = 5
): Promise<boolean> {
  return new Promise((resolve) => {
    log(`Registrazione stream: ${rtspUrl}`);
    log(`File output: ${outputFile}`);
    log(`Durata: ${duration} secondi`);

    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-rtsp_transport",
      "tcp",
      "-i",
      rtspUrl,
      "-t",
      String(duration),
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-y",
      outputFile,
    ]);

    let ffmpegError = "";

    ffmpeg.stderr.on("data", (data) => {
      const output = data.toString();
      ffmpegError += output;
      // Mostra progresso se disponibile
      if (output.includes("time=")) {
        process.stdout.write(`\r   ${output.trim()}`);
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logSuccess(`Registrazione completata: ${outputFile}`);
        resolve(true);
      } else {
        logError(`Errore durante registrazione`, ffmpegError);
        resolve(false);
      }
    });

    ffmpeg.on("error", (err) => {
      logError(`Errore ffmpeg`, err);
      resolve(false);
    });
  });
}

async function runStreamRecordTest() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST STREAM DISPONIBILI E REGISTRAZIONE (TCP)         ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfigurazione:`);
  console.log(`  Host: ${config.tcp.host}`);
  console.log(`  Username: ${config.tcp.username}\n`);

  if (!config.tcp.host || !config.tcp.password) {
    console.error("❌ ERRORE: Configurazione TCP non completa nel file .env");
    console.error("   Assicurati di aver impostato TCP_HOST e TCP_PASSWORD");
    process.exit(1);
  }

  const api = new ReolinkBaichuanApi({
    host: config.tcp.host,
    username: config.tcp.username,
    password: config.tcp.password,
    transport: "tcp",
    debug: false,
  });

  const channel = 0;
  const recordDuration = 5; // secondi
  const outputDir = join(process.cwd(), "test", "recordings");

  try {
    // Crea directory per le registrazioni
    try {
      mkdirSync(outputDir, { recursive: true });
    } catch (error) {
      // Directory già esistente, ok
    }

    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completato");

    // Ottieni metadati degli stream
    log(`Ottengo metadati stream per channel ${channel}`);
    const metadata = await api.getStreamMetadata(channel);
    logSuccess(`Stream disponibili: ${metadata.streams.length}`);

    // Mostra informazioni su ogni stream
    for (const stream of metadata.streams) {
      log(`Stream ${stream.profile.toUpperCase()}`, {
        profile: stream.profile,
        resolution: `${stream.width}x${stream.height}`,
        fps: stream.frameRate,
        codec: stream.videoEncType,
        bitrate: `${stream.bitRate} kbps`,
        audio: stream.audio === 1 ? "Sì" : "No",
      });
    }

    // Registra ogni stream disponibile
    const results: Record<string, boolean> = {};

    for (const stream of metadata.streams) {
      const rtspUrl = buildRtspUrl({
        host: config.tcp.host,
        username: config.tcp.username,
        password: config.tcp.password,
        channel,
        stream: stream.profile,
      });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outputFile = join(outputDir, `tcp-${stream.profile}-${timestamp}.mp4`);

      log(`\n📹 Registrazione stream ${stream.profile.toUpperCase()}`);
      const success = await recordStream(rtspUrl, outputFile, recordDuration);
      results[stream.profile] = success;

      // Attendi un po' tra le registrazioni
      if (metadata.streams.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // Riepilogo
    console.log("\n");
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    RIEPILOGO REGISTRAZIONI                 ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log("\n");

    const passed = Object.values(results).filter((r) => r).length;
    const total = Object.keys(results).length;

    for (const [streamProfile, result] of Object.entries(results)) {
      const icon = result ? "✅" : "❌";
      console.log(`${icon} Stream ${streamProfile.toUpperCase()}: ${result ? "SUCCESS" : "FAIL"}`);
    }

    console.log(`\n📊 Risultati: ${passed}/${total} stream registrati con successo`);
    console.log(`📁 File salvati in: ${outputDir}\n`);

    if (passed === total) {
      console.log("🎉 Tutte le registrazioni completate con successo!");
    } else {
      console.log(`⚠️  ${total - passed} registrazioni fallite`);
    }
  } catch (error) {
    logError("Errore critico durante i test", error);
    process.exit(1);
  } finally {
    try {
      await api.close();
      logSuccess("Connessione chiusa");
    } catch (error) {
      logError("Errore durante chiusura connessione", error);
    }
  }
}

// Esegui i test
runStreamRecordTest().catch((error) => {
  console.error("Errore fatale:", error);
  process.exit(1);
});

