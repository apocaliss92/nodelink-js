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
  serviceIp,
}: {
  streamName: string;
  go2rtcApiPort?: number | null;
  serviceIp?: string;
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

        // Receive video + audio.
        // Restrict video to H.264 only: Chrome cannot decode H.265 over WebRTC.
        // By limiting codec preferences we force go2rtc to select the ffmpeg-transcoded
        // H.264 source for H.265 cameras, rather than sending raw H.265 which the browser
        // accepts in the SDP answer but cannot actually play.
        const videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
        try {
          const caps = RTCRtpReceiver.getCapabilities("video");
          const h264Only = (caps?.codecs ?? []).filter(
            (c) => c.mimeType.toLowerCase() === "video/h264",
          );
          if (h264Only.length > 0) {
            videoTransceiver.setCodecPreferences(h264Only);
          }
        } catch {
          // setCodecPreferences not supported — fall through with default offer
        }
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

        // WHEP: POST SDP offer to go2rtc.
        // Over HTTPS (nginx reverse proxy) we must route through the Express /go2rtc/* proxy
        // because go2rtc itself only speaks plain HTTP — a direct https://host:port request
        // would fail with ERR_SSL_PROTOCOL_ERROR. Over HTTP (local) we can hit go2rtc directly.
        if (!go2rtcApiPort) throw new Error("go2rtc API port not available yet");
        const isHttps = window.location.protocol === "https:";
        let whepUrl: string;
        if (isHttps) {
          whepUrl = `/go2rtc/api/webrtc?src=${encodeURIComponent(streamName)}`;
        } else {
          const go2rtcHost = serviceIp || window.location.hostname;
          whepUrl = `http://${go2rtcHost}:${go2rtcApiPort}/api/webrtc?src=${encodeURIComponent(streamName)}`;
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
