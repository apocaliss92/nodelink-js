import { useState, useEffect } from "react";
import type {
  AvailableStream,
  CameraInfo,
  DropdownItem,
  PreviewModalState,
  StreamProfile,
} from "./types";
import { copyToClipboard } from "./utils";
import { DropdownButton } from "./DropdownButton";
import { trpcQuery, trpcMutation } from "../../api";

/** Build the stream name matching rtsp-manager's buildGo2rtcStreamName(). */
function buildStreamName(
  sanitizedCameraName: string,
  profile: string,
  channel: number,
): string {
  return channel > 0
    ? `${sanitizedCameraName}/${profile}/${channel}`
    : `${sanitizedCameraName}/${profile}`;
}

export function StreamCard({
  camera,
  stream,
  rtspProxyPort: _rtspProxyPort,
  rtspServers,
  go2rtcApiPort,
  serviceIp,
  onOpenPreview,
}: {
  camera: CameraInfo;
  stream: AvailableStream;
  rtspProxyPort: number | undefined;
  go2rtcApiPort?: number | null;
  serviceIp?: string;
  rtspServers: Array<{
    cameraId: string;
    profile: StreamProfile;
    channel: number;
    status?: string;
    connections?: number;
    go2rtcStreamName?: string;
    rtspUrl?: string;
    mode?: string;
  }>;
  onOpenPreview: (state: PreviewModalState) => void;
}) {
  const streamName = buildStreamName(
    camera.sanitizedName,
    stream.profile,
    stream.channel,
  );

  // --- Stream diagnostics state ---
  const [diagSessionId, setDiagSessionId] = useState<string | null>(null);
  const [diagStatus, setDiagStatus] = useState<string>("idle");
  const [diagProgress, setDiagProgress] = useState(0);
  const [diagError, setDiagError] = useState<string | null>(null);

  const startAnalysis = async () => {
    setDiagError(null);
    try {
      const res = await trpcMutation<{ sessionId: string }>("diagnostics.start", {
        cameraId: camera.id,
        profile: stream.profile,
        channel: stream.channel,
        durationMinutes: 5,
      });
      setDiagSessionId(res.sessionId);
      setDiagStatus("running");
      setDiagProgress(0);
    } catch (e) {
      setDiagError(e instanceof Error ? e.message : String(e));
    }
  };

  const stopAnalysis = async () => {
    if (!diagSessionId) return;
    try {
      await trpcMutation("diagnostics.stop", { sessionId: diagSessionId });
      setDiagStatus("complete");
      setDiagSessionId(null);
    } catch (e) {
      setDiagError(e instanceof Error ? e.message : String(e));
    }
  };

  // Poll diagnostics status while running
  useEffect(() => {
    if (diagStatus !== "running" || !diagSessionId) return;
    const poll = setInterval(async () => {
      try {
        const st = await trpcQuery<{ status: string; progress: number }>(
          "diagnostics.status",
          { sessionId: diagSessionId },
        );
        setDiagProgress(st.progress);
        if (st.status === "complete" || st.status === "error" || st.status === "not_found") {
          setDiagStatus(st.status === "error" ? "error" : "complete");
          setDiagSessionId(null);
          clearInterval(poll);
        }
      } catch {
        // ignore polling errors
      }
    }, 2000);
    return () => clearInterval(poll);
  }, [diagStatus, diagSessionId]);

  // Auto-clear "complete" status after 5s
  useEffect(() => {
    if (diagStatus !== "complete") return;
    const t = setTimeout(() => setDiagStatus("idle"), 5000);
    return () => clearTimeout(t);
  }, [diagStatus]);

  // Build go2rtc base URL from the port returned by the server (via go2rtc.status)
  const go2rtcHost = serviceIp || window.location.hostname;
  const go2rtcBase = go2rtcApiPort
    ? `${window.location.protocol}//${go2rtcHost}:${go2rtcApiPort}`
    : null;
  const src = encodeURIComponent(streamName);
  const hlsUrl = go2rtcBase ? `${go2rtcBase}/api/stream.m3u8?src=${src}` : "";
  const snapshotUrl = go2rtcBase ? `${go2rtcBase}/api/frame.jpeg?src=${src}` : "";
  const mp4Url = go2rtcBase ? `${go2rtcBase}/api/stream.mp4?src=${src}` : "";
  const mseUrl = go2rtcBase ? `${go2rtcBase}/stream.html?src=${src}&mode=mse` : "";

  const rtsp = rtspServers.find(
    (x) =>
      x.cameraId === camera.id &&
      x.profile === stream.profile &&
      Number(x.channel ?? 0) === Number(stream.channel),
  );
  const rtspUrl = rtsp?.rtspUrl ?? null;
  const rtspViewers =
    rtsp?.status === "running" ? Number(rtsp.connections ?? 0) : 0;

  const lensLabel =
    stream.lensType === "wide"
      ? "Wide - "
      : stream.lensType === "telephoto"
        ? "Tele - "
        : "";
  const channelSuffix = camera.isNvr
    ? ` (ch ${stream.channel})`
    : camera.deviceInfo?.isMultifocal && stream.channel > 0
      ? ` (ch ${stream.channel})`
      : "";
  const streamLabel = `${lensLabel}${stream.profile.toUpperCase()}${channelSuffix}`;
  const metaRight = `${stream.codec ?? "—"} · ${stream.resolution ?? "—"}`;


  const urlItems: DropdownItem[] = [
    {
      label: "Copy RTSP URL",
      disabled: !rtspUrl,
      onClick: () => {
        if (rtspUrl) void copyToClipboard(rtspUrl);
      },
    },
    {
      label: "Copy MP4/MSE URL",
      onClick: () => void copyToClipboard(mp4Url),
    },
    {
      label: "Copy HLS URL",
      onClick: () => void copyToClipboard(hlsUrl),
    },
    {
      label: "Copy Snapshot URL",
      onClick: () => void copyToClipboard(snapshotUrl),
    },
  ];

  const previewItems: DropdownItem[] = [
    {
      label: "WebRTC Preview",
      onClick: () =>
        onOpenPreview({
          open: true,
          kind: "webrtc",
          title: `${camera.name} ${streamLabel}`,
          cameraName: camera.sanitizedName,
          profile: stream.profile,
          streamName,
          go2rtcApiPort,
        }),
    },
    {
      label: "MSE Stream",
      onClick: () => {
        window.open(mseUrl, "_blank");
      },
    },
  ];

  return (
    <div className="streamCard">
      <div className="streamSingleRow">
        <div className="streamName" title={streamLabel}>
          {streamLabel}
        </div>
        <div className="streamRightMeta" title={metaRight}>
          {metaRight}
        </div>
      </div>

      <div className="streamViewersRow">
        <span>RTSP viewers: {rtspViewers}</span>
      </div>

      <div className="streamActionsRow">
        <DropdownButton label="URLs" items={urlItems} />
        <DropdownButton label="Preview" items={previewItems} />
      </div>

      <div className="streamActionsRow" style={{ marginTop: 4 }}>
        {diagStatus === "idle" && (
          <button className="btn" onClick={() => void startAnalysis()} title="Analyze stream for 5 minutes">
            Analyze
          </button>
        )}
        {diagStatus === "running" && (
          <>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>
              <span className="spinner" style={{ width: 10, height: 10, marginRight: 4 }} />
              Analyzing: {diagProgress}%
            </span>
            <button className="btn danger" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => void stopAnalysis()}>
              Stop
            </button>
          </>
        )}
        {diagStatus === "complete" && (
          <span className="badge ok">Analysis complete</span>
        )}
        {diagStatus === "error" && (
          <span className="badge err" title={diagError ?? undefined}>Analysis failed</span>
        )}
        {diagError && diagStatus === "idle" && (
          <span style={{ fontSize: 11, color: "var(--danger)" }}>{diagError}</span>
        )}
      </div>
    </div>
  );
}
