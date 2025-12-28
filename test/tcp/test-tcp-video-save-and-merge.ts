#!/usr/bin/env node
/**
 * Test per salvare frame video Baichuan in locale e poi unirli in un video
 * 
 * 1. Salva i frame video in una cartella per 10-15 secondi
 * 2. Prova diversi approcci per unire i frame in un video usando ffmpeg
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, BaichuanVideoStream } from "../../index.js";
import { config } from "../env.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
// @ts-expect-error - Path resolution at runtime
import type { StreamProfile } from "../../index.js";

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

/**
 * Unisce frame video usando ffmpeg con diversi approcci
 */
async function mergeFramesWithFfmpeg(
  framesDir: string,
  outputFile: string,
  approach: "concat" | "pipe" | "image2" | "h264",
  fps: number = 10
): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`Unione frame con approccio: ${approach}`, { outputFile, fps });

    let ffmpegArgs: string[] = [];
    
    if (approach === "concat") {
      // Approccio 1: Concatena tutti i frame in un unico file e usa ffmpeg
      const frameFiles = fs.readdirSync(framesDir)
        .filter(f => f.startsWith("frame_") && f.endsWith(".h264"))
        .sort()
        .map(f => path.join(framesDir, f));
      
      // Concatena tutti i frame in un unico buffer
      const allFrames = Buffer.concat(
        frameFiles.map(f => fs.readFileSync(f))
      );
      
      // Salva file concatenato temporaneo
      const concatFile = path.join(framesDir, "all_frames.h264");
      fs.writeFileSync(concatFile, allFrames);
      
      ffmpegArgs = [
        "-f", "h264", // Input format H.264 raw
        "-i", concatFile,
        "-c:v", "libx264", // Re-encode per garantire compatibilità
        "-preset", "ultrafast",
        "-crf", "23",
        "-r", fps.toString(), // Frame rate
        "-y",
        outputFile,
      ];
    } else if (approach === "pipe") {
      // Approccio 2: Pipa tutti i frame concatenati a ffmpeg
      const frameFiles = fs.readdirSync(framesDir)
        .filter(f => f.startsWith("frame_") && f.endsWith(".h264"))
        .sort()
        .map(f => path.join(framesDir, f));
      
      const allFrames = Buffer.concat(
        frameFiles.map(f => fs.readFileSync(f))
      );
      
      const ffmpeg = spawn("ffmpeg", [
        "-f", "h264", // Input format H.264 raw
        "-i", "pipe:0",
        "-c:v", "libx264", // Re-encode per garantire compatibilità
        "-preset", "ultrafast",
        "-crf", "23",
        "-r", fps.toString(), // Frame rate
        "-y",
        outputFile,
      ], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      
      ffmpeg.stdin.write(allFrames);
      ffmpeg.stdin.end();
      
      let stderr = "";
      ffmpeg.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      
      ffmpeg.on("close", (code) => {
        if (code === 0) {
          logSuccess(`Video creato con approccio ${approach}: ${outputFile}`);
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
        }
      });
      
      ffmpeg.on("error", (error) => {
        reject(new Error(`ffmpeg spawn error: ${error.message}`));
      });
      
      return; // Early return per approccio pipe
    } else if (approach === "image2") {
      // Approccio 3: Tratta i frame come immagini (non applicabile per H.264 raw)
      reject(new Error("Approccio image2 non applicabile per frame H.264 raw"));
      return;
    } else if (approach === "h264") {
      // Approccio 4: Concatena frame e usa -f h264 con copy (no re-encoding)
      const frameFiles = fs.readdirSync(framesDir)
        .filter(f => f.startsWith("frame_") && f.endsWith(".h264"))
        .sort()
        .map(f => path.join(framesDir, f));
      
      // Concatena tutti i frame in un unico buffer
      const allFrames = Buffer.concat(
        frameFiles.map(f => fs.readFileSync(f))
      );
      
      // Salva file concatenato temporaneo
      const concatFile = path.join(framesDir, "all_frames.h264");
      fs.writeFileSync(concatFile, allFrames);
      
      ffmpegArgs = [
        "-f", "h264", // Input format H.264 raw
        "-i", concatFile,
        "-c:v", "copy", // Copy codec (no re-encoding) - più veloce
        "-fflags", "+genpts", // Generate PTS
        "-r", fps.toString(), // Frame rate
        "-y",
        outputFile,
      ];
    }

    const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logSuccess(`Video creato con approccio ${approach}: ${outputFile}`);
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

async function testSaveAndMerge() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST SALVATAGGIO E UNIONE FRAME VIDEO                 ║");
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
    uid: (config.tcp as any).uid,
    transport: "tcp",
    debug: false,
  });

  const channel = 0;
  const profile: StreamProfile = "sub";
  const saveDuration = 15; // 15 secondi
  const framesDir = path.join(process.cwd(), "test", "frames-save");
  const recordingsDir = path.join(process.cwd(), "test", "recordings");

  // Crea directory se non esistono
  if (!fs.existsSync(framesDir)) {
    fs.mkdirSync(framesDir, { recursive: true });
  }
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }

  // Pulisci directory frame precedenti
  const existingFrames = fs.readdirSync(framesDir);
  for (const file of existingFrames) {
    fs.unlinkSync(path.join(framesDir, file));
  }

  try {
    // Login
    log("Login Baichuan TCP");
    await api.login();
    logSuccess("Login completato");

    // Verifica profili disponibili
    log("Verifica profili disponibili");
    const streamMetadata = await api.getStreamMetadata(channel);
    logSuccess("Stream metadata ottenuta");
    
    if (streamMetadata && streamMetadata.streams) {
      const stream = streamMetadata.streams.find((s: { profile: string }) => s.profile === profile);
      if (stream) {
        log(`Profilo ${profile} trovato`, {
          width: stream.width,
          height: stream.height,
          fps: stream.frameRate,
        });
      }
    }

    // Crea BaichuanVideoStream
    log(`Creazione stream video per profilo ${profile}`);
    const videoStream = new BaichuanVideoStream({
      client: api.client,
      api,
      channel,
      profile,
    });

    // Salva frame video
    let frameCount = 0;
    let startTime = Date.now();
    const maxDuration = saveDuration * 1000; // Converti in millisecondi
    let totalBytes = 0;
    let lastFrameFile: string | null = null;

    videoStream.on("videoFrame", (frame: Buffer) => {
      const elapsed = Date.now() - startTime;
      if (elapsed >= maxDuration) {
        return; // Non salvare più frame dopo la durata massima
      }

      frameCount++;
      totalBytes += frame.length;
      const frameFile = path.join(framesDir, `frame_${frameCount.toString().padStart(5, "0")}.h264`);
      fs.writeFileSync(frameFile, frame);
      lastFrameFile = frameFile;

      if (frameCount % 10 === 0 || frameCount <= 5) {
        console.log(`[Save] Salvati ${frameCount} frame video (${(elapsed / 1000).toFixed(1)}s, ${(totalBytes / 1024).toFixed(1)} KB, avg: ${(totalBytes / frameCount / 1024).toFixed(2)} KB/frame)`);
      }
    });

    videoStream.on("error", (error: Error) => {
      logError(`Errore nello stream video`, error);
    });

    // Avvia stream video
    log(`Avvio stream video per profilo ${profile}`);
    await videoStream.start();
    logSuccess("Stream video avviato");

    // Attendi che arrivino frame e che passi la durata richiesta
    log(`Attendo ${saveDuration} secondi per salvare frame...`);
    await new Promise((resolve) => setTimeout(resolve, maxDuration + 1000)); // +1s di margine

    // Ferma stream video
    await videoStream.stop();
    logSuccess(`Stream video fermato. Salvati ${frameCount} frame totali`);

    // Verifica frame salvati
    const savedFrames = fs.readdirSync(framesDir)
      .filter(f => f.startsWith("frame_") && f.endsWith(".h264"))
      .sort();
    
    if (savedFrames.length === 0) {
      logError("Nessun frame salvato", new Error("No frames saved"));
      return;
    }

    log(`Frame salvati: ${savedFrames.length}`);
    
    // Calcola FPS approssimativo
    const actualDuration = (Date.now() - startTime) / 1000;
    let estimatedFps = savedFrames.length / actualDuration;
    
    // Se il FPS è troppo basso o 0, usa il valore dai metadati
    if (estimatedFps < 1 || isNaN(estimatedFps)) {
      if (streamMetadata && streamMetadata.streams) {
        const stream = streamMetadata.streams.find((s: { profile: string }) => s.profile === profile);
        if (stream && stream.frameRate) {
          estimatedFps = stream.frameRate;
          log(`FPS troppo basso (${estimatedFps.toFixed(2)}), uso FPS dai metadati: ${estimatedFps}`);
        } else {
          estimatedFps = 10; // Default fallback
          log(`FPS non disponibile, uso default: ${estimatedFps}`);
        }
      } else {
        estimatedFps = 10; // Default fallback
        log(`FPS non disponibile, uso default: ${estimatedFps}`);
      }
    }
    
    log(`FPS finale: ${estimatedFps.toFixed(2)}`);

    // Prova diversi approcci per unire i frame
    const approaches: Array<"concat" | "pipe" | "h264"> = ["concat", "pipe", "h264"];
    
    for (const approach of approaches) {
      try {
        const outputFile = path.join(recordingsDir, `merged_${profile}_${approach}_${Date.now()}.mp4`);
        log(`\n🎬 Provo approccio: ${approach}`);
        
        // Assicurati che il FPS sia almeno 1
        const fpsToUse = Math.max(1, Math.round(estimatedFps));
        await mergeFramesWithFfmpeg(framesDir, outputFile, approach, fpsToUse);
        
        // Verifica file creato
        if (fs.existsSync(outputFile)) {
          const stats = fs.statSync(outputFile);
          logSuccess(`Video creato: ${outputFile} (${stats.size} bytes)`);
          
          // Prova a verificare il video con ffprobe
          try {
            const ffprobe = spawn("ffprobe", [
              "-v", "error",
              "-show_format",
              "-show_streams",
              outputFile,
            ], {
              stdio: ["ignore", "pipe", "pipe"],
            });
            
            let probeOutput = "";
            ffprobe.stdout.on("data", (data) => {
              probeOutput += data.toString();
            });
            
            await new Promise<void>((resolve, reject) => {
              ffprobe.on("close", (code) => {
                if (code === 0) {
                  // Estrai informazioni chiave
                  const durationMatch = probeOutput.match(/duration=([\d.]+)/);
                  const widthMatch = probeOutput.match(/width=(\d+)/);
                  const heightMatch = probeOutput.match(/height=(\d+)/);
                  
                  if (durationMatch || widthMatch || heightMatch) {
                    log(`Info video`, {
                      duration: durationMatch ? `${durationMatch[1]}s` : "unknown",
                      resolution: widthMatch && heightMatch ? `${widthMatch[1]}x${heightMatch[1]}` : "unknown",
                    });
                  }
                  resolve();
                } else {
                  reject(new Error(`ffprobe exited with code ${code}`));
                }
              });
            });
          } catch (error) {
            console.warn(`⚠️  Impossibile analizzare video: ${error}`);
          }
        }
      } catch (error) {
        logError(`Errore con approccio ${approach}`, error);
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

testSaveAndMerge().catch((error) => {
  console.error("Errore fatale:", error);
  process.exit(1);
});

