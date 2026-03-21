import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getStoredAuthToken } from "../authToken";

type StreamProfile = "main" | "sub" | "ext";

type CreateSessionResponse = {
  sessionId: string;
  offer: { type: "offer"; sdp: string };
};

function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  const token = getStoredAuthToken();
  const headers = new Headers(init?.headers ?? undefined);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

export default function WebRTCPreviewPage() {
  const { cameraName, profile } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<string>("Initializing…");
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  const safeProfile: StreamProfile | null = useMemo(() => {
    if (profile === "main" || profile === "sub" || profile === "ext")
      return profile;
    return null;
  }, [profile]);

  useEffect(() => {
    if (!cameraName || !safeProfile) {
      setError("Missing or invalid cameraName/profile");
      return;
    }

    let pc: RTCPeerConnection | null = null;
    let sessionId: string | null = null;
    let closed = false;

    const run = async () => {
      try {
        setStatus("Creating WebRTC session…");

        pc = new RTCPeerConnection({
          iceServers: [],
        });

        pc.ontrack = (ev) => {
          const stream = ev.streams?.[0];
          if (!stream) return;
          const video = videoRef.current;
          if (!video) return;
          video.srcObject = stream;
        };

        pc.onicecandidate = (ev) => {
          if (!ev.candidate || !sessionId || closed) return;
          void apiFetch(`/api/webrtc/session/${sessionId}/ice`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(ev.candidate),
          }).catch(() => {
            // best-effort
          });
        };

        // Receive-only
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });

        const createRes = await apiFetch("/api/webrtc/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cameraName,
            profile: safeProfile,
            enableIntercom: false,
          }),
        });

        if (!createRes.ok) {
          throw new Error(
            `Create session failed: ${createRes.status} ${await createRes.text()}`,
          );
        }

        const created = (await createRes.json()) as CreateSessionResponse;
        sessionId = created.sessionId;

        setStatus("Negotiating…");
        await pc.setRemoteDescription(created.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const answerRes = await apiFetch(
          `/api/webrtc/session/${sessionId}/answer`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "answer", sdp: answer.sdp }),
          },
        );

        if (!answerRes.ok) {
          throw new Error(
            `Send answer failed: ${answerRes.status} ${await answerRes.text()}`,
          );
        }

        setStatus("Connected (waiting for media)…");
      } catch (e) {
        setError(String(e));
        setStatus("Error");
      }
    };

    void run();

    return () => {
      closed = true;
      try {
        pc?.close();
      } catch {
        // ignore
      }
      if (sessionId) {
        void apiFetch(`/api/webrtc/session/${sessionId}`, {
          method: "DELETE",
        }).catch(() => {
          // ignore
        });
      }
    };
  }, [cameraName, safeProfile]);

  return (
    <div className="flex flex-col h-screen bg-black text-[var(--color-foreground)]">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-background-elevated)]">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1.5 border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] px-3 py-1.5 rounded-[10px] cursor-pointer text-xs hover:bg-[var(--color-surface-hover)] transition-colors"
          >
            ← Back
          </button>
          <div>
            <div className="font-extrabold text-sm">WebRTC Preview</div>
            <div className="text-[var(--color-foreground-muted)] text-[11px] mt-0.5">
              {cameraName} · {safeProfile ?? "invalid profile"}
            </div>
          </div>
        </div>
        <span className="text-xs px-2 py-1 rounded-full border border-[var(--color-border)] bg-white/[0.04] text-[var(--color-foreground-muted)]">
          {status}
        </span>
      </div>

      {/* Error message */}
      {error && (
        <div className="px-4 py-2 text-red-200 text-sm bg-red-500/10 border-b border-red-500/20">
          {error}
        </div>
      )}

      {/* Video area */}
      <div className="flex-1 flex items-center justify-center bg-black min-h-0">
        <div className="w-full h-full aspect-video max-h-full overflow-hidden rounded-xl border border-[var(--color-border)] bg-black">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            controls
            className="w-full h-full block object-contain"
          />
        </div>
      </div>
    </div>
  );
}
