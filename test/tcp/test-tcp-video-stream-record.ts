#!/usr/bin/env node
/**
 * Baichuan end-to-end video streaming test.
 * Records a short MP4 clip for each available profile (main, sub, ext).
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi, BaichuanVideoStream, BaichuanHttpStreamServer } from "../../index.js";
import { config } from "../env.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

// Helper functions
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
  console.error(`\n❌ ERROR: ${message}`);
  if (error instanceof Error) {
    console.error(`   Message: ${error.message}`);
    if (error.stack) {
      console.error(`   Stack: ${error.stack.split("\n").slice(0, 5).join("\n")}`);
    }
  } else {
    console.error(`   Details: ${error}`);
  }
}

async function recordVideoFromUrl(inputUrl: string, outputFile: string, duration: number): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`Recording video`, { inputUrl, outputFile, duration });
    
    const u = new URL(inputUrl);
    const inputArgs: string[] = [];
    // Only for RTSP it makes sense to force rtsp_transport.
    if (u.protocol === "rtsp:") {
      inputArgs.push("-rtsp_transport", "tcp");
    }

    // ffmpeg -i <url> -t 5 -c copy output.mp4
    // Note: ffmpeg can be "quiet" and not print frame=; we also track the output file growth.
    const ffmpeg = spawn("ffmpeg", [
      ...inputArgs,
      "-hide_banner",
      "-loglevel", "warning",
      "-stats",
      "-i", inputUrl,
      "-t", duration.toString(),
      "-c", "copy", // Copy codec (no re-encoding)
      "-y", // Overwrite output file
      outputFile,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let stderr = "";
    let hasStarted = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let startedPoll: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      if (killTimer) clearTimeout(killTimer);
      killTimer = undefined;
      if (startedPoll) clearInterval(startedPoll);
      startedPoll = undefined;
      // Avoid listener leaks (helps the process exit cleanly).
      ffmpeg.removeAllListeners();
      ffmpeg.stderr?.removeAllListeners();
      ffmpeg.stdout?.removeAllListeners();
    };

    const killFfmpeg = () => {
      try {
        ffmpeg.kill("SIGTERM");
      } catch {
        // ignore
      }
      // If it doesn't exit, force SIGKILL (otherwise Node may hang).
      killTimer = setTimeout(() => {
        try {
          ffmpeg.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 1500);
      // Don't keep the process alive.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      (killTimer as any)?.unref?.();
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      killFfmpeg();
      cleanup();
      reject(err);
    };

    const ok = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    
    ffmpeg.stderr.on("data", (data: Buffer) => {
      const output = data.toString();
      stderr += output;
      
      // Log quando ffmpeg inizia a ricevere dati
      if (!hasStarted && (output.includes("Stream") || output.includes("frame="))) {
        hasStarted = true;
          console.log(`[FFmpeg Record] Stream started`);
      }
      
      // Log errori critici (non warning di decodifica)
      if (output.includes("error") && !output.includes("top block unavailable") && !output.includes("error while decoding MB")) {
        console.error(`[FFmpeg Record] ${output.trim()}`);
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logSuccess(`Recording completed: ${outputFile}`);
        ok();
      } else {
        // Code 1 può essere normale se lo stream termina prima del timeout
        if (code === 1 && hasStarted) {
          logSuccess(`Recording completed (exit code ${code}): ${outputFile}`);
          ok();
        } else {
          fail(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
        }
      }
    });

    ffmpeg.on("error", (error) => {
      fail(new Error(`ffmpeg spawn error: ${error.message}`));
    });
    
    // Mark started anche se ffmpeg non stampa “frame=” (controlla crescita file)
    const markStartedIfOutputGrows = () => {
      if (hasStarted) return;
      try {
        if (fs.existsSync(outputFile)) {
          const s = fs.statSync(outputFile);
          if (s.size > 0) {
            hasStarted = true;
            console.log(`[FFmpeg Record] Output file iniziato (size=${s.size} bytes)`);
          }
        }
      } catch {
        // ignore
      }
    };
    startedPoll = setInterval(markStartedIfOutputGrows, 400);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    (startedPoll as any)?.unref?.();

    // Timeout di sicurezza “soft”: fallisce solo se non parte davvero (né log né file).
    timeout = setTimeout(() => {
      markStartedIfOutputGrows();
      if (!hasStarted) {
        fail(new Error(`Timeout: ffmpeg non ha iniziato a produrre output dopo 10 secondi`));
      }
    }, 10000);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    (timeout as any)?.unref?.();
  });
}

async function recordVideoFromStream(
  videoStream: BaichuanVideoStream,
  outputFile: string,
  durationSeconds: number,
  inputFps: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`Recording video (direct pipe)`, { outputFile, durationSeconds, inputFps });

    const rawH264File = outputFile.replace(/\.mp4$/i, ".h264");
    const rawOut = fs.createWriteStream(rawH264File);

    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel", "warning",
        "-fflags", "+genpts",
        "-r", String(inputFps),
        "-f", "h264",
        "-i", "pipe:0",
        // NB: la durata la controlliamo lato JS (dopo il primo keyframe).
        "-an",
        "-c:v", "copy",
        "-movflags", "+faststart",
        "-y",
        outputFile,
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    let settled = false;
    let stderr = "";
    let written = 0;
    const kill = () => {
      try { ffmpeg.kill("SIGTERM"); } catch {}
      const t = setTimeout(() => { try { ffmpeg.kill("SIGKILL"); } catch {} }, 1500);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      (t as any)?.unref?.();
    };
    const doneOk = () => {
      if (settled) return;
      settled = true;
      if (stopTimer) clearTimeout(stopTimer);
      if (safetyTimer) clearTimeout(safetyTimer);
      try { ffmpeg.stdin?.end(); } catch {}
      try { rawOut.end(); } catch {}
      resolve();
    };
    const doneErr = (e: Error) => {
      if (settled) return;
      settled = true;
      if (stopTimer) clearTimeout(stopTimer);
      if (safetyTimer) clearTimeout(safetyTimer);
      try { ffmpeg.stdin?.end(); } catch {}
      try { rawOut.end(); } catch {}
      kill();
      reject(e);
    };

    ffmpeg.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    ffmpeg.on("error", (e) => doneErr(new Error(`ffmpeg spawn error: ${e.message}`)));
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logSuccess(`Recording completed: ${outputFile}`);
        return doneOk();
      }
      doneErr(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
    });

    const onVideo = (data: Buffer) => {
      if (!ffmpeg.stdin || ffmpeg.stdin.destroyed) return;
      try {
        ffmpeg.stdin.write(data);
        rawOut.write(data);
        written++;
      } catch {
        // ignore
      }
    };

    // Per debug/compat: possiamo registrare solo keyframe (intra-only) per ottenere un MP4 visibile
    // anche quando i P-frame sono ancora corrotti.
    const keyframesOnly = process.env.BAICHUAN_RECORD_KEYFRAMES_ONLY === "1";
    // Default ON: evita secondi iniziali "neri" partendo dal primo IDR.
    const waitForKeyframe = process.env.BAICHUAN_WAIT_FOR_KEYFRAME !== "0";
    let started = !waitForKeyframe; // diventa true quando arriva il primo keyframe
    let stopTimer: NodeJS.Timeout | undefined;
    let safetyTimer: NodeJS.Timeout | undefined;
    const onAccessUnit = (unit: any) => {
      if (!unit || !Buffer.isBuffer(unit.data)) return;
      if (waitForKeyframe && !started) {
        if (!unit.isKeyframe) return;
        started = true;
        console.log(`[FFmpeg Record] ✅ First keyframe received, starting recording (${durationSeconds}s)`);
        stopTimer = setTimeout(() => {
          videoStream.removeListener("videoAccessUnit" as any, onAccessUnit as any);
          if (useVideoFrameFallback) videoStream.removeListener("videoFrame", onVideo);
          try { ffmpeg.stdin?.end(); } catch {}
          try { rawOut.end(); } catch {}
          console.log(`[FFmpeg Record] Frames sent via pipe: ${written}`);
        }, durationSeconds * 1000);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        (stopTimer as any)?.unref?.();
      }
      if (keyframesOnly && !unit.isKeyframe) return;
      onVideo(unit.data);
    };

    if (keyframesOnly) {
      console.log(`[FFmpeg Record] Keyframes-only mode enabled (BAICHUAN_RECORD_KEYFRAMES_ONLY=1)`);
    }
    if (waitForKeyframe) {
      console.log(`[FFmpeg Record] Waiting for the first keyframe before writing to ffmpeg (BAICHUAN_WAIT_FOR_KEYFRAME=1)`);
    }

    videoStream.on("videoAccessUnit" as any, onAccessUnit as any);
    // Fallback: evita doppie scritture (videoFrame + videoAccessUnit). Abilita solo se serve.
    const useVideoFrameFallback = process.env.BAICHUAN_USE_VIDEOFRAME_FALLBACK === "1";
    if (useVideoFrameFallback) {
      videoStream.on("videoFrame", onVideo);
    }

    // Se non aspettiamo il keyframe, parte subito il timer di stop.
    if (!waitForKeyframe) {
      stopTimer = setTimeout(() => {
        videoStream.removeListener("videoAccessUnit" as any, onAccessUnit as any);
        if (useVideoFrameFallback) videoStream.removeListener("videoFrame", onVideo);
        try { ffmpeg.stdin?.end(); } catch {}
        try { rawOut.end(); } catch {}
        console.log(`[FFmpeg Record] Frames sent via pipe: ${written}`);
      }, durationSeconds * 1000);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      (stopTimer as any)?.unref?.();
    }

    // Safety: se il keyframe non arriva, chiudiamo comunque (il caller ha già un race-timeout).
    safetyTimer = setTimeout(() => {
      if (settled) return;
      if (!started) {
        doneErr(new Error(`Timeout: no keyframe within 12s (BAICHUAN_WAIT_FOR_KEYFRAME=1)`));
      }
    }, 12_000);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    (safetyTimer as any)?.unref?.();
  });
}

async function testVideoStreamRecording() {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     BAICHUAN VIDEO STREAM RECORDING TEST                 ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfiguration:`);
  console.log(`  Host: ${config.tcp.host}`);
  console.log(`  Username: ${config.tcp.username}\n`);

  if (!config.tcp.host || !config.tcp.password) {
    console.error("❌ ERROR: Incomplete TCP configuration in .env");
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
  const duration = Number(process.env.BAICHUAN_RECORD_SECONDS ?? "10"); // default 10 seconds
  if (process.env.BAICHUAN_RECORD_SECONDS && Number.isFinite(duration) && duration > 0 && duration < 10) {
    console.warn(
      `[Test] Warning: BAICHUAN_RECORD_SECONDS is set to ${duration}. ` +
      `If you expect ~10s recordings, run with BAICHUAN_RECORD_SECONDS=10 (or unset it).`
    );
  }

  // Crea directory se non esiste
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }

  const parseProfilesEnv = (v: string | undefined): Array<"main" | "sub" | "ext"> | null => {
    if (!v) return null;
    const raw = v.trim().toLowerCase();
    if (!raw) return null;
    if (raw === "all") return ["main", "sub", "ext"];
    const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
    const out: Array<"main" | "sub" | "ext"> = [];
    for (const p of parts) {
      if (p === "main" || p === "sub" || p === "ext") {
        if (!out.includes(p)) out.push(p);
      }
    }
    return out.length ? out : null;
  };

  // Profiles to test:
  // - BAICHUAN_PROFILE=all            -> test all (main, sub, ext)
  // - BAICHUAN_PROFILE=main           -> test only main
  // - BAICHUAN_PROFILE=main,sub       -> test main + sub
  // - unset                           -> test all available profiles from metadata (preferred)
  const requestedProfiles = parseProfilesEnv(process.env.BAICHUAN_PROFILE);

  try {
    // Login
    log("Baichuan TCP login");
    const maxEnc = (process.env.BAICHUAN_MAX_ENC as any) as "none" | "bc" | "aes" | "full_aes" | undefined;
    await api.login(maxEnc ?? "aes");
    logSuccess("Login completed");

    // Verifica profili disponibili
    log("Checking available profiles");
    const streamMetadata = await api.getStreamMetadata(channel);
    logSuccess("Stream metadata fetched");
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
    
    log(`Available profiles: ${availableProfiles.length > 0 ? availableProfiles.join(", ") : "none (continuing anyway)"}`);
    
    // Se nessun profilo è disponibile, prova comunque con "sub" come default
    if (availableProfiles.length === 0) {
      log("No profiles found in metadata, continuing with 'sub' as default");
      availableProfiles.push("sub");
    }

    // Decide which profiles to test.
    // If BAICHUAN_PROFILE is set, honor it; otherwise use what's available.
    const preferredOrder: Array<"main" | "sub" | "ext"> = ["main", "sub", "ext"];
    const profiles = (requestedProfiles ?? preferredOrder.filter((p) => availableProfiles.includes(p)));
    log(`Profiles to test: ${profiles.join(", ")}${requestedProfiles ? " (forced via BAICHUAN_PROFILE)" : ""}`);

    // Testa ogni profilo disponibile
    for (const profile of profiles) {
      if (!availableProfiles.includes(profile)) {
        log(`Profile ${profile} not available, skipping`);
        continue;
      }

      log(`\n🎥 Testing profile: ${profile}`);
      
      let videoStream: BaichuanVideoStream | undefined;
      let inputFps = 25;

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
            logSuccess(`First video frame received (${frame.length} bytes)`);
          }
        });

        videoStream.on("audioFrame", (frame: Buffer) => {
          audioFrameCount++;
          if (audioFrameCount === 1) {
            logSuccess(`First audio frame received (${frame.length} bytes)`);
          }
        });

        videoStream.on("error", (error: Error) => {
          logError(`Error in video stream`, error);
        });

        // Prova a ricavare FPS dai metadati dello stream (aiuta ffmpeg a generare PTS/DTS)
        if (Array.isArray(streamMetadata)) {
          const found = streamMetadata.find((s: any) => s?.profile === profile);
          if (found?.frameRate) inputFps = Number(found.frameRate) || inputFps;
        } else if (streamMetadata && typeof streamMetadata === "object") {
          const streams = (streamMetadata as any).streams;
          if (Array.isArray(streams)) {
            const found = streams.find((s: any) => s?.profile === profile);
            if (found?.frameRate) inputFps = Number(found.frameRate) || inputFps;
          }
        }
        // Avvio stream video
        log(`Starting video stream for profile ${profile}`);
        await videoStream.start();
        logSuccess(`Video stream started for profile ${profile}`);
        
        // Attendi che arrivino alcuni frame video prima di registrare
        let frameReceived = false;
        let totalFrames = 0;
        const frameTimeout = setTimeout(() => {
          if (!frameReceived) {
            logError("No video frames received after 5 seconds", new Error("Timeout"));
          }
        }, 5000);
        
        const waitForFramesHandler = () => {
          if (!frameReceived) {
            frameReceived = true;
            clearTimeout(frameTimeout);
            logSuccess("First video frame received!");
          }
          totalFrames++;
        };
        videoStream.on("videoFrame", waitForFramesHandler);
        
        // Attendi almeno 3 secondi per accumulare frame
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Rimuovi handler temporaneo
        videoStream.removeListener("videoFrame", waitForFramesHandler);
        
        if (!frameReceived) {
          logError("No video frames received after 5 seconds", new Error("No video frames"));
          continue;
        }
        
        logSuccess(`Received ${totalFrames} video frames, starting recording (direct pipe)`);
        
        // Registra direttamente dal videoStream usando ffmpeg stdin
        const outputFile = path.join(recordingsDir, `recording_${profile}_${Date.now()}.mp4`);
        log(`Recording ${duration}s for profile ${profile} (direct pipe)`);
        
        // Aggiungi timeout per la registrazione
        try {
          await Promise.race([
            recordVideoFromStream(videoStream, outputFile, duration, inputFps),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error("Timeout registrazione direct pipe")), (duration + 8) * 1000)
            ),
          ]);
        } catch (error) {
          logError(`Error during recording (direct pipe)`, error);
          continue;
        }
        
        // Verifica che il file sia stato creato
        if (fs.existsSync(outputFile)) {
          const stats = fs.statSync(outputFile);
          logSuccess(`Recorded file: ${outputFile} (${stats.size} bytes)`);
          logSuccess(`Video frames received: ${videoFrameCount}`);
          logSuccess(`Audio frames received: ${audioFrameCount}`);
        } else {
          logError(`File not created: ${outputFile}`, new Error("File not found"));
        }

      } catch (error) {
        logError(`Error while testing profile ${profile}`, error);
      } finally {
        // Cleanup
        if (videoStream) {
          try {
            await videoStream.stop();
            logSuccess(`Video stream stopped for profile ${profile}`);
          } catch (error) {
            logError(`Error while stopping stream for profile ${profile}`, error);
          }
        }
        

        // Attendi un po' prima del prossimo profilo
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    logSuccess("✅ All tests completed!");

  } catch (error) {
    logError("Critical error during tests", error);
    process.exit(1);
  } finally {
    try {
      await api.close();
      logSuccess("Connection closed");
    } catch (error) {
      logError("Error while closing connection", error);
    }
  }
}

testVideoStreamRecording().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

