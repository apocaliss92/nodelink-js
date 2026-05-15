import { useEffect, useRef, useState } from "react";
import { trpcMutation } from "../../api";

/**
 * WebRTC player with two backends:
 *
 * 1. **go2rtc WHEP** (default): the browser drives the offer, posts SDP to
 *    `/go2rtc/api/webrtc?src=...`, receives the answer with ICE candidates
 *    pre-gathered, and the connection is up in one round-trip.
 *
 * 2. **Native** (when `useNative` is true OR `streamName` is empty): we call
 *    the in-process `BaichuanWebRTCServer` via the `webrtc` tRPC router. The
 *    SERVER drives the offer (its peer connection knows the camera codec); the
 *    browser answers and trickles its own ICE. Use this when go2rtc is not
 *    running or when you need exact frame timing for overlays.
 */
type Profile = "main" | "sub" | "ext";

export interface WebRTCInlinePlayerProps {
  /** go2rtc stream name (used in WHEP mode only). */
  streamName?: string;
  /** go2rtc HTTP API port (used in WHEP mode only). */
  go2rtcApiPort?: number | null;
  /** Host serving go2rtc (used in WHEP mode only — defaults to current host). */
  serviceIp?: string;
  /** Force the native pipeline (BaichuanWebRTCServer) regardless of go2rtc state. */
  useNative?: boolean;
  /** Camera id (required for native mode). */
  cameraId?: string;
  /** Profile (required for native mode; defaults to `sub`). */
  profile?: Profile;
  /**
   * Optional: render an overlay layer (typically a `<canvas>`) on top of the
   * media element. Receives whichever element is currently driving the
   * picture — `<video>` for RTP / H.264, `<canvas>` for the WebCodecs H.265
   * path. The overlay only needs `getBoundingClientRect()` so the same code
   * works for either.
   */
  overlayRender?: (mediaEl: HTMLElement | null) => React.ReactNode;
}

export function WebRTCInlinePlayer({
  streamName,
  go2rtcApiPort,
  serviceIp,
  useNative,
  cameraId,
  profile,
  overlayRender,
}: WebRTCInlinePlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaContainerRef = useRef<HTMLDivElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  const [status, setStatus] = useState<string>("Connecting...");
  const [error, setError] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<"go2rtc" | "native" | null>(null);
  // When the native server announces H.265, we switch to canvas + WebCodecs
  // because Chrome / Safari can't decode H.265 over standard WebRTC RTP.
  const [renderTarget, setRenderTarget] = useState<"video" | "canvas">("video");
  const [muted, setMuted] = useState(true);

  // The native path needs cameraId; fall back to "go2rtc" if missing.
  const wantNative = useNative === true && Boolean(cameraId);

  useEffect(() => {
    let closed = false;

    const cleanup = async (pc: RTCPeerConnection | null, sid: string | null) => {
      if (pc) {
        try { pc.close(); } catch { /* ignore */ }
      }
      if (sid) {
        try {
          await trpcMutation("webrtc.close", { sessionId: sid });
        } catch {
          // best-effort
        }
      }
    };

    const startGo2rtc = async () => {
      setActiveMode("go2rtc");
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      const videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
      try {
        const caps = RTCRtpReceiver.getCapabilities("video");
        const h264Only = (caps?.codecs ?? []).filter(
          (c) => c.mimeType.toLowerCase() === "video/h264",
        );
        if (h264Only.length > 0) videoTransceiver.setCodecPreferences(h264Only);
      } catch {
        // setCodecPreferences may be unavailable on some browsers
      }
      pc.addTransceiver("audio", { direction: "recvonly" });

      pc.ontrack = (ev) => {
        if (videoRef.current && ev.streams[0]) {
          videoRef.current.srcObject = ev.streams[0];
        }
      };

      pc.onconnectionstatechange = () => {
        if (closed) return;
        const state = pc.connectionState;
        if (state === "connected") {
          setStatus("Connected");
          setError(null);
        } else if (state === "disconnected" || state === "failed") {
          setError(`Connection ${state}`);
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (closed) return;
        if (
          pc.iceConnectionState === "connected" ||
          pc.iceConnectionState === "completed"
        ) {
          setStatus("Streaming");
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (closed) return;
      setStatus("Signaling...");

      if (!go2rtcApiPort) throw new Error("go2rtc API port not available yet");
      const isHttps = window.location.protocol === "https:";
      let whepUrl: string;
      if (isHttps) {
        whepUrl = `/go2rtc/api/webrtc?src=${encodeURIComponent(streamName!)}`;
      } else {
        const go2rtcHost = serviceIp || window.location.hostname;
        whepUrl = `http://${go2rtcHost}:${go2rtcApiPort}/api/webrtc?src=${encodeURIComponent(streamName!)}`;
      }
      const res = await fetch(whepUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: pc.localDescription!.sdp,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`WHEP failed (${res.status}): ${body}`);
      }
      const sdpAnswer = await res.text();
      if (closed) return;
      await pc.setRemoteDescription({ type: "answer", sdp: sdpAnswer });
      setStatus("Buffering...");
    };

    const startNative = async () => {
      setActiveMode("native");
      const log = (msg: string, extra?: unknown) => {
        // eslint-disable-next-line no-console
        console.log(`[WebRTC native] ${msg}`, extra ?? "");
      };

      // 1) Ask the server to spin up a session and give us the offer.
      const { sessionId, offer } = await trpcMutation<{
        sessionId: string;
        offer: { type: "offer"; sdp: string };
      }>("webrtc.create", {
        cameraId: cameraId!,
        profile: profile ?? "sub",
        enableIntercom: false,
      });
      log("got offer", { sessionId, sdpLen: offer.sdp.length });
      if (closed) {
        await cleanup(null, sessionId);
        return;
      }
      sessionIdRef.current = sessionId;

      // 2) Build the local peer.
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      // Some servers (werift in particular) don't emit MSID for their tracks,
      // so ev.streams[0] can be undefined. Wrap the bare track in a fresh
      // MediaStream so the <video> element still picks it up.
      pc.ontrack = (ev) => {
        log("ontrack", {
          kind: ev.track.kind,
          streams: ev.streams.length,
          readyState: ev.track.readyState,
          enabled: ev.track.enabled,
          muted: ev.track.muted,
        });
        if (!videoRef.current) return;
        let stream = ev.streams[0];
        if (!stream) {
          stream = new MediaStream([ev.track]);
        } else if (!stream.getTracks().includes(ev.track)) {
          stream.addTrack(ev.track);
        }
        // Only swap srcObject for video tracks — adding audio under it would
        // re-trigger the source set and stall the video element on Safari.
        if (ev.track.kind === "video") {
          videoRef.current.srcObject = stream;
        } else if (ev.track.kind === "audio") {
          // If we already have a stream, augment it; otherwise attach now.
          const existing = videoRef.current.srcObject as MediaStream | null;
          if (existing instanceof MediaStream) {
            if (!existing.getAudioTracks().length) existing.addTrack(ev.track);
          } else {
            videoRef.current.srcObject = stream;
          }
        }
      };
      pc.onconnectionstatechange = () => {
        if (closed) return;
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
        if (closed) return;
        log("iceConnectionState", pc.iceConnectionState);
        if (
          pc.iceConnectionState === "connected" ||
          pc.iceConnectionState === "completed"
        ) {
          setStatus("Streaming");
        }
      };
      pc.onsignalingstatechange = () => {
        log("signalingState", pc.signalingState);
      };
      // The server creates a data channel named "video" that carries:
      //   1) A JSON string announcement: { type:"codec", codec:"H264"|"H265", width, height }
      //   2) Raw Annex-B frame bytes (ArrayBuffer), one per video frame
      // For H.265 the RTP track is silent and ALL frames flow through this channel;
      // for H.264 the RTP track carries the video and this channel just sends the
      // codec announcement.
      pc.ondatachannel = (ev) => {
        log("ondatachannel", { label: ev.channel.label, state: ev.channel.readyState });
        if (ev.channel.label !== "video") return;
        const dc = ev.channel;
        dc.binaryType = "arraybuffer";
        dc.onopen = () => log("dc video onopen", { state: dc.readyState });
        dc.onclose = () => log("dc video onclose");
        dc.onerror = (e) => log("dc video onerror", String(e));
        let firstBinary = true;
        // Reassembly buffer for chunked frames. Server prepends a uniform
        // 4-byte header to every binary message: [u16 BE chunkIndex][u16 BE totalChunks].
        // Single-message frames arrive as [0, 1, ...frame]; multi-chunk frames
        // (e.g. H.265 4K IDRs ~400KB) are split into N messages with the
        // [i, N, ...slice] header. We accumulate all chunks in order before
        // stripping the 12-byte custom frame header and decoding.
        let chunkBuf: Uint8Array[] = [];
        let expectedChunks = 0;
        let nextChunkIndex = 0;
        dc.onmessage = (msg) => {
          if (msg.data instanceof ArrayBuffer) {
            if (firstBinary) {
              firstBinary = false;
              const head = Array.from(new Uint8Array(msg.data).slice(0, 16))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");
              log("dc first binary message", { bytes: msg.data.byteLength, head });
            }
          } else if (typeof msg.data === "string" && msg.data.length < 200) {
            log("dc string message", msg.data);
          }
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
                // Switch to canvas output and spin up a WebCodecs VideoDecoder.
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
                    // Generic HEVC Main profile. The decoder accepts a more
                    // permissive codec string than the SDP would; this works
                    // across Reolink models we've tested. If a specific
                    // profile-level is required, derive it from VPS/SPS in
                    // future iterations.
                    codec: "hev1.1.6.L93.B0",
                    codedWidth: info.width > 0 ? info.width : 1920,
                    codedHeight: info.height > 0 ? info.height : 1080,
                  });
                  decoderRef.current = dec;
                  log("VideoDecoder configured for H.265");
                } catch (e) {
                  log("VideoDecoder configure failed", String(e));
                  setError(`H.265 decoder configure failed: ${String(e)}`);
                }
              } else {
                // H.264 stays on the RTP track — nothing else to do here.
                setRenderTarget("video");
              }
            } catch (e) {
              log("non-JSON or malformed codec announce", String(e));
            }
            return;
          }
          // Binary chunk for the WebCodecs path.
          //
          // Wire format: [u16 BE chunkIndex][u16 BE totalChunks][payload].
          // We accumulate chunks in order; once `chunkIndex == totalChunks - 1`
          // we have the full frame, which itself starts with a 12-byte custom
          // header before the raw Annex-B bytes:
          //   [0..3]  frameNum (u32 BE)
          //   [4..7]  timestamp (u32 BE)
          //   [8]     flags (0x01 = H.265, 0x02 = H.264)
          //   [9]     keyframe (0/1)
          //   [10..11] reserved
          if (!(msg.data instanceof ArrayBuffer) || !decoderRef.current) {
            return;
          }
          const raw = new Uint8Array(msg.data);
          if (raw.length < 4) return;
          const dv = new DataView(
            raw.buffer,
            raw.byteOffset,
            raw.byteLength,
          );
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
            // Out-of-order or mid-frame totalChunks change → drop the frame
            // and resync on the next chunk-0. WebCodecs will replay from the
            // following keyframe.
            log("chunk reassembly desync", {
              chunkIndex,
              totalChunks,
              expected: nextChunkIndex,
              expectedTotal: expectedChunks,
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

          // Frame fully reassembled — concat then strip the 12-byte header.
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
          const headerKeyframe = frame[9] === 1;
          const nalBytes = frame.subarray(12);
          try {
            decoderRef.current.decode(
              new EncodedVideoChunk({
                type: headerKeyframe ? "key" : "delta",
                timestamp: performance.now() * 1000,
                data: nalBytes,
              }),
            );
          } catch (e) {
            log("decode threw", String(e));
          }
        };
      };

      // 3) Trickle browser ICE to the server.
      pc.onicecandidate = (ev) => {
        if (closed || !ev.candidate) return;
        const c = ev.candidate;
        // Fire-and-forget; if the connection is already up the server ignores it.
        void trpcMutation("webrtc.addIce", {
          sessionId,
          candidate: {
            candidate: c.candidate,
            sdpMid: c.sdpMid,
            sdpMLineIndex: c.sdpMLineIndex,
          },
        }).catch(() => { /* ignore — best-effort trickle */ });
      };

      // 4) Apply the server offer, build our answer.
      setStatus("Signaling...");
      await pc.setRemoteDescription(offer);
      log("remoteDescription set", {
        receivers: pc.getReceivers().length,
        senders: pc.getSenders().length,
      });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      log("localDescription set", { sdpLen: pc.localDescription?.sdp.length });
      if (closed) {
        await cleanup(pc, sessionId);
        return;
      }
      await trpcMutation("webrtc.answer", {
        sessionId,
        sdp: { type: "answer", sdp: pc.localDescription!.sdp },
      });
      log("answer sent");
      setStatus("Buffering...");
    };

    const start = async () => {
      try {
        if (wantNative) {
          await startNative();
        } else {
          await startGo2rtc();
        }
      } catch (err) {
        if (!closed) {
          setError(String(err));
          setStatus("Error");
        }
      }
    };

    void start();

    return () => {
      closed = true;
      const pc = pcRef.current;
      const sid = sessionIdRef.current;
      const dec = decoderRef.current;
      pcRef.current = null;
      sessionIdRef.current = null;
      decoderRef.current = null;
      if (dec && dec.state !== "closed") {
        try { dec.close(); } catch { /* ignore */ }
      }
      void cleanup(pc, sid);
    };
  }, [streamName, go2rtcApiPort, serviceIp, wantNative, cameraId, profile]);

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
        {activeMode && (
          <span style={{ marginLeft: 8, opacity: 0.6 }}>
            ({activeMode})
          </span>
        )}
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
        {/*
          Custom controls overlay. The <video> element only renders native
          controls for H.264 (RTP track); in H.265 mode the picture is
          painted to <canvas> which has no controls of its own. Mirror the
          essentials (mute, fullscreen) here so both modes look the same.
        */}
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
            padding: "4px 8px",
            background: "linear-gradient(to top, rgba(0,0,0,0.55), rgba(0,0,0,0))",
            borderBottomLeftRadius: 8,
            borderBottomRightRadius: 8,
            pointerEvents: "none",
          }}
        >
          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            title={muted ? "Unmute" : "Mute"}
            style={{
              pointerEvents: "auto",
              background: "rgba(0,0,0,0.4)",
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {muted ? "🔇" : "🔊"}
          </button>
          <button
            type="button"
            onClick={() => {
              const el = mediaContainerRef.current;
              if (!el) return;
              if (document.fullscreenElement) {
                void document.exitFullscreen();
              } else {
                void el.requestFullscreen();
              }
            }}
            title="Fullscreen"
            style={{
              pointerEvents: "auto",
              background: "rgba(0,0,0,0.4)",
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            ⛶
          </button>
        </div>
      </div>
    </div>
  );
}
