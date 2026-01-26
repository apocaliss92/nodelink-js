import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import type { ReolinkBaichuanApi } from "../reolink/baichuan/ReolinkBaichuanApi";
import type { BaichuanVideoStream } from "../baichuan/stream/BaichuanVideoStream";

export interface ReplayHttpServerOptions {
  /** Baichuan API session to use for replay. */
  api: ReolinkBaichuanApi;
  /** Channel number (defaults to 0 for standalone cameras). */
  channel?: number;
  /** Recording file name (e.g., "RecM03_20250101_120000_123.264"). */
  fileName: string;
  /** Stream type: mainStream or subStream (inferred from fileName if not specified). */
  streamType?: "mainStream" | "subStream";
  logger: Console;
  /** Path to ffmpeg binary */
  ffmpegPath?: string;
  /** Host to bind (default: 127.0.0.1) */
  host?: string;
  /** Force NVR mode */
  isNvr?: boolean;
}

export interface ReplayHttpServer {
  /** URL to access the stream */
  url: string;
  host: string;
  port: number;
  /** Video codec detected */
  videoCodec: "h264" | "h265";
  /** Whether audio is present */
  hasAudio: boolean;
  /** Close the server and cleanup */
  close: () => Promise<void>;
}

interface CachedFrame {
  type: "video" | "audio";
  data: Buffer;
  isKeyframe?: boolean;
  videoType?: "H264" | "H265";
  timestamp?: number;
}

/**
 * Create an HTTP server that streams a recording replay using ffmpeg.
 *
 * This approach:
 * 1. Starts the replay and caches all frames in memory
 * 2. Waits for frames to be cached before starting ffmpeg
 * 3. Feeds cached frames + live frames to ffmpeg
 * 4. ffmpeg outputs fragmented MP4 which is served via HTTP
 *
 * This allows progressive playback while ensuring no frames are lost.
 */
export async function createReplayHttpServer(
  options: ReplayHttpServerOptions,
): Promise<ReplayHttpServer> {
  const {
    api,
    channel = 0,
    fileName,
    logger,
    ffmpegPath = "ffmpeg",
    host = "127.0.0.1",
    isNvr,
  } = options;

  // Infer streamType from fileName if not provided
  const streamType =
    options.streamType ??
    (fileName.includes("RecS03_") ? "subStream" : "mainStream");

  const log = (msg: string) =>
    logger.log(`[ReplayHTTP ch=${channel} file=${fileName.slice(-30)}] ${msg}`);
  const warn = (msg: string) =>
    logger.warn(
      `[ReplayHTTP ch=${channel} file=${fileName.slice(-30)}] ${msg}`,
    );

  log(`starting replay: streamType=${streamType}`);

  // Frame cache - stores all frames until ffmpeg consumes them
  const frameCache: CachedFrame[] = [];
  let replayEnded = false;
  let videoCodec: "h264" | "h265" = "h264";
  let hasAudio = false;
  let firstKeyframeReceived = false;

  // Start the recording replay stream
  const replayParams: {
    channel: number;
    fileName: string;
    streamType: "mainStream" | "subStream";
    timeoutMs: number;
    logger: Console;
    isNvr?: boolean;
  } = {
    channel,
    fileName,
    streamType,
    timeoutMs: 30_000,
    logger,
  };
  if (isNvr !== undefined) {
    replayParams.isNvr = isNvr;
  }

  const { stream: videoStream, stop: stopReplay } =
    await api.startRecordingReplayStream(replayParams);

  // Cache frames as they arrive
  const onVideoFrame = (au: any) => {
    if (!au?.data) return;

    const frame: CachedFrame = {
      type: "video",
      data: au.data,
      isKeyframe: au.isKeyframe,
      videoType: au.videoType,
      timestamp: au.microseconds,
    };

    frameCache.push(frame);

    if (au.videoType === "H265") {
      videoCodec = "h265";
    }

    if (au.isKeyframe && !firstKeyframeReceived) {
      firstKeyframeReceived = true;
      log(
        `first keyframe received, codec=${videoCodec}, cached=${frameCache.length} frames`,
      );
    }
  };

  const onAudioFrame = (frame: Buffer) => {
    if (!frame?.length) return;
    hasAudio = true;

    frameCache.push({
      type: "audio",
      data: frame,
    });
  };

  const onReplayEnd = () => {
    log(`replay ended, total frames cached: ${frameCache.length}`);
    replayEnded = true;
  };

  videoStream.on("videoAccessUnit" as any, onVideoFrame);
  videoStream.on("audioFrame" as any, onAudioFrame);
  videoStream.on("end" as any, onReplayEnd);
  videoStream.on("close" as any, () => {
    if (!replayEnded) {
      replayEnded = true;
    }
  });

  // Wait for first keyframe before proceeding
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for first keyframe"));
    }, 30_000);

    const check = () => {
      if (firstKeyframeReceived) {
        clearTimeout(timeout);
        resolve();
      } else if (replayEnded) {
        clearTimeout(timeout);
        reject(new Error("Replay ended before first keyframe"));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });

  log(
    `ready to serve: codec=${videoCodec}, hasAudio=${hasAudio}, cached=${frameCache.length} frames`,
  );

  // HTTP server state
  let httpServer: http.Server | null = null;
  let ffmpegProcess: ChildProcess | null = null;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;

    log("closing...");

    videoStream.removeListener("videoAccessUnit" as any, onVideoFrame);
    videoStream.removeListener("audioFrame" as any, onAudioFrame);
    videoStream.removeListener("end" as any, onReplayEnd);

    try {
      await stopReplay();
    } catch {
      // ignore
    }

    if (ffmpegProcess) {
      try {
        ffmpegProcess.kill("SIGKILL");
      } catch {
        // ignore
      }
      ffmpegProcess = null;
    }

    if (httpServer) {
      httpServer.close();
      httpServer = null;
    }
  };

  // Create HTTP server
  httpServer = http.createServer((req, res) => {
    if (closed) {
      res.writeHead(503);
      res.end("Server closed");
      return;
    }

    log(`HTTP request: ${req.method} ${req.url}`);

    // Set headers for streaming
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
    });

    // Create a PassThrough stream to pipe ffmpeg output
    const outputStream = new PassThrough();

    // Build ffmpeg command
    // Input: raw H.264/H.265 Annex-B from stdin
    // Output: fragmented MP4 to stdout
    const inputCodec = videoCodec === "h265" ? "hevc" : "h264";
    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      // Video input
      "-f",
      inputCodec,
      "-i",
      "pipe:0",
      // Output settings - fragmented MP4 for streaming
      "-c:v",
      "copy",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-f",
      "mp4",
      "pipe:1",
    ];

    log(`spawning ffmpeg: ${ffmpegPath} ${ffmpegArgs.join(" ")}`);

    ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Pipe ffmpeg stdout to HTTP response
    ffmpegProcess.stdout?.pipe(outputStream).pipe(res);

    // Log ffmpeg errors
    ffmpegProcess.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        warn(`ffmpeg: ${msg}`);
      }
    });

    ffmpegProcess.on("error", (err) => {
      warn(`ffmpeg error: ${err.message}`);
      res.end();
    });

    ffmpegProcess.on("close", (code) => {
      log(`ffmpeg exited with code ${code}`);
      res.end();
    });

    // Handle client disconnect
    req.on("close", () => {
      log("client disconnected");
      if (ffmpegProcess) {
        try {
          ffmpegProcess.stdin?.end();
          ffmpegProcess.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    });

    // Feed cached frames to ffmpeg, then continue with live frames
    const feedFrames = async () => {
      const stdin = ffmpegProcess?.stdin;
      if (!stdin) return;

      // Send all cached video frames
      let frameIndex = 0;
      for (const frame of frameCache) {
        if (frame.type === "video" && frame.data) {
          try {
            const canWrite = stdin.write(frame.data);
            if (!canWrite) {
              await new Promise<void>((resolve) =>
                stdin.once("drain", resolve),
              );
            }
          } catch (e) {
            warn(`error writing cached frame ${frameIndex}: ${e}`);
            break;
          }
        }
        frameIndex++;
      }

      log(`fed ${frameIndex} cached frames to ffmpeg`);

      // Continue with live frames
      const liveFrameHandler = (au: any) => {
        if (!au?.data || !stdin.writable) return;
        try {
          stdin.write(au.data);
        } catch {
          // ignore write errors
        }
      };

      videoStream.on("videoAccessUnit" as any, liveFrameHandler);

      // When replay ends, close ffmpeg stdin
      const endHandler = () => {
        log("replay finished, closing ffmpeg stdin");
        videoStream.removeListener("videoAccessUnit" as any, liveFrameHandler);
        try {
          stdin.end();
        } catch {
          // ignore
        }
      };

      if (replayEnded) {
        endHandler();
      } else {
        videoStream.once("end" as any, endHandler);
        videoStream.once("close" as any, endHandler);
      }
    };

    // Start feeding frames
    feedFrames().catch((e) => {
      warn(`error feeding frames: ${e}`);
    });
  });

  // Start listening
  await new Promise<void>((resolve, reject) => {
    httpServer!.once("error", reject);
    httpServer!.listen(0, host, () => resolve());
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind HTTP server");
  }
  const port = address.port;

  const url = `http://${host}:${port}/replay.mp4`;
  log(`HTTP server listening: ${url}`);

  return {
    url,
    host,
    port,
    videoCodec,
    hasAudio,
    close,
  };
}
