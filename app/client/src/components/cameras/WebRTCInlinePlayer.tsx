import { useCallback, useEffect, useRef, useState } from "react";
import {
  Play,
  Square,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
} from "lucide-react";
import { trpcMutation } from "../../api";
import { ImaAdpcmEncoder, floatToPcm16 } from "./utils/imaAdpcm";

/**
 * WebRTC player driven by the in-process `BaichuanWebRTCServer` via the
 * `webrtc` tRPC router. The SERVER drives the offer (its peer connection
 * knows the camera codec); the browser answers and trickles its own ICE.
 *
 * The server also opens a bidirectional `intercom` DataChannel on demand:
 * the browser captures the mic, encodes IMA-ADPCM at 16 kHz mono, and ships
 * chunks of 1024 samples to the server which forwards them as BcMedia ADPCM
 * Talk frames to the camera. Downstream audio (camera → browser) already
 * flows on the standard Opus RTP track.
 */
type Profile = "main" | "sub" | "ext";

export interface WebRTCInlinePlayerProps {
  /** Camera id — required to open the native session. */
  cameraId?: string;
  /** Profile (defaults to `sub`). */
  profile?: Profile;
  /**
   * Auto-start the stream when the component mounts. Defaults to `true` so
   * existing call sites keep their previous behaviour; pass `false` to land
   * on the idle screen with a Play button.
   */
  autoStart?: boolean;
  /**
   * Optional: render an overlay layer (typically a `<canvas>`) on top of the
   * media element. Receives whichever element is currently driving the
   * picture — `<video>` for RTP / H.264, `<canvas>` for the WebCodecs H.265
   * path. The overlay only needs `getBoundingClientRect()` so the same code
   * works for either.
   */
  overlayRender?: (mediaEl: HTMLElement | null) => React.ReactNode;
}

/** Target sample rate Reolink TalkAbility announces for ADPCM intercom. */
const INTERCOM_SAMPLE_RATE = 16000;
/** Reolink TalkAbility's `lengthPerEncoder` — chunk size in PCM samples. */
const INTERCOM_CHUNK_SAMPLES = 1024;

export function WebRTCInlinePlayer({
  cameraId,
  profile,
  autoStart = true,
  overlayRender,
}: WebRTCInlinePlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaContainerRef = useRef<HTMLDivElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  /**
   * Set to `true` when the user (or unmount) requests a stop. Every async
   * codepath that touches the peer connection checks this so we can bail
   * cleanly mid-handshake.
   */
  const closedRef = useRef(false);
  /**
   * Serializes start/stop operations. The camera rejects a second
   * `<Preview>` for the same channel+profile with `response_code 430`
   * while the previous stream's dedicated socket is still being released,
   * so we always await the previous operation (mount/unmount/stop) before
   * opening a new session. Without this guard, dev-mode StrictMode and
   * rapid Stop→Start clicks both produce the 430 the user reported.
   */
  const pendingOpRef = useRef<Promise<void>>(Promise.resolve());
  // Intercom (mic → camera) state. Set up once the server's `intercom`
  // DataChannel is open and reused for every push-to-talk session.
  const intercomChannelRef = useRef<RTCDataChannel | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const adpcmEncoderRef = useRef<ImaAdpcmEncoder | null>(null);
  /**
   * PCM accumulator: AudioWorklet posts ~128-sample bursts; we batch them
   * to INTERCOM_CHUNK_SAMPLES before encoding so the camera receives
   * predictably-sized BcMedia frames.
   */
  const pcmBufferRef = useRef<Float32Array | null>(null);
  const pcmBufferLenRef = useRef(0);

  const [status, setStatus] = useState<string>("Idle");
  const [error, setError] = useState<string | null>(null);
  const [renderTarget, setRenderTarget] = useState<"video" | "canvas">("video");
  const [muted, setMuted] = useState(true);
  const [streamActive, setStreamActive] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [intercomReady, setIntercomReady] = useState(false);
  const [micActive, setMicActive] = useState(false);

  const log = useCallback((msg: string, extra?: unknown) => {
    console.log(`[WebRTC] ${msg}`, extra ?? "");
  }, []);

  // ---------------------------------------------------------------------------
  // Tear-down
  // ---------------------------------------------------------------------------
  const stopIntercom = useCallback(async (): Promise<void> => {
    if (workletNodeRef.current) {
      try { workletNodeRef.current.disconnect(); } catch { /* noop */ }
      workletNodeRef.current = null;
    }
    if (mediaStreamRef.current) {
      for (const t of mediaStreamRef.current.getTracks()) {
        try { t.stop(); } catch { /* noop */ }
      }
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      try { await audioContextRef.current.close(); } catch { /* noop */ }
      audioContextRef.current = null;
    }
    pcmBufferRef.current = null;
    pcmBufferLenRef.current = 0;
    adpcmEncoderRef.current?.reset();
    setMicActive(false);
  }, []);

  const teardown = useCallback(async () => {
    closedRef.current = true;
    await stopIntercom();
    const pc = pcRef.current;
    const sid = sessionIdRef.current;
    const dec = decoderRef.current;
    pcRef.current = null;
    sessionIdRef.current = null;
    decoderRef.current = null;
    intercomChannelRef.current = null;
    setIntercomReady(false);
    if (dec && dec.state !== "closed") {
      try { dec.close(); } catch { /* noop */ }
    }
    if (pc) {
      try { pc.close(); } catch { /* noop */ }
    }
    if (sid) {
      try { await trpcMutation("webrtc.close", { sessionId: sid }); }
      catch { /* best-effort */ }
    }
    setStreamActive(false);
    setRenderTarget("video");
    setStatus("Idle");
  }, [stopIntercom]);

  // ---------------------------------------------------------------------------
  // Native start (BaichuanWebRTCServer)
  // ---------------------------------------------------------------------------
  const startNative = useCallback(async () => {
    if (!cameraId) throw new Error("cameraId is required");

    // 1) Ask the server for an offer. Always request intercom — the camera
    // will simply ignore the DataChannel if the user never speaks.
    const { sessionId, offer } = await trpcMutation<{
      sessionId: string;
      offer: { type: "offer"; sdp: string };
    }>("webrtc.create", {
      cameraId,
      profile: profile ?? "sub",
      enableIntercom: true,
    });
    log("got offer", { sessionId, sdpLen: offer.sdp.length });
    if (closedRef.current) {
      try { await trpcMutation("webrtc.close", { sessionId }); } catch { /* noop */ }
      return;
    }
    sessionIdRef.current = sessionId;

    // 2) Build the local peer.
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;

    // werift in particular doesn't always emit MSID for its tracks, so
    // ev.streams[0] can be undefined. Wrap the bare track in a fresh
    // MediaStream so the <video> element still picks it up.
    pc.ontrack = (ev) => {
      log("ontrack", { kind: ev.track.kind });
      if (!videoRef.current) return;
      let stream = ev.streams[0];
      if (!stream) {
        stream = new MediaStream([ev.track]);
      } else if (!stream.getTracks().includes(ev.track)) {
        stream.addTrack(ev.track);
      }
      if (ev.track.kind === "video") {
        videoRef.current.srcObject = stream;
      } else if (ev.track.kind === "audio") {
        const existing = videoRef.current.srcObject as MediaStream | null;
        if (existing instanceof MediaStream) {
          if (!existing.getAudioTracks().length) existing.addTrack(ev.track);
        } else {
          videoRef.current.srcObject = stream;
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (closedRef.current) return;
      const s = pc.connectionState;
      log("connectionState", s);
      if (s === "connected") {
        setStatus("Connected");
        setError(null);
      } else if (s === "disconnected" || s === "failed") {
        setError(`Connection ${s}`);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (closedRef.current) return;
      if (
        pc.iceConnectionState === "connected" ||
        pc.iceConnectionState === "completed"
      ) {
        setStatus("Streaming");
      }
    };

    pc.ondatachannel = (ev) => {
      log("ondatachannel", { label: ev.channel.label });
      if (ev.channel.label === "intercom") {
        // Mic → camera path. The handshake is one-way: browser sends
        // ADPCM bytes; server forwards via Intercom.sendAudio.
        intercomChannelRef.current = ev.channel;
        ev.channel.binaryType = "arraybuffer";
        ev.channel.onopen = () => {
          log("intercom dc open");
          setIntercomReady(true);
        };
        ev.channel.onclose = () => {
          log("intercom dc close");
          setIntercomReady(false);
          void stopIntercom();
        };
        return;
      }
      if (ev.channel.label !== "video") return;
      const dc = ev.channel;
      dc.binaryType = "arraybuffer";
      let chunkBuf: Uint8Array[] = [];
      let expectedChunks = 0;
      let nextChunkIndex = 0;
      // --- H.265 decode diagnostics ---
      let dbgChunks = 0; // binary chunks received
      let dbgFramesAssembled = 0; // complete frames reassembled
      let dbgDecodeCalls = 0; // decode() invocations
      let dbgFramesDecoded = 0; // decoder output frames (rendered)
      let dbgChunkDrops = 0; // frames dropped due to out-of-order chunks
      let dbgLastAt = 0;
      dc.onmessage = (msg) => {
        if (typeof msg.data === "string") {
          try {
            const info = JSON.parse(msg.data) as {
              type: string;
              codec: string;
              width: number;
              height: number;
            };
            if (info.type !== "codec") return;
            log("codec announce", info);
            if (info.codec === "H265") {
              if (!("VideoDecoder" in window)) {
                setError(
                  "Browser does not support WebCodecs — H.265 stream can't be decoded. Switch the camera to H.264 or use a Chromium-based browser.",
                );
                return;
              }
              setRenderTarget("canvas");
              if (decoderRef.current) {
                try { decoderRef.current.close(); } catch { /* noop */ }
              }
              const dec = new VideoDecoder({
                output: (frame) => {
                  dbgFramesDecoded++;
                  if (dbgFramesDecoded === 1)
                    log("H265 FIRST decoded frame ✓", {
                      w: frame.displayWidth,
                      h: frame.displayHeight,
                    });
                  const c = canvasRef.current;
                  if (c) {
                    const ctx = c.getContext("2d");
                    if (ctx) {
                      if (c.width !== frame.displayWidth) c.width = frame.displayWidth;
                      if (c.height !== frame.displayHeight) c.height = frame.displayHeight;
                      ctx.drawImage(frame, 0, 0);
                    }
                  }
                  frame.close();
                },
                error: (e) => log("VideoDecoder error", String(e)),
              });
              try {
                dec.configure({
                  codec: "hev1.1.6.L93.B0",
                  codedWidth: info.width > 0 ? info.width : 1920,
                  codedHeight: info.height > 0 ? info.height : 1080,
                });
                decoderRef.current = dec;
                log("VideoDecoder configured for H.265");
              } catch (e) {
                setError(`H.265 decoder configure failed: ${String(e)}`);
              }
            } else {
              setRenderTarget("video");
            }
          } catch (e) {
            log("non-JSON codec announce", String(e));
          }
          return;
        }
        // Binary chunk for WebCodecs path. Wire format:
        // [u16 BE chunkIndex][u16 BE totalChunks][payload]. We accumulate
        // chunks in order; on the last one we strip the 12-byte custom
        // frame header before handing to VideoDecoder.
        if (!(msg.data instanceof ArrayBuffer) || !decoderRef.current) return;
        const raw = new Uint8Array(msg.data);
        if (raw.length < 4) return;
        dbgChunks++;
        const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const chunkIndex = dv.getUint16(0);
        const totalChunks = dv.getUint16(2);
        const payload = raw.subarray(4);
        if (chunkIndex === 0) {
          chunkBuf = [payload];
          expectedChunks = totalChunks;
          nextChunkIndex = 1;
        } else if (
          chunkIndex !== nextChunkIndex ||
          totalChunks !== expectedChunks
        ) {
          // Out-of-order or totalChunks mismatch → drop and resync on
          // next chunk-0.
          dbgChunkDrops++;
          if (dbgChunkDrops <= 3 || dbgChunkDrops % 50 === 0)
            log("H265 chunk OUT-OF-ORDER → frame dropped", {
              got: chunkIndex,
              expected: nextChunkIndex,
              totalChunks,
              expectedTotal: expectedChunks,
              drops: dbgChunkDrops,
            });
          chunkBuf = [];
          expectedChunks = 0;
          nextChunkIndex = 0;
          return;
        } else {
          chunkBuf.push(payload);
          nextChunkIndex++;
        }
        if (nextChunkIndex < expectedChunks) return;
        let totalLen = 0;
        for (const c of chunkBuf) totalLen += c.length;
        const frame = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunkBuf) {
          frame.set(c, off);
          off += c.length;
        }
        chunkBuf = [];
        expectedChunks = 0;
        nextChunkIndex = 0;
        if (frame.length < 12) return;
        dbgFramesAssembled++;
        const headerKeyframe = frame[9] === 1;
        const nalBytes = frame.subarray(12);
        const dec = decoderRef.current;
        if (dbgFramesAssembled === 1)
          log("H265 FIRST frame assembled", {
            keyframe: headerKeyframe,
            bytes: nalBytes.length,
            decoderState: dec.state,
          });
        try {
          dec.decode(
            new EncodedVideoChunk({
              type: headerKeyframe ? "key" : "delta",
              timestamp: performance.now() * 1000,
              data: nalBytes,
            }),
          );
          dbgDecodeCalls++;
        } catch (e) {
          log("decode threw", String(e));
        }
        // Periodic health line so we can see where the pipeline stalls.
        const now = performance.now();
        if (now - dbgLastAt > 3000) {
          dbgLastAt = now;
          log("H265 pipeline", {
            chunks: dbgChunks,
            assembled: dbgFramesAssembled,
            decodeCalls: dbgDecodeCalls,
            decoded: dbgFramesDecoded,
            chunkDrops: dbgChunkDrops,
            decoderState: dec.state,
            decodeQueue: dec.decodeQueueSize,
          });
        }
      };
    };

    pc.onicecandidate = (ev) => {
      if (closedRef.current || !ev.candidate) return;
      const c = ev.candidate;
      void trpcMutation("webrtc.addIce", {
        sessionId,
        candidate: {
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex,
        },
      }).catch(() => { /* best-effort trickle */ });
    };

    setStatus("Signaling…");
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (closedRef.current) return;
    await trpcMutation("webrtc.answer", {
      sessionId,
      sdp: { type: "answer", sdp: pc.localDescription!.sdp },
    });
    log("answer sent");
    setStatus("Buffering…");
  }, [cameraId, profile, log, stopIntercom]);

  const start = useCallback(async () => {
    // Serialize against any in-flight teardown / start. Without this, a
    // rapid stop→start or a StrictMode double-mount would race the
    // server's session close and the camera would reject the new
    // <Preview> with response_code 430 (stream still owned by the
    // previous dedicated socket).
    const previous = pendingOpRef.current;
    const op = (async () => {
      try { await previous; } catch { /* prior op failed; we proceed anyway */ }
      closedRef.current = false;
      setError(null);
      setStatus("Connecting…");
      setStreamActive(true);
      try {
        await startNative();
      } catch (err) {
        if (!closedRef.current) {
          setError(String(err));
          setStatus("Error");
          setStreamActive(false);
          void teardown();
        }
      }
    })();
    pendingOpRef.current = op;
    await op;
  }, [startNative, teardown]);

  const stop = useCallback(async () => {
    const previous = pendingOpRef.current;
    const op = (async () => {
      try { await previous; } catch { /* noop */ }
      await teardown();
    })();
    pendingOpRef.current = op;
    await op;
  }, [teardown]);

  // Auto-start on mount (default: true). When props change (camera /
  // profile), the cleanup tears down through the same serialization
  // promise, then start can safely run again.
  useEffect(() => {
    if (autoStart) void start();
    return () => {
      void stop();
    };
    // Effect intentionally runs on prop-set changes only; `start` / `stop`
    // are stable callbacks but listing them would cause spurious re-runs.
  }, [cameraId, profile]);

  // ---------------------------------------------------------------------------
  // Mic capture → IMA-ADPCM → intercom DataChannel
  // ---------------------------------------------------------------------------
  const startIntercom = useCallback(async () => {
    if (!intercomChannelRef.current ||
        intercomChannelRef.current.readyState !== "open") {
      setError("Intercom channel not open yet");
      return;
    }
    try {
      const ms = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: INTERCOM_SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      mediaStreamRef.current = ms;
      // We have to construct the AudioContext at the target sample rate so
      // the AudioWorklet receives 16 kHz frames directly — browsers resample
      // the mic stream on the way in.
      const AudioCtx = (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext);
      const ctx = new AudioCtx({ sampleRate: INTERCOM_SAMPLE_RATE });
      audioContextRef.current = ctx;
      await ctx.audioWorklet.addModule("/worklets/pcm-tap.js");
      const source = ctx.createMediaStreamSource(ms);
      const node = new AudioWorkletNode(ctx, "pcm-tap", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
      });
      adpcmEncoderRef.current = new ImaAdpcmEncoder();
      pcmBufferRef.current = new Float32Array(INTERCOM_CHUNK_SAMPLES);
      pcmBufferLenRef.current = 0;
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
        const samples = ev.data;
        const buf = pcmBufferRef.current;
        const enc = adpcmEncoderRef.current;
        const dc = intercomChannelRef.current;
        if (!buf || !enc || !dc || dc.readyState !== "open") return;
        let i = 0;
        while (i < samples.length) {
          const room = INTERCOM_CHUNK_SAMPLES - pcmBufferLenRef.current;
          const take = Math.min(room, samples.length - i);
          buf.set(samples.subarray(i, i + take), pcmBufferLenRef.current);
          pcmBufferLenRef.current += take;
          i += take;
          if (pcmBufferLenRef.current >= INTERCOM_CHUNK_SAMPLES) {
            const pcm16 = floatToPcm16(buf);
            const adpcm = enc.encode(pcm16);
            try { dc.send(adpcm); } catch { /* drop on error */ }
            pcmBufferLenRef.current = 0;
          }
        }
      };
      source.connect(node);
      workletNodeRef.current = node;
      setMicActive(true);
      log("intercom started");
    } catch (e) {
      setError(`Microphone error: ${String(e)}`);
      void stopIntercom();
    }
  }, [log, stopIntercom]);

  const toggleMic = useCallback(async () => {
    if (micActive) {
      await stopIntercom();
    } else {
      await startIntercom();
    }
  }, [micActive, startIntercom, stopIntercom]);

  // ---------------------------------------------------------------------------
  // Fullscreen state sync (so the icon flips when the user presses Esc)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = mediaContainerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen();
    }
  }, []);

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {error && (
        <div
          style={{
            color: "#ef4444",
            fontSize: 13,
            marginBottom: 8,
            padding: "6px 10px",
            background: "rgba(239,68,68,0.1)",
            borderRadius: 6,
            flexShrink: 0,
          }}
        >
          {error}
        </div>
      )}
      <div
        style={{
          fontSize: 12,
          color: "var(--muted)",
          marginBottom: 4,
          flexShrink: 0,
        }}
      >
        {status}
      </div>
      <div
        ref={mediaContainerRef}
        style={{
          position: "relative",
          flex: "1 1 0",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={muted}
          style={{
            width: "100%",
            height: "100%",
            borderRadius: 8,
            background: "#000",
            display: renderTarget === "video" ? "block" : "none",
            objectFit: "contain",
          }}
        />
        <canvas
          ref={canvasRef}
          style={{
            width: "100%",
            height: "100%",
            borderRadius: 8,
            background: "#000",
            display: renderTarget === "canvas" ? "block" : "none",
            objectFit: "contain",
          }}
        />
        {overlayRender
          ? overlayRender(
              renderTarget === "canvas" ? canvasRef.current : videoRef.current,
            )
          : null}

        {/* Idle overlay: big Play button shown when no stream is active. */}
        {!streamActive && (
          <button
            type="button"
            onClick={() => void start()}
            title="Start stream"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0,0,0,0.55)",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              color: "#fff",
            }}
          >
            <span
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 56,
                height: 56,
                borderRadius: "50%",
                background: "rgba(255,255,255,0.12)",
                border: "1px solid rgba(255,255,255,0.25)",
              }}
            >
              <Play size={22} fill="currentColor" />
            </span>
          </button>
        )}

        {/* Controls overlay: Lucide icons matching the rest of the app. */}
        <ControlsBar
          streamActive={streamActive}
          muted={muted}
          intercomReady={intercomReady}
          micActive={micActive}
          fullscreen={fullscreen}
          onPlayStop={() => (streamActive ? void stop() : void start())}
          onToggleMute={() => setMuted((m) => !m)}
          onToggleMic={() => void toggleMic()}
          onToggleFullscreen={toggleFullscreen}
        />
      </div>
    </div>
  );
}

interface ControlsBarProps {
  streamActive: boolean;
  muted: boolean;
  intercomReady: boolean;
  micActive: boolean;
  fullscreen: boolean;
  onPlayStop: () => void;
  onToggleMute: () => void;
  onToggleMic: () => void;
  onToggleFullscreen: () => void;
}

function ControlsBar({
  streamActive,
  muted,
  intercomReady,
  micActive,
  fullscreen,
  onPlayStop,
  onToggleMute,
  onToggleMic,
  onToggleFullscreen,
}: ControlsBarProps) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 6,
        padding: "6px 8px",
        background: "linear-gradient(to top, rgba(0,0,0,0.55), rgba(0,0,0,0))",
        borderBottomLeftRadius: 8,
        borderBottomRightRadius: 8,
        pointerEvents: "none",
      }}
    >
      <ControlButton
        title={streamActive ? "Stop stream" : "Start stream"}
        onClick={onPlayStop}
      >
        {streamActive ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
      </ControlButton>
      {intercomReady && (
        <ControlButton
          title={micActive ? "Mute microphone (stop talking)" : "Talk to camera"}
          onClick={onToggleMic}
          highlight={micActive}
        >
          {micActive ? <Mic size={14} /> : <MicOff size={14} />}
        </ControlButton>
      )}
      <ControlButton
        title={muted ? "Unmute" : "Mute"}
        onClick={onToggleMute}
      >
        {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </ControlButton>
      <ControlButton
        title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        onClick={onToggleFullscreen}
      >
        {fullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
      </ControlButton>
    </div>
  );
}

function ControlButton({
  title,
  onClick,
  highlight,
  children,
}: {
  title: string;
  onClick: () => void;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        pointerEvents: "auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        background: highlight ? "rgba(239,68,68,0.7)" : "rgba(0,0,0,0.45)",
        color: "#fff",
        border: "1px solid rgba(255,255,255,0.2)",
        borderRadius: 6,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
