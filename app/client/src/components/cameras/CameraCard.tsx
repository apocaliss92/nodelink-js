import { useCallback, useState } from "react";
import { trpcMutation } from "../../api";
import { DumpButton } from "./DumpButton";
import type {
  AvailableStream,
  CameraInfo,
  PreviewModalState,
  StreamProfile,
} from "./types";
import { statusBadge, streamKey } from "./utils";
import { CameraControlsSection } from "./CameraControlsSection";
import { SessionsSection } from "./SessionsSection";
import { StreamCard } from "./StreamCard";

const MAX_STREAM_DISCOVERY_ATTEMPTS = 12;

export function CameraCard({
  camera,
  streams,
  streamsLoading,
  streamsDiscoveryAttempts,
  connecting,
  savingAutoStart,
  rtspProxyPort,
  go2rtcApiPort,
  serviceIp,
  rtspServers,
  onConnect,
  onDisconnect,
  onSetDebug,
  onSetAutoStart,
  onDelete,
  onOpenPreview,
}: {
  camera: CameraInfo;
  streams: AvailableStream[];
  streamsLoading: boolean;
  streamsDiscoveryAttempts: number;
  connecting: boolean;
  savingAutoStart: boolean;
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
  rtspProxyPort?: number;
  go2rtcApiPort?: number | null;
  serviceIp?: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onSetDebug: () => void;
  onSetAutoStart: () => void;
  onDelete: () => void;
  onOpenPreview: (state: PreviewModalState) => void;
}) {
  const allAuto = camera.autoStart === true;
  const [savingBatteryMode, setSavingBatteryMode] = useState(false);

  const toggleBatteryMode = useCallback(async () => {
    setSavingBatteryMode(true);
    try {
      const next = camera.batteryMode === "alwaysOn" ? "streamOnly" : "alwaysOn";
      await trpcMutation("cameras.setBatteryMode", { id: camera.id, mode: next });
    } catch {
      // ignore
    } finally {
      setSavingBatteryMode(false);
    }
  }, [camera.id, camera.batteryMode]);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div>
            <div style={{ fontWeight: 750, lineHeight: 1.1 }}>{camera.name}</div>
            <div className="subtitle">
              {camera.deviceInfo?.model
                ? camera.deviceInfo.model
                : camera.isNvr
                  ? "NVR/Hub"
                  : ""}
            </div>
          </div>
          <span className={statusBadge(camera.status)}>{camera.status}</span>
          {!camera.nvrId && (
            <span className="badge mono">
              {camera.host}:{camera.port}
            </span>
          )}
          {camera.isNvr ? (
            <span className="badge mono">ch {camera.rtspChannel}</span>
          ) : null}
          {camera.sleepStatus ? (
            <span className={`badge ${camera.sleepStatus === "awake" ? "ok" : ""}`}>
              {camera.sleepStatus}
            </span>
          ) : null}
          {camera.error ? (
            <span className="badge err">{camera.error}</span>
          ) : null}
        </div>
        <div className="row">
          {connecting || camera.status !== "connected" ? (
            <button
              className="btn"
              disabled={connecting}
              onClick={onConnect}
            >
              {connecting ? (
                <span
                  className="spinner"
                  aria-hidden="true"
                  style={{ marginLeft: 0, marginRight: 8 }}
                />
              ) : null}
              {connecting ? "Connecting…" : "Connect"}
            </button>
          ) : (
            <button className="btn" disabled={connecting} onClick={onDisconnect}>
              Disconnect
            </button>
          )}

          <button
            className={`btn autostart ${camera.debugLogs ? "on" : "off"}`}
            disabled={connecting}
            title={
              camera.debugLogs
                ? "Disable debug + reconnect"
                : "Enable debug (general + debugRtsp + traceNativeStream + traceTalk) + reconnect"
            }
            onClick={onSetDebug}
          >
            Debug: {camera.debugLogs ? "ON" : "OFF"}
          </button>

          <button
            className={`btn autostart ${allAuto ? "on" : "off"}`}
            disabled={
              connecting ||
              camera.status !== "connected" ||
              savingAutoStart ||
              streamsLoading
            }
            onClick={onSetAutoStart}
            title="Toggle auto-start (used on server startup when proxy is disabled)"
          >
            Auto-start: {allAuto ? "ON" : "OFF"}
            {streamsLoading ? (
              <span className="spinner" aria-hidden="true" />
            ) : null}
          </button>
          {(camera.isBattery || camera.sleepStatus) && (
            <button
              className={`btn autostart ${camera.batteryMode === "alwaysOn" ? "on" : "off"}`}
              disabled={savingBatteryMode}
              onClick={() => void toggleBatteryMode()}
              title={
                camera.batteryMode === "alwaysOn"
                  ? "Always On: camera stays awake while connected"
                  : "Stream Only: camera sleeps when no stream clients"
              }
            >
              {camera.batteryMode === "alwaysOn" ? "Always On" : "Stream Only"}
            </button>
          )}
          <button
            className="btn danger"
            disabled={connecting}
            onClick={onDelete}
          >
            Delete
          </button>
          <DumpButton cameraId={camera.id} cameraName={camera.name} />
          {camera.status === "connected" && (
            <SessionsSection cameraId={camera.id} isConnected />
          )}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        {camera.status !== "connected" ? null : (streams?.length ?? 0) > 0 ? (
          <div className="streamsGrid">
            {(streams ?? []).map((s) => (
              <StreamCard
                key={streamKey(camera.id, s.profile, s.channel)}
                camera={camera}
                stream={s}
                rtspProxyPort={rtspProxyPort}
                go2rtcApiPort={go2rtcApiPort}
                serviceIp={serviceIp}
                rtspServers={rtspServers}
                onOpenPreview={onOpenPreview}
              />
            ))}
          </div>
        ) : streamsLoading ? (
          <div
            className="row"
            style={{ color: "var(--muted)", fontSize: 13 }}
          >
            <span className="spinner" aria-hidden="true" />
            <span>Discovering streams…</span>
          </div>
        ) : camera.sleepStatus === "sleeping" ? (
          <div style={{ color: "var(--muted)", fontSize: 13 }}>
            Camera is sleeping. Streams will be discovered when it wakes up.
          </div>
        ) : streamsDiscoveryAttempts > 0 &&
          streamsDiscoveryAttempts < MAX_STREAM_DISCOVERY_ATTEMPTS ? (
          <div
            className="row"
            style={{ color: "var(--muted)", fontSize: 13 }}
          >
            <span
              className="spinner"
              aria-hidden="true"
              style={{ marginLeft: 0, marginRight: 8 }}
            />
            <span>Waiting for streams…</span>
          </div>
        ) : (
          <div style={{ color: "var(--muted)", fontSize: 13 }}>
            No streams discovered yet.
          </div>
        )}
      </div>

      <CameraControlsSection
        cameraId={camera.id}
        cameraName={camera.name}
        sanitizedName={camera.sanitizedName}
        isConnected={camera.status === "connected"}
        sleepStatus={camera.sleepStatus}
      />
    </div>
  );
}
