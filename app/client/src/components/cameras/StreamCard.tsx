import type {
  AvailableStream,
  CameraInfo,
  DropdownItem,
  PreviewModalState,
  StreamProfile,
} from "./types";
import { copyToClipboard } from "./utils";
import { DropdownButton } from "./DropdownButton";

/** Build the stream name matching rtsp-manager's buildGo2rtcStreamName(). */
function buildStreamName(
  sanitizedCameraName: string,
  profile: string,
  channel: number,
): string {
  return channel > 0
    ? `${sanitizedCameraName}_${profile}_ch${channel}`
    : `${sanitizedCameraName}_${profile}`;
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
    </div>
  );
}
