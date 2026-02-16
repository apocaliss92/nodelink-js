import type {
  AvailableStream,
  CameraInfo,
  DropdownItem,
  PreviewModalState,
  StreamProfile,
} from "./types";
import { copyToClipboard, streamKey, withAuthTokenQuery } from "./utils";
import { DropdownButton } from "./DropdownButton";

export function StreamCard({
  camera,
  stream,
  rtspProxyPort,
  rtspServers,
  mjpegStatus,
  webrtcStatus,
  hlsStatus,
  onOpenPreview,
}: {
  camera: CameraInfo;
  stream: AvailableStream;
  rtspProxyPort: number | undefined;
  rtspServers: Array<{
    cameraId: string;
    profile: StreamProfile;
    channel: number;
    status?: string;
    connections?: number;
  }>;
  mjpegStatus: Array<{ cameraId: string; profile: StreamProfile; clients: number }>;
  webrtcStatus: Array<{
    sessionId: string;
    cameraId: string;
    profile: StreamProfile;
    state: string;
  }>;
  hlsStatus: Array<{ cameraId: string; profile: StreamProfile; clients: number }>;
  onOpenPreview: (state: PreviewModalState) => void;
}) {
  const k = streamKey(camera.id, stream.profile, stream.channel);
  const rtspUrl =
    rtspProxyPort && camera.sanitizedName
      ? `rtsp://${window.location.hostname}:${rtspProxyPort}${
          stream.channel > 0
            ? `/${camera.sanitizedName}/${stream.profile}/${stream.channel}`
            : `/${camera.sanitizedName}/${stream.profile}`
        }`
      : null;
  const mjpegUrl = withAuthTokenQuery(
    `${window.location.origin}/api/mpeg/${camera.sanitizedName}/${stream.profile}`,
  );
  const mjpegPreviewUrl = mjpegUrl;
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
  const streamName = `${lensLabel}${stream.profile.toUpperCase()}${channelSuffix}`;
  const metaRight = `${stream.codec ?? "—"} · ${stream.resolution ?? "—"}`;

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
  ];

  const previewItems: DropdownItem[] = [
    {
      label: "WebRTC",
      onClick: () =>
        onOpenPreview({
          open: true,
          kind: "webrtc",
          title: `${camera.name} ${streamName}`,
          cameraName: camera.sanitizedName,
          profile: stream.profile,
          mjpegUrl: mjpegPreviewUrl,
        }),
    },
    {
      label: "MJPEG",
      onClick: () =>
        onOpenPreview({
          open: true,
          kind: "mjpeg",
          title: `${camera.name} ${streamName}`,
          cameraName: camera.sanitizedName,
          profile: stream.profile,
          mjpegUrl: mjpegPreviewUrl,
        }),
    },
  ];

  const rtsp = rtspServers.find(
    (x) =>
      x.cameraId === camera.id &&
      x.profile === stream.profile &&
      Number(x.channel ?? 0) === Number(stream.channel),
  );
  const rtspViewers =
    rtsp?.status === "running" ? Number(rtsp.connections ?? 0) : 0;
  const mjpegViewers = Number(
    mjpegStatus.find(
      (x) => x.cameraId === camera.id && x.profile === stream.profile,
    )?.clients ?? 0,
  );
  const webrtcViewers = webrtcStatus.filter(
    (x) => x.cameraId === camera.id && x.profile === stream.profile,
  ).length;
  const hlsViewers = Number(
    hlsStatus.find(
      (x) => x.cameraId === camera.id && x.profile === stream.profile,
    )?.clients ?? 0,
  );

  return (
    <div className="streamCard">
      <div className="streamSingleRow">
        <div className="streamName" title={streamName}>
          {streamName}
        </div>
        <div className="streamRightMeta" title={metaRight}>
          {metaRight}
        </div>
      </div>

      <div className="streamViewersRow">
        <span>
          Viewers: RTSP {rtspViewers} · MJPEG {mjpegViewers} · WebRTC{" "}
          {webrtcViewers} · HLS {hlsViewers}
        </span>
      </div>

      <div className="streamActionsRow">
        <DropdownButton label="URLs" items={urlItems} />
        <DropdownButton label="Preview" items={previewItems} />
      </div>
    </div>
  );
}
