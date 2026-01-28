import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";

type StreamProfile = "main" | "sub" | "ext";

type CreateSessionResponse = {
  sessionId: string;
  offer: { type: "offer"; sdp: string };
};

export default function WebRTCPreviewPage() {
  const { cameraName, profile } = useParams();
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
          void fetch(`/api/webrtc/session/${sessionId}/ice`, {
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

        const createRes = await fetch("/api/webrtc/session", {
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

        const answerRes = await fetch(
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
        void fetch(`/api/webrtc/session/${sessionId}`, {
          method: "DELETE",
        }).catch(() => {
          // ignore
        });
      }
    };
  }, [cameraName, safeProfile]);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <div style={{ fontWeight: 800 }}>WebRTC Preview</div>
          <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 2 }}>
            {cameraName} · {safeProfile ?? "invalid profile"}
          </div>
        </div>
        <div className="badge">{status}</div>
      </div>

      {error ? (
        <div style={{ marginTop: 10, color: "#fecaca" }}>{error}</div>
      ) : null}

      <div
        style={{
          marginTop: 12,
          borderRadius: 12,
          overflow: "hidden",
          border: "1px solid var(--border)",
          background: "rgba(0,0,0,0.35)",
          aspectRatio: "16/9",
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          controls
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      </div>
    </div>
  );
}
