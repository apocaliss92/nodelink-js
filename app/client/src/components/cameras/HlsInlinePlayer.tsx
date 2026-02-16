import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

export function HlsInlinePlayer({ url }: { url: string }) {
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

        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          setStatus("Loading…");
          video.src = url;
          await video.play().catch(() => {});
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
          void video.play().catch(() => {});
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
