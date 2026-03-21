import { useEffect, useRef, useState } from "react";

type StreamKind = "mjpeg" | "webrtc" | "hls";

interface StreamPlayerProps {
  kind: StreamKind;
  src: string;
  className?: string;
  autoPlay?: boolean;
}

// ---------------------------------------------------------------------------
// HLS player
// ---------------------------------------------------------------------------
function HlsPlayer({
  url,
  autoPlay,
  videoRef,
  setStatus,
  setError,
}: {
  url: string;
  autoPlay: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  setStatus: (s: string) => void;
  setError: (e: string | null) => void;
}) {
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hlsInstance: import("hls.js").default | null = null;
    let closed = false;

    const cleanup = () => {
      try {
        if (hlsInstance) hlsInstance.destroy();
      } catch {
        // ignore
      }
      hlsInstance = null;
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

        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          setStatus("Loading…");
          video.src = url;
          if (autoPlay) await video.play().catch(() => {});
          setStatus("Playing");
          return;
        }

        const { default: Hls } = await import("hls.js");

        if (!Hls.isSupported()) {
          setError("HLS playback is not supported in this browser.");
          setStatus("Unsupported");
          return;
        }

        setStatus("Attaching…");
        hlsInstance = new Hls({ lowLatencyMode: true });

        hlsInstance.on(Hls.Events.ERROR, (_evt, data) => {
          if (closed) return;
          if (!data?.fatal) return;
          setError(String(data?.details ?? data?.type ?? "HLS error"));
          setStatus("Error");
        });

        hlsInstance.attachMedia(video);
        hlsInstance.on(Hls.Events.MEDIA_ATTACHED, () => {
          if (closed || !hlsInstance) return;
          setStatus("Loading…");
          hlsInstance.loadSource(url);
        });
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
          if (closed) return;
          if (autoPlay) void video.play().catch(() => {});
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
  }, [url, autoPlay, videoRef, setStatus, setError]);

  return null;
}

// ---------------------------------------------------------------------------
// WebRTC player (WHEP signaling via go2rtc)
//
// When kind="webrtc", `src` is expected to be a full WHEP URL, e.g.:
//   http://<host>:<go2rtcApiPort>/api/webrtc?src=<streamName>
// ---------------------------------------------------------------------------
function WebRTCPlayer({
  whepUrl,
  autoPlay,
  videoRef,
  setStatus,
  setError,
}: {
  whepUrl: string;
  autoPlay: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  setStatus: (s: string) => void;
  setError: (e: string | null) => void;
}) {
  const pcRef = useRef<RTCPeerConnection | null>(null);

  useEffect(() => {
    let closed = false;

    const start = async () => {
      try {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pcRef.current = pc;

        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });

        pc.ontrack = (ev) => {
          const video = videoRef.current;
          if (video && ev.streams[0]) {
            video.srcObject = ev.streams[0];
            if (autoPlay) void video.play().catch(() => {});
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
      pcRef.current = null;
      if (pc) pc.close();
    };
  }, [whepUrl, autoPlay, videoRef, setStatus, setError]);

  return null;
}

// ---------------------------------------------------------------------------
// StreamPlayer — unified entry point
// ---------------------------------------------------------------------------
export function StreamPlayer({
  kind,
  src,
  className,
  autoPlay = true,
}: StreamPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<string>(
    kind === "webrtc" ? "Connecting..." : "Initializing…",
  );
  const [error, setError] = useState<string | null>(null);

  // MJPEG: plain <img> — no status/error overlay needed
  if (kind === "mjpeg") {
    return (
      <div
        className={
          className ??
          "rounded-xl overflow-hidden border border-[var(--border)] bg-black/35"
        }
      >
        <img src={src} alt="MJPEG stream" className="w-full block" />
      </div>
    );
  }

  return (
    <div
      className={
        className ??
        "rounded-xl overflow-hidden border border-[var(--border)] bg-black/35"
      }
    >
      {kind === "hls" && (
        <HlsPlayer
          url={src}
          autoPlay={autoPlay}
          videoRef={videoRef}
          setStatus={setStatus}
          setError={setError}
        />
      )}
      {kind === "webrtc" && (
        <WebRTCPlayer
          whepUrl={src}
          autoPlay={autoPlay}
          videoRef={videoRef}
          setStatus={setStatus}
          setError={setError}
        />
      )}
      <video
        ref={videoRef}
        controls
        muted
        playsInline
        autoPlay={autoPlay}
        className="w-full block max-h-[70vh] bg-black"
      />
      <div className="px-2.5 py-2 text-xs text-[var(--muted)]">{status}</div>
      {error && (
        <div className="px-2.5 pb-2.5 text-xs text-[#fecaca]">{error}</div>
      )}
    </div>
  );
}
