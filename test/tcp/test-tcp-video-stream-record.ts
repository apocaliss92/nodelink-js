#!/usr/bin/env node
/**
 * Test end-to-end per streaming video Baichuan
 * Registra 5 secondi di video per ogni profilo disponibile (main, sub, ext)
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, BaichuanVideoStream } from "../../index.js";
import { config } from "../env.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

// Funzioni helper
function log(message: string, data?: unknown) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📊 ${message}`);
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
      console.error(`   Stack: ${error.stack.split("\n").slice(0, 5).join("\n")}`);
    }
  } else {
    console.error(`   Dettagli: ${error}`);
  }
}

async function recordVideoFromRtsp(rtspUrl: string, outputFile: string, duration: number): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`Registrazione video da RTSP`, { rtspUrl, outputFile, duration });
    
    // ffmpeg -i rtsp://... -t 5 -c copy output.mp4
    const ffmpeg = spawn("ffmpeg", [
      "-i", rtspUrl,
      "-t", duration.toString(),
      "-c", "copy", // Copy codec (no re-encoding)
      "-y", // Overwrite output file
      outputFile,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    ffmpeg.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logSuccess(`Registrazione completata: ${outputFile}`);
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
      }
    });

    ffmpeg.on("error", (error) => {
      reject(new Error(`ffmpeg spawn error: ${error.message}`));
    });
  });
}

async function testVideoStreamRecording() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST REGISTRAZIONE VIDEO STREAM BAICHUAN             ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfigurazione:`);
  console.log(`  Host: ${config.tcp.host}`);
  console.log(`  Username: ${config.tcp.username}\n`);

  if (!config.tcp.host || !config.tcp.password) {
    console.error("❌ ERRORE: Configurazione TCP non completa nel file .env");
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
  const recordingsDir = path.join(process.cwd(), "test", "recordings");
  const duration = 5; // 5 secondi

  // Crea directory se non esiste
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }

  // Profili da testare
  const profiles: Array<"main" | "sub" | "ext"> = ["sub", "main", "ext"];

  try {
    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completato");

    // Verifica profili disponibili
    log("Verifica profili disponibili");
    const streamMetadata = await api.getStreamMetadata(channel);
    logSuccess("Stream metadata ottenuta");
    log("Stream metadata", streamMetadata);
    
    const availableProfiles: Array<"main" | "sub" | "ext"> = [];
    // streamMetadata potrebbe essere un array di stream o un oggetto
    if (Array.isArray(streamMetadata)) {
      // Se è un array, ogni elemento ha un profile
      for (const stream of streamMetadata) {
        if (stream.profile === "main" || stream.profile === "sub" || stream.profile === "ext") {
          if (!availableProfiles.includes(stream.profile)) {
            availableProfiles.push(stream.profile);
          }
        }
      }
    } else if (streamMetadata && typeof streamMetadata === "object") {
      // Se è un oggetto, controlla le proprietà
      if ("main" in streamMetadata && streamMetadata.main) availableProfiles.push("main");
      if ("sub" in streamMetadata && streamMetadata.sub) availableProfiles.push("sub");
      if ("ext" in streamMetadata && streamMetadata.ext) availableProfiles.push("ext");
      // Potrebbe anche essere un array di stream nella proprietà "streams"
      if ("streams" in streamMetadata && Array.isArray(streamMetadata.streams)) {
        for (const stream of streamMetadata.streams) {
          if (stream.profile === "main" || stream.profile === "sub" || stream.profile === "ext") {
            if (!availableProfiles.includes(stream.profile)) {
              availableProfiles.push(stream.profile);
            }
          }
        }
      }
    }
    
    log(`Profili disponibili: ${availableProfiles.length > 0 ? availableProfiles.join(", ") : "nessuno (procedo comunque con test)"}`);
    
    // Se nessun profilo è disponibile, prova comunque con "sub" come default
    if (availableProfiles.length === 0) {
      log("Nessun profilo trovato nei metadati, procedo con test usando 'sub' come default");
      availableProfiles.push("sub");
    }

    // Testa ogni profilo disponibile
    for (const profile of profiles) {
      if (!availableProfiles.includes(profile)) {
        log(`Profilo ${profile} non disponibile, skip`);
        continue;
      }

      log(`\n🎥 Test profilo: ${profile}`);
      
      let videoStream: BaichuanVideoStream | undefined;

      try {
        // Crea BaichuanVideoStream
        videoStream = new BaichuanVideoStream({
          client: api.client,
          api,
          channel,
          profile,
        });

        // Conta frame ricevuti
        let videoFrameCount = 0;
        let audioFrameCount = 0;

        videoStream.on("videoFrame", (frame: Buffer) => {
          videoFrameCount++;
          if (videoFrameCount === 1) {
            logSuccess(`Primo frame video ricevuto (${frame.length} bytes)`);
          }
        });

        videoStream.on("audioFrame", (frame: Buffer) => {
          audioFrameCount++;
          if (audioFrameCount === 1) {
            logSuccess(`Primo frame audio ricevuto (${frame.length} bytes)`);
          }
        });

        videoStream.on("error", (error: Error) => {
          logError(`Errore nello stream video`, error);
        });

        // Avvia stream video direttamente (senza RTSP server per ora)
        log(`Avvio stream video per profilo ${profile}`);
        await videoStream.start();
        logSuccess(`Stream video avviato per profilo ${profile}`);
        
        // Attendi che arrivino alcuni frame video
        log(`Attendo frame video...`);
        let frameReceived = false;
        let totalFrames = 0;
        const frameTimeout = setTimeout(() => {
          if (!frameReceived) {
            logError("Nessun frame video ricevuto dopo 5 secondi", new Error("Timeout"));
          }
        }, 5000);
        
        const waitForFramesHandler = () => {
          if (!frameReceived) {
            frameReceived = true;
            clearTimeout(frameTimeout);
            logSuccess("Primo frame video ricevuto!");
          }
          totalFrames++;
        };
        videoStream.on("videoFrame", waitForFramesHandler);
        
        // Attendi almeno 5 secondi per raccogliere frame (i frame potrebbero essere frammentati)
        await new Promise((resolve) => setTimeout(resolve, 5000));
        
        // Rimuovi handler temporaneo
        videoStream.removeListener("videoFrame", waitForFramesHandler);
        
        if (!frameReceived) {
          logError("Nessun frame video ricevuto dopo 5 secondi", new Error("No video frames"));
          continue;
        }
        
        logSuccess(`Ricevuti ${totalFrames} frame video, procedo con registrazione diretta`);
        
        // Registra direttamente da BaichuanVideoStream usando ffmpeg
        const outputFile = path.join(recordingsDir, `recording_${profile}_${Date.now()}.mp4`);
        log(`Registrazione 5 secondi di video per profilo ${profile} (registrazione diretta)`);
        
        // Avvia ffmpeg per registrare direttamente da stdin
        const ffmpegRecord = spawn("ffmpeg", [
          "-hide_banner",
          "-loglevel", "warning",
          "-fflags", "+genpts",
          "-f", "h264",
          "-i", "pipe:0",
          "-t", duration.toString(),
          "-c:v", "copy",
          "-y",
          outputFile,
        ], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        
        let ffmpegError = "";
        ffmpegRecord.stderr.on("data", (data: Buffer) => {
          const output = data.toString();
          ffmpegError += output;
          if (output.includes("error") || output.includes("Error")) {
            console.error(`[FFmpeg Record] ${output.trim()}`);
          }
        });
        
        // Invia frame video a ffmpeg
        let framesSent = 0;
        const ffmpegFrameHandler = (videoData: Buffer) => {
          if (ffmpegRecord.stdin && !ffmpegRecord.stdin.destroyed) {
            try {
              ffmpegRecord.stdin.write(videoData);
              framesSent++;
            } catch (error) {
              console.error(`[FFmpeg Record] Errore scrittura: ${error}`);
            }
          }
        };
        
        videoStream.on("videoFrame", ffmpegFrameHandler);
        
        // Attendi la durata della registrazione
        await new Promise((resolve) => setTimeout(resolve, duration * 1000 + 1000));
        
        // Chiudi stdin e attendi che ffmpeg finisca
        if (ffmpegRecord.stdin && !ffmpegRecord.stdin.destroyed) {
          ffmpegRecord.stdin.end();
        }
        
        await new Promise<void>((resolve, reject) => {
          ffmpegRecord.on("close", (code) => {
            if (code === 0) {
              logSuccess(`Registrazione completata: ${outputFile} (${framesSent} frame inviati)`);
              resolve();
            } else {
              reject(new Error(`FFmpeg exited with code ${code}\n${ffmpegError}`));
            }
          });
        });
        
        // Rimuovi handler temporaneo
        videoStream.removeListener("videoFrame", ffmpegFrameHandler);
        
        // Verifica che il file sia stato creato
        if (fs.existsSync(outputFile)) {
          const stats = fs.statSync(outputFile);
          logSuccess(`File registrato: ${outputFile} (${stats.size} bytes)`);
          logSuccess(`Frame video ricevuti: ${videoFrameCount}`);
          logSuccess(`Frame audio ricevuti: ${audioFrameCount}`);
        } else {
          logError(`File non creato: ${outputFile}`, new Error("File not found"));
        }

      } catch (error) {
        logError(`Errore durante test profilo ${profile}`, error);
      } finally {
        // Cleanup
        if (videoStream) {
          try {
            await videoStream.stop();
            logSuccess(`Stream video fermato per profilo ${profile}`);
          } catch (error) {
            logError(`Errore durante stop stream per profilo ${profile}`, error);
          }
        }
        

        // Attendi un po' prima del prossimo profilo
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    logSuccess("✅ Tutti i test completati!");

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

testVideoStreamRecording().catch((error) => {
  console.error("Errore fatale:", error);
  process.exit(1);
});

