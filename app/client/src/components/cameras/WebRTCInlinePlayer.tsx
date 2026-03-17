import { useEffect, useRef, useState } from "react";

/**
 * WebRTC player that uses go2rtc's WHEP (synchronous HTTP) signaling.
 *
 * Flow:
 *   1. Create RTCPeerConnection with recvonly transceivers
 *   2. Generate SDP offer
 *   3. POST offer to /go2rtc/api/webrtc?src={streamName} (Content-Type: application/sdp)
 *   4. Receive SDP answer with ICE candidates already included
 *   5. Set remote description → media flows
 */
export function WebRTCInlinePlayer({
  streamName,
  go2rtcApiPort,
}: {
  streamName: string;
  go2rtcApiPort?: number | null;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [status, setStatus] = useState<string>("Connecting...");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let closed = false;

    const start = async () => {
      try {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pcRef.current = pc;

        // Receive video + audio
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });

        // Attach media stream to video element
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
          if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
            setStatus("Streaming");
          }
        };

        // Create offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        if (closed) return;
        setStatus("Signaling...");

        // WHEP: POST SDP offer to go2rtc, get SDP answer back
        const go2rtcBase = go2rtcApiPort
          ? `${window.location.protocol}//${window.location.hostname}:${go2rtcApiPort}`
          : `${window.location.origin}/go2rtc`;
        const whepUrl = `${go2rtcBase}/api/webrtc?src=${encodeURIComponent(streamName)}`;
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

        await pc.setRemoteDescription({
          type: "answer",
          sdp: sdpAnswer,
        });

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
      if (pc) {
        pc.close();
      }
    };
  }, [streamName]);

  return (
    <div>
      {error && (
        <div
          style={{
            color: "#ef4444",
            fontSize: 13,
            marginBottom: 8,
            padding: "6px 10px",
            background: "rgba(239,68,68,0.1)",
            borderRadius: 6,
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
        }}
      >
        {status}
      </div>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        controls
        style={{
          width: "100%",
          maxHeight: "70vh",
          borderRadius: 8,
          background: "#000",
        }}
      />
    </div>
  );
}
