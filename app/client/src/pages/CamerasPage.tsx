import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { trpcMutation, trpcQuery } from "../api";

type StreamProfile = "main" | "sub" | "ext";

type AvailableStream = {
  id: string;
  profile: StreamProfile;
  channel: number;
  resolution?: string;
  codec?: string;
};

type RtspStreamConfig = {
  profile: StreamProfile;
  channel: number;
  enabled: boolean;
  autoStart: boolean;
  port?: number;
  token?: string;
};

type CameraInfo = {
  id: string;
  name: string;
  host: string;
  port: number;
  status: "connected" | "disconnected" | "error";
  error?: string;
  deviceInfo?: {
    model?: string;
    hubModel?: string;
    channelName?: string;
    channelCount?: number;
    firmwareVersion?: string;
    serialNumber?: string;
    isNvr?: boolean;
  };
  sanitizedName: string;
  rtspChannel: number;
  isNvr: boolean;
  debugLogs: boolean;
  rtspStreams: RtspStreamConfig[];
};

type DropdownItem = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

type PreviewKind = "mjpeg" | "webrtc" | "hls";

type PreviewModalState =
  | {
      open: true;
      kind: PreviewKind;
      title: string;
      cameraName: string;
      profile: StreamProfile;
      mjpegUrl?: string;
      hlsUrl?: string;
    }
  | { open: false };

function HlsInlinePlayer({ url }: { url: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<string>("Initializing…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    let closed = false;

    const cleanup = () => {
      try {
        if (hls) hls.destroy();
      } catch {
        // ignore
      }
      hls = null;
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        // ignore
      }
    };

    const run = async () => {
      try {
        setError(null);

        // Safari (and some iOS browsers) can play HLS natively.
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          setStatus("Loading…");
          video.src = url;
          await video.play().catch(() => {
            // autoplay may be blocked; user can press play
          });
          setStatus("Playing");
          return;
        }

        if (!Hls.isSupported()) {
          setError("HLS playback is not supported in this browser.");
          setStatus("Unsupported");
          return;
        }

        setStatus("Attaching…");
        hls = new Hls({ lowLatencyMode: true });

        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (closed) return;
          if (!data?.fatal) return;
          setError(String(data?.details ?? data?.type ?? "HLS error"));
          setStatus("Error");
        });

        hls.attachMedia(video);
        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          if (closed || !hls) return;
          setStatus("Loading…");
          hls.loadSource(url);
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (closed) return;
          void video.play().catch(() => {
            // autoplay may be blocked; user can press play
          });
          setStatus("Playing");
        });
      } catch (e) {
        if (closed) return;
        setError(String(e));
        setStatus("Error");
      }
    };

    void run();

    return () => {
      closed = true;
      cleanup();
    };
  }, [url]);

  return (
    <div className="previewBox" style={{ marginTop: 10 }}>
      <video
        ref={videoRef}
        controls
        muted
        playsInline
        style={{ width: "100%", display: "block" }}
      />
      <div style={{ padding: "8px 10px", color: "var(--muted)" }}>{status}</div>
      {error ? (
        <div style={{ padding: "0 10px 10px", color: "#fecaca" }}>{error}</div>
      ) : null}
    </div>
  );
}

function WebRTCInlinePlayer({
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

      // Codec strings for WebCodecs
      // H.265: hev1.1.6.L93.B0 (common HEVC string)
      // H.264: avc1.640028 (High Profile, Level 4.0 - more compatible with IP cameras)
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
          // Useful on LAN when ICE flips quickly.
          // Keep it short to avoid noisy UI.
          if (
            pc.iceConnectionState === "failed" ||
            pc.iceConnectionState === "disconnected"
          ) {
            setStatus(`ICE: ${pc.iceConnectionState}`);
          }
        };

        // Create a single MediaStream to hold all tracks
        const mediaStream = new MediaStream();

        pc.ontrack = (ev) => {
          const video = videoRef.current;
          if (!video) return;

          // Add track to our unified stream
          mediaStream.addTrack(ev.track);

          // Set srcObject only once, or if it changed
          if (video.srcObject !== mediaStream) {
            video.srcObject = mediaStream;
            void video.play().catch(() => {
              // autoplay may be blocked; user can press play
            });
          }
        };

        pc.ondatachannel = (ev) => {
          const ch = ev.channel;
          if (ch.label !== "video") return;
          ch.binaryType = "arraybuffer";

          ch.onmessage = (msgEv) => {
            if (closed) return;

            // Codec info JSON
            if (typeof msgEv.data === "string") {
              try {
                const msg = JSON.parse(msgEv.data) as any;
                if (
                  msg?.type === "codec" &&
                  (msg.codec === "H264" || msg.codec === "H265")
                ) {
                  setCodec(msg.codec);
                  // Only initialize WebCodecs decoder for H.265
                  // H.264 uses standard RTP track (video.srcObject)
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
                  timestamp: timestampMs * 1000, // ms -> us
                  data: annexB,
                });
                decoder.decode(chunk);
              } catch (e) {
                // If decode fails, wait for next keyframe.
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
          void fetch(`/api/webrtc/session/${sessionId}/ice`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(ev.candidate),
            signal: abort.signal,
          }).catch(() => {
            // best-effort
          });
        };

        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });

        const createRes = await fetch(`/api/webrtc/session`, {
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

        const answerRes = await fetch(
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
        void fetch(`/api/webrtc/session/${sessionId}`, {
          method: "DELETE",
        }).catch(() => {
          // ignore
        });
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

function DropdownButton({
  label,
  items,
}: {
  label: string;
  items: DropdownItem[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const el = rootRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  return (
    <div className="dropdown" ref={rootRef}>
      <button
        className="btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label} ▾
      </button>
      {open ? (
        <div className="dropdownMenu" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              className="menuItem"
              role="menuitem"
              disabled={Boolean(it.disabled)}
              onClick={() => {
                if (it.disabled) return;
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type AddCameraInput = {
  name?: string;
  host: string;
  port?: number;
  username: string;
  password: string;
  isNvr: boolean;
  nvrChannel: number;
};

function statusBadge(status: CameraInfo["status"]) {
  if (status === "connected") return "badge ok";
  if (status === "error") return "badge err";
  return "badge";
}

export default function CamerasPage() {
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [connectingByCamera, setConnectingByCamera] = useState<
    Record<string, boolean>
  >({});

  const [rtspServers, setRtspServers] = useState<
    Array<{
      cameraId: string;
      profile: StreamProfile;
      channel: number;
      status: string | undefined;
      connections: number | undefined;
    }>
  >([]);

  const [mjpegStatus, setMjpegStatus] = useState<
    Array<{ cameraId: string; profile: StreamProfile; clients: number }>
  >([]);

  const [webrtcStatus, setWebrtcStatus] = useState<
    Array<{
      sessionId: string;
      cameraId: string;
      profile: StreamProfile;
      state: string;
    }>
  >([]);

  const [hlsStatus, setHlsStatus] = useState<
    Array<{ cameraId: string; profile: StreamProfile; clients: number }>
  >([]);

  const [rtspProxyStatus, setRtspProxyStatus] = useState<null | {
    enabled: boolean;
    running: boolean;
    port: number;
    host: string;
    connections: number;
  }>(null);
  const [savingProxy, setSavingProxy] = useState(false);

  const [streamsLoadingByCamera, setStreamsLoadingByCamera] = useState<
    Record<string, boolean>
  >({});

  const [streamsDiscoveryAttemptsByCamera, setStreamsDiscoveryAttemptsByCamera] =
    useState<Record<string, number>>({});

  const MAX_STREAM_DISCOVERY_ATTEMPTS = 12;
  const STREAM_DISCOVERY_RETRY_MS = 3000;

  const [previewModal, setPreviewModal] = useState<PreviewModalState>({
    open: false,
  });

  const [savingMaster, setSavingMaster] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState<AddCameraInput>({
    host: "",
    port: 9000,
    username: "",
    password: "",
    name: "",
    isNvr: false,
    nvrChannel: 0,
  });

  const [streamsByCamera, setStreamsByCamera] = useState<
    Record<string, AvailableStream[]>
  >({});

  const [savingAutoStart, setSavingAutoStart] = useState<
    Record<string, boolean>
  >({});

  // Helper to compare and update state only if changed
  function updateIfChanged<T>(
    setter: React.Dispatch<React.SetStateAction<T>>,
    newValue: NoInfer<T>,
  ) {
    setter((prev) => {
      const prevJson = JSON.stringify(prev);
      const newJson = JSON.stringify(newValue);
      return prevJson === newJson ? prev : newValue;
    });
  }

  function streamKey(
    cameraId: string,
    profile: StreamProfile,
    channel: number,
  ) {
    return `${cameraId}:${profile}:${channel}`;
  }

  function getRtspProxyUrl(
    cam: CameraInfo,
    profile: StreamProfile,
  ): string | null {
    if (!rtspProxyStatus?.port) return null;
    return `rtsp://${window.location.hostname}:${rtspProxyStatus.port}/${cam.sanitizedName}/${profile}`;
  }

  function getHttpOrigin(): string {
    // Zero-config: use the current origin (works with Docker port mapping).
    return window.location.origin;
  }

  function getMjpegUrl(cam: CameraInfo, profile: StreamProfile): string {
    return `${getHttpOrigin()}/api/mpeg/${cam.sanitizedName}/${profile}`;
  }

  function getMjpegPreviewUrl(cam: CameraInfo, profile: StreamProfile): string {
    return `${getHttpOrigin()}/api/mpeg/${cam.sanitizedName}/${profile}`;
  }

  function getHlsUrl(cam: CameraInfo, profile: StreamProfile): string {
    return `${getHttpOrigin()}/api/hls/${cam.sanitizedName}/${profile}/playlist.m3u8`;
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-1000px";
        ta.style.top = "-1000px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        // ignore
      }
    }
  }

  async function refresh(silent = false): Promise<CameraInfo[] | null> {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const [list, proxy, rtspList, mjpeg, webrtc, hls] = await Promise.all([
        trpcQuery<CameraInfo[]>("cameras.list"),
        trpcQuery<any>("rtspProxy.getStatus").catch(() => null),
        trpcQuery<any[]>("rtsp.list").catch(() => []),
        fetch("/api/mjpeg/status")
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
        fetch("/api/webrtc/status")
          .then((r) => (r.ok ? r.json() : { sessions: [] }))
          .catch(() => ({ sessions: [] })),
        fetch("/api/hls/status")
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
      ]);
      updateIfChanged(setCameras, list);

      updateIfChanged(
        setRtspServers,
        (rtspList ?? []).map((x: any) => ({
          cameraId: String(x.cameraId ?? x.cameraName ?? ""),
          profile: String(x.profile ?? "main") as StreamProfile,
          channel: Number(x.channel ?? 0),
          status: x.status ? String(x.status) : undefined,
          connections:
            x.connections === undefined ? undefined : Number(x.connections),
        })),
      );

      updateIfChanged(
        setMjpegStatus,
        (mjpeg ?? []).map((x: any) => ({
          cameraId: String(x.cameraId ?? ""),
          profile: String(x.profile ?? "main") as StreamProfile,
          clients: Number(x.clients ?? 0),
        })),
      );

      updateIfChanged(
        setWebrtcStatus,
        (webrtc?.sessions ?? []).map((x: any) => ({
          sessionId: String(x.sessionId ?? ""),
          cameraId: String(x.cameraId ?? ""),
          profile: String(x.profile ?? "main") as StreamProfile,
          state: String(x.state ?? ""),
        })),
      );

      updateIfChanged(
        setHlsStatus,
        (hls ?? []).map((x: any) => ({
          cameraId: String(x.cameraId ?? ""),
          profile: String(x.profile ?? "main") as StreamProfile,
          clients: Number(x.clients ?? 0),
        })),
      );

      if (proxy) {
        setRtspProxyStatus((prev) => {
          const newVal = {
            enabled: Boolean(proxy.enabled),
            running: Boolean(proxy.running),
            port: Number(proxy.port ?? 0),
            host: String(proxy.host ?? ""),
            connections: Number(proxy.connections ?? 0),
          };
          if (JSON.stringify(prev) === JSON.stringify(newVal)) return prev;
          return newVal;
        });
      }

      return list;
    } catch (e) {
      if (!silent) setError(String(e));
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function refreshViewersOnly() {
    try {
      const [proxy, rtspList, mjpeg, webrtc, hls] = await Promise.all([
        trpcQuery<any>("rtspProxy.getStatus").catch(() => null),
        trpcQuery<any[]>("rtsp.list").catch(() => []),
        fetch("/api/mjpeg/status")
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
        fetch("/api/webrtc/status")
          .then((r) => (r.ok ? r.json() : { sessions: [] }))
          .catch(() => ({ sessions: [] })),
        fetch("/api/hls/status")
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
      ]);

      if (proxy) {
        setRtspProxyStatus((prev) => {
          const newVal = {
            enabled: Boolean(proxy.enabled),
            running: Boolean(proxy.running),
            port: Number(proxy.port ?? 0),
            host: String(proxy.host ?? ""),
            connections: Number(proxy.connections ?? 0),
          };
          if (JSON.stringify(prev) === JSON.stringify(newVal)) return prev;
          return newVal;
        });
      }

      updateIfChanged(
        setRtspServers,
        (rtspList ?? []).map((x: any) => ({
          cameraId: String(x.cameraId ?? x.cameraName ?? ""),
          profile: String(x.profile ?? "main") as StreamProfile,
          channel: Number(x.channel ?? 0),
          status: x.status ? String(x.status) : undefined,
          connections:
            x.connections === undefined ? undefined : Number(x.connections),
        })),
      );

      updateIfChanged(
        setMjpegStatus,
        (mjpeg ?? []).map((x: any) => ({
          cameraId: String(x.cameraId ?? ""),
          profile: String(x.profile ?? "main") as StreamProfile,
          clients: Number(x.clients ?? 0),
        })),
      );

      updateIfChanged(
        setWebrtcStatus,
        (webrtc?.sessions ?? []).map((x: any) => ({
          sessionId: String(x.sessionId ?? ""),
          cameraId: String(x.cameraId ?? ""),
          profile: String(x.profile ?? "main") as StreamProfile,
          state: String(x.state ?? ""),
        })),
      );

      updateIfChanged(
        setHlsStatus,
        (hls ?? []).map((x: any) => ({
          cameraId: String(x.cameraId ?? ""),
          profile: String(x.profile ?? "main") as StreamProfile,
          clients: Number(x.clients ?? 0),
        })),
      );
    } catch {
      // best-effort
    }
  }

  useEffect(() => {
    void refresh();
    // Auto-refresh every 5 seconds (silent to avoid UI flicker)
    const t = window.setInterval(() => {
      void refresh(true);
    }, 5000);
    return () => window.clearInterval(t);
  }, []);

  // Load streams for cameras that are already connected (on initial load or when cameras change)
  useEffect(() => {
    const connected = cameras.filter(
      (c) => c.status === "connected" && !streamsByCamera[c.id],
    );
    if (connected.length === 0) return;

    const loadStreams = async () => {
      const nextLoading: Record<string, boolean> = {};
      for (const cam of connected) nextLoading[cam.id] = true;
      setStreamsLoadingByCamera((prev) => ({ ...prev, ...nextLoading }));

      const nextStreams: Record<string, AvailableStream[]> = {};
      await Promise.all(
        connected.map(async (cam) => {
          try {
            const res = await trpcQuery<{ nativeStreams: AvailableStream[] }>(
              "cameras.getAvailableStreams",
              {
                id: cam.id,
                channel: cam.isNvr ? (cam.rtspChannel ?? 0) : undefined,
              },
            );
            nextStreams[cam.id] = res.nativeStreams ?? [];
          } catch {
            nextStreams[cam.id] = [];
          }
        }),
      );
      setStreamsByCamera((prev) => ({ ...prev, ...nextStreams }));
      setStreamsLoadingByCamera((prev) => {
        const next = { ...prev };
        for (const cam of connected) next[cam.id] = false;
        return next;
      });
    };
    void loadStreams();
  }, [cameras]);

  async function discoverStreams(
    id: string,
    cameraSnapshot?: CameraInfo[] | null,
  ) {
    if (streamsLoadingByCamera[id]) return;
    const attempts = streamsDiscoveryAttemptsByCamera[id] ?? 0;
    if (attempts >= MAX_STREAM_DISCOVERY_ATTEMPTS) return;

    setStreamsLoadingByCamera((m) => ({ ...m, [id]: true }));
    try {
      const cam = (cameraSnapshot ?? cameras).find((c) => c.id === id);
      const res = await trpcQuery<{ nativeStreams: AvailableStream[] }>(
        "cameras.getAvailableStreams",
        {
          id,
          channel: cam?.isNvr ? (cam.rtspChannel ?? 0) : undefined,
        },
      );

      const discovered = res.nativeStreams ?? [];
      setStreamsByCamera((prev) => ({ ...prev, [id]: discovered }));
      setStreamsDiscoveryAttemptsByCamera((m) => ({
        ...m,
        [id]: discovered.length > 0 ? MAX_STREAM_DISCOVERY_ATTEMPTS : attempts + 1,
      }));
    } catch {
      setStreamsDiscoveryAttemptsByCamera((m) => ({ ...m, [id]: attempts + 1 }));
    } finally {
      setStreamsLoadingByCamera((m) => ({ ...m, [id]: false }));
    }
  }

  useEffect(() => {
    const t = window.setInterval(() => {
      const connected = cameras.filter((c) => c.status === "connected");
      for (const cam of connected) {
        const streams = streamsByCamera[cam.id];
        const attempts = streamsDiscoveryAttemptsByCamera[cam.id] ?? 0;
        if ((streams?.length ?? 0) > 0) continue;
        if (attempts >= MAX_STREAM_DISCOVERY_ATTEMPTS) continue;
        if (streamsLoadingByCamera[cam.id]) continue;
        void discoverStreams(cam.id);
      }
    }, STREAM_DISCOVERY_RETRY_MS);

    return () => window.clearInterval(t);
  }, [
    cameras,
    streamsByCamera,
    streamsLoadingByCamera,
    streamsDiscoveryAttemptsByCamera,
  ]);

  async function connect(id: string) {
    setConnectingByCamera((m) => ({ ...m, [id]: true }));
    setStreamsDiscoveryAttemptsByCamera((m) => ({ ...m, [id]: 0 }));
    setStreamsByCamera((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

    try {
      await trpcMutation("cameras.connect", { id });
      const list = await refresh(true);
      await discoverStreams(id, list);
    } finally {
      setConnectingByCamera((m) => ({ ...m, [id]: false }));
    }
  }

  async function disconnect(id: string) {
    await trpcMutation("cameras.disconnect", { id });
    await refresh();
  }

  async function setCameraDebug(id: string, enabled: boolean) {
    await trpcMutation("cameras.setDebug", {
      id,
      enabled,
      reconnect: true,
    });
    await refresh();
  }

  async function setAutoStartForCamera(camera: CameraInfo, autoStart: boolean) {
    const available = streamsByCamera[camera.id] ?? [];
    setSavingAutoStart((m) => ({ ...m, [camera.id]: true }));
    try {
      const unique: AvailableStream[] = [];
      const seen = new Set<string>();
      for (const s of available) {
        const k = `${s.profile}:${s.channel}`;
        if (seen.has(k)) continue;
        seen.add(k);
        unique.push(s);
      }

      // If no streams were discovered yet, don't overwrite config.
      if (unique.length === 0) return;

      const rtspStreams: RtspStreamConfig[] = unique.map((s) => ({
        profile: s.profile,
        channel: s.channel,
        enabled: true,
        autoStart,
      }));

      await trpcMutation("cameras.updateRtspStreams", {
        id: camera.id,
        rtspStreams,
      });

      await refresh();
    } finally {
      setSavingAutoStart((m) => ({ ...m, [camera.id]: false }));
    }
  }

  async function setAutoStartForAll(autoStart: boolean) {
    setSavingMaster(true);
    try {
      const connected = cameras.filter((c) => c.status === "connected");
      for (const camera of connected) {
        const available = streamsByCamera[camera.id] ?? [];
        const unique: AvailableStream[] = [];
        const seen = new Set<string>();
        for (const s of available) {
          const k = `${s.profile}:${s.channel}`;
          if (seen.has(k)) continue;
          seen.add(k);
          unique.push(s);
        }
        if (unique.length === 0) continue;

        const rtspStreams: RtspStreamConfig[] = unique.map((s) => ({
          profile: s.profile,
          channel: s.channel,
          enabled: true,
          autoStart,
        }));

        await trpcMutation("cameras.updateRtspStreams", {
          id: camera.id,
          rtspStreams,
        });
      }

      await refresh();
    } finally {
      setSavingMaster(false);
    }
  }

  async function addCamera() {
    setError(null);
    try {
      await trpcMutation("cameras.add", {
        name: adding.name || undefined,
        host: adding.host,
        port: adding.port ?? 9000,
        username: adding.username,
        password: adding.password,
        channels: 1,
        isNvr: adding.isNvr,
        rtspChannel: adding.isNvr ? Number(adding.nvrChannel || 0) : 0,
      });
      setAdding({
        host: "",
        port: 9000,
        username: "",
        password: "",
        name: "",
        isNvr: false,
        nvrChannel: 0,
      });
      setAddOpen(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteCamera(id: string) {
    if (!confirm("Delete camera?")) return;
    await trpcMutation("cameras.delete", { id });
    await refresh();
  }

  return (
    <>
      <div className="header">
        <h1 className="h1">Cameras</h1>
        <div className="row">
          <button
            className={`btn master ${
              rtspProxyStatus?.running ? "autostart on" : "autostart off"
            }`}
            disabled={
              savingProxy || loading || rtspProxyStatus?.enabled === false
            }
            onClick={async () => {
              setSavingProxy(true);
              setError(null);
              try {
                if (rtspProxyStatus?.running) {
                  await trpcMutation("rtspProxy.stop", undefined as any);
                } else {
                  await trpcMutation("rtspProxy.start", undefined as any);
                }
                await refresh();
              } catch (e) {
                setError(String(e));
              } finally {
                setSavingProxy(false);
              }
            }}
            title={
              rtspProxyStatus?.enabled === false
                ? "RTSP Proxy disabled in settings"
                : rtspProxyStatus?.running
                  ? "Stop RTSP proxy"
                  : "Start RTSP proxy"
            }
          >
            {savingProxy ? (
              <>RTSP Proxy: working…</>
            ) : (
              <>
                RTSP Proxy: {rtspProxyStatus?.running ? "ON" : "OFF"}
                {rtspProxyStatus ? ` (${rtspProxyStatus.connections})` : ""}
              </>
            )}
          </button>

          <button className="btn primary" onClick={() => setAddOpen(true)}>
            + Add camera
          </button>
        </div>
      </div>

      {error ? (
        <div
          className="card"
          style={{ borderColor: "rgba(239,68,68,0.5)", marginBottom: 12 }}
        >
          <div style={{ color: "#fecaca" }}>Error: {error}</div>
        </div>
      ) : null}

      {addOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          className="modalOverlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setAddOpen(false);
          }}
        >
          <div className="modalPanel" style={{ width: "min(720px, 100%)" }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div style={{ fontWeight: 800 }}>Add camera</div>
              <button className="btn" onClick={() => setAddOpen(false)}>
                Close
              </button>
            </div>

            <div className="grid" style={{ marginTop: 12 }}>
              <div>
                <div className="label">Name (optional)</div>
                <input
                  className="input"
                  value={adding.name ?? ""}
                  onChange={(e) =>
                    setAdding({ ...adding, name: e.target.value })
                  }
                />
              </div>

              <div className="grid cols2">
                <div>
                  <div className="label">Host</div>
                  <input
                    className="input"
                    value={adding.host}
                    onChange={(e) =>
                      setAdding({ ...adding, host: e.target.value })
                    }
                  />
                </div>
                <div>
                  <div className="label">Port</div>
                  <input
                    className="input"
                    type="number"
                    value={adding.port ?? 9000}
                    onChange={(e) =>
                      setAdding({ ...adding, port: Number(e.target.value) })
                    }
                  />
                </div>
              </div>

              <div className="grid cols2">
                <div>
                  <div className="label">Username</div>
                  <input
                    className="input"
                    value={adding.username}
                    onChange={(e) =>
                      setAdding({ ...adding, username: e.target.value })
                    }
                  />
                </div>
                <div>
                  <div className="label">Password</div>
                  <input
                    className="input"
                    type="password"
                    value={adding.password}
                    onChange={(e) =>
                      setAdding({ ...adding, password: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="grid cols2">
                <label className="row" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={adding.isNvr}
                    onChange={(e) =>
                      setAdding({ ...adding, isNvr: e.target.checked })
                    }
                  />
                  <span>Camera is part of an NVR / Hub</span>
                </label>

                {adding.isNvr ? (
                  <div>
                    <div className="label">Channel</div>
                    <input
                      className="input"
                      type="number"
                      value={adding.nvrChannel}
                      onChange={(e) =>
                        setAdding({
                          ...adding,
                          nvrChannel: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                ) : (
                  <div />
                )}
              </div>

              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button
                  className="btn primary"
                  onClick={addCamera}
                  disabled={
                    !adding.host || !adding.username || !adding.password
                  }
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {previewModal.open ? (
        <div
          role="dialog"
          aria-modal="true"
          className="modalOverlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPreviewModal({ open: false });
          }}
        >
          <div className="modalPanel" style={{ width: "min(960px, 100%)" }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 800 }}>{previewModal.title}</div>
                <div className="subtitle">
                  {previewModal.kind.toUpperCase()} · {previewModal.cameraName}{" "}
                  · {previewModal.profile}
                </div>
              </div>
              <button
                className="btn"
                onClick={() => setPreviewModal({ open: false })}
              >
                Close
              </button>
            </div>

            {previewModal.kind === "mjpeg" ? (
              <div className="previewBox" style={{ marginTop: 12 }}>
                <img
                  src={previewModal.mjpegUrl ?? ""}
                  alt={previewModal.title}
                  style={{ width: "100%", display: "block" }}
                />
              </div>
            ) : previewModal.kind === "webrtc" ? (
              <div style={{ marginTop: 12 }}>
                <WebRTCInlinePlayer
                  cameraName={previewModal.cameraName}
                  profile={previewModal.profile}
                />
              </div>
            ) : (
              <div style={{ marginTop: 12 }}>
                <HlsInlinePlayer url={previewModal.hlsUrl ?? ""} />
              </div>
            )}
          </div>
        </div>
      ) : null}

      {!loading && cameras.length === 0 ? (
        <div className="emptyState">
          <svg
            width="80"
            height="80"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: 0.4, marginBottom: 16 }}
          >
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          <h2 style={{ margin: 0, fontWeight: 600, fontSize: 20 }}>
            No cameras configured
          </h2>
          <p style={{ color: "var(--muted)", margin: "8px 0 24px" }}>
            Add your first camera to start streaming
          </p>
          <button
            className="btn primary large"
            onClick={() => setAddOpen(true)}
          >
            + Add Camera
          </button>
        </div>
      ) : (
        <div className="grid">
          {cameras.map((c) => (
            <div key={c.id} className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="row" style={{ alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontWeight: 750, lineHeight: 1.1 }}>
                      {c.name}
                    </div>
                    <div className="subtitle">
                      {c.deviceInfo?.model
                        ? c.deviceInfo.model
                        : c.isNvr
                          ? "NVR/Hub"
                          : ""}
                    </div>
                  </div>
                  <span className={statusBadge(c.status)}>{c.status}</span>
                  <span className="badge mono">
                    {c.host}:{c.port}
                  </span>
                  {c.isNvr ? (
                    <span className="badge mono">ch {c.rtspChannel}</span>
                  ) : null}
                  {c.error ? (
                    <span className="badge err">{c.error}</span>
                  ) : null}
                </div>
                <div className="row">
                  {c.status !== "connected" ? (
                    <button
                      className="btn"
                      disabled={Boolean(connectingByCamera[c.id])}
                      onClick={() => void connect(c.id)}
                    >
                      {connectingByCamera[c.id] ? (
                        <span
                          className="spinner"
                          aria-hidden="true"
                          style={{ marginLeft: 0, marginRight: 8 }}
                        />
                      ) : null}
                      {connectingByCamera[c.id] ? "Connecting…" : "Connect"}
                    </button>
                  ) : (
                    <button className="btn" onClick={() => disconnect(c.id)}>
                      Disconnect
                    </button>
                  )}

                  <button
                    className={`btn autostart ${c.debugLogs ? "on" : "off"}`}
                    title={
                      c.debugLogs
                        ? "Disable debug + reconnect"
                        : "Enable debug (general + debugRtsp + traceNativeStream + traceTalk) + reconnect"
                    }
                    onClick={() => void setCameraDebug(c.id, !c.debugLogs)}
                  >
                    Debug: {c.debugLogs ? "ON" : "OFF"}
                  </button>

                  <button
                    className={`btn autostart ${
                      (c.rtspStreams?.length ?? 0) > 0 &&
                      c.rtspStreams.every((s) => s.autoStart !== false)
                        ? "on"
                        : "off"
                    }`}
                    disabled={
                      c.status !== "connected" ||
                      Boolean(savingAutoStart[c.id]) ||
                      Boolean(streamsLoadingByCamera[c.id])
                    }
                    onClick={() => {
                      const allAuto =
                        (c.rtspStreams?.length ?? 0) > 0 &&
                        c.rtspStreams.every((s) => s.autoStart !== false);
                      void setAutoStartForCamera(c, !allAuto);
                    }}
                    title="Toggle auto-start (used on server startup when proxy is disabled)"
                  >
                    Auto-start:{" "}
                    {(c.rtspStreams?.length ?? 0) > 0 &&
                    c.rtspStreams.every((s) => s.autoStart !== false)
                      ? "ON"
                      : "OFF"}
                    {streamsLoadingByCamera[c.id] ? (
                      <span className="spinner" aria-hidden="true" />
                    ) : null}
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => deleteCamera(c.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <div className="label">Available streams</div>
                {c.status !== "connected" ? (
                  <div style={{ color: "var(--muted)", fontSize: 13 }}>
                    Connect the camera to discover streams.
                  </div>
                ) : streamsLoadingByCamera[c.id] ? (
                  <div
                    className="row"
                    style={{ color: "var(--muted)", fontSize: 13 }}
                  >
                    <span className="spinner" aria-hidden="true" />
                    <span>Discovering streams…</span>
                  </div>
                ) : (streamsByCamera[c.id]?.length ?? 0) === 0 ? (
                  (streamsDiscoveryAttemptsByCamera[c.id] ?? 0) > 0 &&
                  (streamsDiscoveryAttemptsByCamera[c.id] ?? 0) <
                    MAX_STREAM_DISCOVERY_ATTEMPTS ? (
                    <div
                      className="row"
                      style={{ color: "var(--muted)", fontSize: 13 }}
                    >
                      <span
                        className="spinner"
                        aria-hidden="true"
                        style={{ marginLeft: 0, marginRight: 8 }}
                      />
                      <span>Waiting for streams…</span>
                    </div>
                  ) : (
                    <div style={{ color: "var(--muted)", fontSize: 13 }}>
                      No streams discovered yet.
                    </div>
                  )
                ) : (
                  <div className="streamsGrid">
                    {(streamsByCamera[c.id] ?? []).map((s) => {
                      const k = streamKey(c.id, s.profile, s.channel);
                      const rtspUrl = getRtspProxyUrl(c, s.profile);
                      const mjpegUrl = getMjpegUrl(c, s.profile);
                      const mjpegPreviewUrl = getMjpegPreviewUrl(c, s.profile);
                      const hlsUrl = getHlsUrl(c, s.profile);
                      const streamName = `${s.profile.toUpperCase()}${c.isNvr ? ` (ch ${s.channel})` : s.channel ? ` (ch ${s.channel})` : ""}`;

                      const metaRight = `${s.codec ?? "—"} · ${s.resolution ?? "—"}`;

                      const urlItems: DropdownItem[] = [
                        {
                          label: "Copy RTSP",
                          disabled: !rtspUrl,
                          onClick: () => {
                            if (!rtspUrl) return;
                            void copyToClipboard(rtspUrl);
                          },
                        },
                        {
                          label: "Copy MJPEG URL",
                          onClick: () => void copyToClipboard(mjpegUrl),
                        },
                        // HLS disabled for now - needs more work
                        // {
                        //   label: "Copy HLS URL",
                        //   onClick: () => void copyToClipboard(hlsUrl),
                        // },
                      ];

                      const previewItems: DropdownItem[] = [
                        {
                          label: "WebRTC",
                          onClick: () =>
                            setPreviewModal({
                              open: true,
                              kind: "webrtc",
                              title: `${c.name} ${streamName}`,
                              cameraName: c.sanitizedName,
                              profile: s.profile,
                              mjpegUrl: mjpegPreviewUrl,
                            }),
                        },
                        {
                          label: "MJPEG",
                          onClick: () =>
                            setPreviewModal({
                              open: true,
                              kind: "mjpeg",
                              title: `${c.name} ${streamName}`,
                              cameraName: c.sanitizedName,
                              profile: s.profile,
                              mjpegUrl: mjpegPreviewUrl,
                            }),
                        },
                        // HLS disabled for now - needs more work
                        // {
                        //   label: "HLS",
                        //   onClick: () =>
                        //     setPreviewModal({
                        //       open: true,
                        //       kind: "hls",
                        //       title: `${c.name} ${streamName}`,
                        //       cameraName: c.sanitizedName,
                        //       profile: s.profile,
                        //       hlsUrl,
                        //       baseOrigin,
                        //     }),
                        // },
                      ];

                      return (
                        <div key={k} className="streamCard">
                          <div className="streamSingleRow">
                            <div className="streamName" title={streamName}>
                              {streamName}
                            </div>
                            <div className="streamRightMeta" title={metaRight}>
                              {metaRight}
                            </div>
                          </div>

                          <div className="streamViewersRow">
                            {(() => {
                              const rtsp = rtspServers.find(
                                (x) =>
                                  x.cameraId === c.id &&
                                  x.profile === s.profile &&
                                  Number(x.channel ?? 0) === Number(s.channel),
                              );
                              const rtspViewers =
                                rtsp?.status === "running"
                                  ? Number(rtsp.connections ?? 0)
                                  : 0;
                              const mjpegViewers = Number(
                                mjpegStatus.find(
                                  (x) =>
                                    x.cameraId === c.id &&
                                    x.profile === s.profile,
                                )?.clients ?? 0,
                              );
                              const webrtcViewers = webrtcStatus.filter(
                                (x) =>
                                  x.cameraId === c.id &&
                                  x.profile === s.profile,
                              ).length;

                              const hlsViewers = Number(
                                hlsStatus.find(
                                  (x) =>
                                    x.cameraId === c.id &&
                                    x.profile === s.profile,
                                )?.clients ?? 0,
                              );

                              return (
                                <span>
                                  Viewers: RTSP {rtspViewers} · MJPEG{" "}
                                  {mjpegViewers} · WebRTC {webrtcViewers} · HLS{" "}
                                  {hlsViewers}
                                </span>
                              );
                            })()}
                          </div>

                          <div className="streamActionsRow">
                            <DropdownButton label="URLs" items={urlItems} />
                            <DropdownButton
                              label="Preview"
                              items={previewItems}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
