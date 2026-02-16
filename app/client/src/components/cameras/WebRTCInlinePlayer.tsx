import { useEffect, useRef, useState } from "react";
import type { StreamProfile } from "./types";
import { apiFetch } from "./utils";

export function WebRTCInlinePlayer({
  cameraName,
  profile,
}: {
  cameraName: string;
  profile: StreamProfile;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  const [status, setStatus] = useState<string>("Initializing…");
  const [error, setError] = useState<string | null>(null);
  const [codec, setCodec] = useState<"H264" | "H265" | null>(null);

  useEffect(() => {
    let pc: RTCPeerConnection | null = null;
    let sessionId: string | null = null;
    let closed = false;
    const abort = new AbortController();

    let pendingChunks: {
      chunks: Uint8Array[];
      received: number;
      totalChunks: number;
    } | null = null;
    let receivedFirstKeyframe = false;

    const closeDecoder = () => {
      const d = decoderRef.current;
      decoderRef.current = null;
      if (d) {
        try {
          d.close();
        } catch {
          // ignore
        }
      }
    };

    const ensureCanvasSized = (w: number, h: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvas.style.aspectRatio = `${w} / ${h}`;
    };

    const initVideoDecoder = async (
      codecType: "H264" | "H265",
      w: number,
      h: number,
    ) => {
      if (closed) return;
      closeDecoder();
      receivedFirstKeyframe = false;

      if (typeof (globalThis as any).VideoDecoder === "undefined") {
        setError(
          `${codecType} WebRTC requires WebCodecs (VideoDecoder). Use Chrome/Edge and enable WebCodecs if needed.`,
        );
        return;
      }

      const codedWidth = w > 0 ? w : 1920;
      const codedHeight = h > 0 ? h : 1080;
      ensureCanvasSized(codedWidth, codedHeight);

      const codecString =
        codecType === "H265" ? "hev1.1.6.L93.B0" : "avc1.640028";

      const config: VideoDecoderConfig = {
        codec: codecString,
        codedWidth,
        codedHeight,
        optimizeForLatency: true,
      };

      try {
        const support = await VideoDecoder.isConfigSupported(config);
        if (!support.supported) {
          setError(
            `This browser does not support ${codecType} decoding via WebCodecs.`,
          );
          return;
        }
      } catch (e) {
        setError(`Failed to probe WebCodecs support: ${String(e)}`);
        return;
      }

      const decoder = new VideoDecoder({
        output: (frame) => {
          const canvas = canvasRef.current;
          if (!canvas) {
            frame.close();
            return;
          }
          try {
            ensureCanvasSized(frame.codedWidth, frame.codedHeight);
            const ctx = canvas.getContext("2d");
            if (ctx) ctx.drawImage(frame, 0, 0);
          } finally {
            frame.close();
          }
        },
        error: (e) => {
          if (closed) return;
          setError(`${codecType} decoder error: ${String(e)}`);
        },
      });

      decoder.configure(config);
      decoderRef.current = decoder;
    };

    const run = async () => {
      try {
        setStatus("Creating WebRTC session…");
        setError(null);
        setCodec(null);

        pc = new RTCPeerConnection({ iceServers: [] });

        pc.onconnectionstatechange = () => {
          if (closed || !pc) return;
          setStatus(`Connection: ${pc.connectionState}`);
        };

        pc.oniceconnectionstatechange = () => {
          if (closed || !pc) return;
          if (
            pc.iceConnectionState === "failed" ||
            pc.iceConnectionState === "disconnected"
          ) {
            setStatus(`ICE: ${pc.iceConnectionState}`);
          }
        };

        const mediaStream = new MediaStream();

        pc.ontrack = (ev) => {
          const video = videoRef.current;
          if (!video) return;

          mediaStream.addTrack(ev.track);

          if (video.srcObject !== mediaStream) {
            video.srcObject = mediaStream;
            void video.play().catch(() => {});
          }
        };

        pc.ondatachannel = (ev) => {
          const ch = ev.channel;
          if (ch.label !== "video") return;
          ch.binaryType = "arraybuffer";

          ch.onmessage = (msgEv) => {
            if (closed) return;

            if (typeof msgEv.data === "string") {
              try {
                const msg = JSON.parse(msgEv.data) as any;
                if (
                  msg?.type === "codec" &&
                  (msg.codec === "H264" || msg.codec === "H265")
                ) {
                  setCodec(msg.codec);
                  if (msg.codec === "H265") {
                    void initVideoDecoder(
                      msg.codec,
                      Number(msg.width ?? 0),
                      Number(msg.height ?? 0),
                    );
                  }
                }
              } catch {
                // ignore
              }
              return;
            }

            if (!(msgEv.data instanceof ArrayBuffer)) return;
            const arr = new Uint8Array(msgEv.data);
            if (arr.length < 4) return;

            const possibleChunkIndex = arr[0] ?? 0;
            const possibleTotalChunks = arr[1] ?? 0;
            const looksChunked =
              possibleTotalChunks > 1 &&
              possibleTotalChunks < 128 &&
              possibleChunkIndex < possibleTotalChunks;

            const handlePacket = (packet: Uint8Array) => {
              if (packet.length < 12) return;
              const view = new DataView(
                packet.buffer,
                packet.byteOffset,
                packet.byteLength,
              );
              const timestampMs = view.getUint32(4);
              const isKeyframe = view.getUint8(9) === 1;
              const annexB = packet.subarray(12);

              const decoder = decoderRef.current;
              if (!decoder || decoder.state !== "configured") return;

              if (!receivedFirstKeyframe) {
                if (!isKeyframe) return;
                receivedFirstKeyframe = true;
              }

              try {
                const chunk = new EncodedVideoChunk({
                  type: isKeyframe ? "key" : "delta",
                  timestamp: timestampMs * 1000,
                  data: annexB,
                });
                decoder.decode(chunk);
              } catch (e) {
                receivedFirstKeyframe = false;
                setError(`Video decode failed: ${String(e)}`);
              }
            };

            if (looksChunked) {
              const chunkData = arr.subarray(2);
              if (possibleChunkIndex === 0) {
                pendingChunks = {
                  chunks: new Array(possibleTotalChunks),
                  received: 0,
                  totalChunks: possibleTotalChunks,
                };
              }
              if (
                !pendingChunks ||
                pendingChunks.totalChunks !== possibleTotalChunks
              )
                return;
              if (!pendingChunks.chunks[possibleChunkIndex]) {
                pendingChunks.chunks[possibleChunkIndex] = chunkData;
                pendingChunks.received++;
              }
              if (pendingChunks.received === pendingChunks.totalChunks) {
                const totalLength = pendingChunks.chunks.reduce(
                  (sum, c) => sum + (c ? c.length : 0),
                  0,
                );
                const packet = new Uint8Array(totalLength);
                let off = 0;
                for (const c of pendingChunks.chunks) {
                  if (!c) continue;
                  packet.set(c, off);
                  off += c.length;
                }
                pendingChunks = null;
                handlePacket(packet);
              }
              return;
            }

            handlePacket(arr);
          };
        };

        pc.onicecandidate = (ev) => {
          if (!ev.candidate || !sessionId || closed) return;
          void apiFetch(`/api/webrtc/session/${sessionId}/ice`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(ev.candidate),
            signal: abort.signal,
          }).catch(() => {});
        };

        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });

        const createRes = await apiFetch(`/api/webrtc/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cameraName, profile, enableIntercom: false }),
          signal: abort.signal,
        });

        if (!createRes.ok) {
          throw new Error(
            `Create session failed: ${createRes.status} ${await createRes.text()}`,
          );
        }

        if (closed) return;

        const created = (await createRes.json()) as {
          sessionId: string;
          offer: { type: "offer"; sdp: string };
        };
        sessionId = created.sessionId;

        if (closed) return;

        setStatus("Negotiating…");
        await pc.setRemoteDescription(created.offer);
        if (closed) return;
        const answer = await pc.createAnswer();
        if (closed) return;
        await pc.setLocalDescription(answer);
        if (closed) return;

        const answerRes = await apiFetch(
          `/api/webrtc/session/${sessionId}/answer`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "answer", sdp: answer.sdp }),
            signal: abort.signal,
          },
        );

        if (!answerRes.ok) {
          throw new Error(
            `Send answer failed: ${answerRes.status} ${await answerRes.text()}`,
          );
        }

        if (closed) return;

        setStatus("Connected (waiting for media)…");
      } catch (e) {
        if (closed) return;
        setError(String(e));
        setStatus("Error");
      }
    };

    void run();

    return () => {
      closed = true;
      abort.abort();
      closeDecoder();
      try {
        pc?.close();
      } catch {
        // ignore
      }
      if (sessionId) {
        void apiFetch(`/api/webrtc/session/${sessionId}`, {
          method: "DELETE",
        }).catch(() => {});
      }
    };
  }, [cameraName, profile]);

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div style={{ color: "var(--muted)", fontSize: 12 }}>{status}</div>
        {error ? (
          <div style={{ color: "#fecaca", fontSize: 12 }}>{error}</div>
        ) : null}
      </div>
      <div className="previewBox" style={{ marginTop: 10 }}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          controls
          style={{
            width: "100%",
            height: "100%",
            display: codec === "H265" ? "none" : "block",
          }}
        />
        <canvas
          ref={canvasRef}
          style={{
            width: "100%",
            height: "100%",
            display: codec === "H265" ? "block" : "none",
            background: "black",
          }}
        />
      </div>
    </>
  );
}
