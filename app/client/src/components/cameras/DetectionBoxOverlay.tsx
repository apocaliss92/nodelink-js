import { useEffect, useRef, useState } from "react";

/**
 * Detection bounding-box overlay.
 *
 * Subscribes to `/api/events/detection` (the per-frame SSE firehose populated
 * by `api.onDetection` on the server), filters by camera+profile, and draws
 * the boxes on a transparent `<canvas>` sized to the underlying `<video>`.
 *
 * Coordinates are received in normalized `[0, 1]` fractions of the camera's
 * AI processing frame (typically 896×480 for sub-streams). They render
 * correctly on top of any video resolution because we multiply by the live
 * client-rect size of the `<video>` element.
 *
 * Stale boxes are cleared after `STALE_MS` to avoid leftover overlays when
 * detection stops mid-track.
 */

const STALE_MS = 250;
const BOX_LABEL_BG = "rgba(0, 0, 0, 0.65)";
const BOX_THICKNESS = 3;
const DEFAULT_BOX_COLOR = "#fde047"; // tailwind yellow-300

/**
 * Class-specific stroke colors matching common camera-app conventions.
 * Reolink itself uses yellow for everything; we differentiate so the user
 * can tell categories apart at a glance.
 */
const LABEL_COLOR: Record<string, string> = {
  people: "#22d3ee",   // cyan
  vehicle: "#a78bfa",  // violet
  animal: "#fb923c",   // orange
  face: "#f472b6",     // pink
};

interface DetectionPayload {
  cameraId: string;
  cameraName: string;
  cameraNameSlug: string;
  channel: number;
  profile: "main" | "sub" | "ext";
  microseconds: number;
  frameWidth?: number;
  frameHeight?: number;
  boxes: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    /** Class label decoded from the SDK static map (people / vehicle / animal / face). */
    label?: string;
    confidence?: number;
  }>;
  decodeState: "invalid-marker" | "no-overlay" | "overlay-undecoded" | "overlay-decoded";
  timestamp: number;
}

export interface DetectionBoxOverlayProps {
  /**
   * Media element to position the overlay above. Accepts both `<video>` (used
   * for RTP / H.264) and `<canvas>` (used for the WebCodecs H.265 fallback) —
   * the overlay only needs `getBoundingClientRect()` and works for either.
   */
  videoEl: HTMLElement | null;
  /** Filter incoming detections by this camera id. */
  cameraId: string;
  /** Filter by stream profile. */
  profile: "main" | "sub" | "ext";
}

export function DetectionBoxOverlay({
  videoEl,
  cameraId,
  profile,
}: DetectionBoxOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastEventRef = useRef<DetectionPayload | null>(null);
  const [connected, setConnected] = useState(false);

  // Resize the canvas to the video bounds and redraw the most recent boxes.
  useEffect(() => {
    if (!videoEl || !canvasRef.current) return;
    const canvas = canvasRef.current;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const rect = videoEl.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.max(1, Math.round(rect.width * dpr));
      const targetH = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== targetW) canvas.width = targetW;
      if (canvas.height !== targetH) canvas.height = targetH;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const evt = lastEventRef.current;
      if (!evt) return;
      if (Date.now() - evt.timestamp > STALE_MS) {
        lastEventRef.current = null;
        return;
      }

      ctx.lineWidth = BOX_THICKNESS;
      ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
      ctx.textBaseline = "top";

      for (const b of evt.boxes) {
        const x = b.x * rect.width;
        const y = b.y * rect.height;
        const w = b.width * rect.width;
        const h = b.height * rect.height;
        const color =
          (b.label && LABEL_COLOR[b.label]) || DEFAULT_BOX_COLOR;
        ctx.strokeStyle = color;
        ctx.strokeRect(x, y, w, h);

        const label = [
          b.label,
          b.confidence !== undefined ? `${Math.round(b.confidence * 100)}%` : undefined,
        ]
          .filter(Boolean)
          .join(" ");
        if (label) {
          const padding = 4;
          const metrics = ctx.measureText(label);
          const labelH = 16;
          const labelW = metrics.width + padding * 2;
          ctx.fillStyle = BOX_LABEL_BG;
          ctx.fillRect(x, Math.max(0, y - labelH), labelW, labelH);
          ctx.fillStyle = color;
          ctx.fillText(label, x + padding, Math.max(0, y - labelH) + 2);
        }
      }
    };

    let raf = 0;
    const tick = () => {
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoEl]);

  // SSE subscription. We open a single EventSource per overlay instance and
  // filter client-side by camera+profile.
  useEffect(() => {
    const es = new EventSource("/api/events/detection", { withCredentials: true });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const payload = JSON.parse(msg.data) as DetectionPayload;
        if (payload.cameraId !== cameraId) return;
        if (payload.profile !== profile) return;
        if (!payload.boxes || payload.boxes.length === 0) {
          // Keep the stale-timeout logic in charge of clearing; don't blank the
          // canvas on every "overlay-undecoded" tick or we'd flicker.
          return;
        }
        lastEventRef.current = payload;
      } catch {
        // ignore malformed messages
      }
    };
    return () => {
      es.close();
      setConnected(false);
    };
  }, [cameraId, profile]);

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
      {/* Tiny indicator so the user can see when the firehose is connected. */}
      <div
        style={{
          position: "absolute",
          right: 6,
          top: 6,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: connected ? "#10b981" : "#6b7280",
          opacity: 0.7,
          pointerEvents: "none",
        }}
      />
    </>
  );
}
