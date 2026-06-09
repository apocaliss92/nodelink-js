import { cn } from "@camstack/ui-library";
import {
  Move,
  Bell,
  Users,
  Lightbulb,
  Play,
  Plug,
  Eye,
  Moon,
  Battery,
  BatteryCharging,
} from "lucide-react";
import type { CameraInfo, AvailableStream, StreamProfile } from "./types";

interface CameraCardProps {
  camera: CameraInfo;
  streams: AvailableStream[];
  rtspServers: Array<{
    cameraId: string;
    profile: StreamProfile;
    status?: string;
    connections?: number;
  }>;
  selected: boolean;
  connecting: boolean;
  onClick: () => void;
  onConnect?: () => void;
  onOpenPtz?: () => void;
  onOpenEvents?: () => void;
  onOpenSessions?: () => void;
  onOpenDeviceControls?: () => void;
  onOpenStream?: (stream: AvailableStream) => void;
}

export function CameraCard({
  camera,
  streams,
  rtspServers,
  selected,
  connecting,
  onClick,
  onConnect,
  onOpenPtz,
  onOpenEvents,
  onOpenSessions,
  onOpenDeviceControls,
  onOpenStream,
}: CameraCardProps) {
  const isOnline = camera.status === "connected";
  const isSleeping = isOnline && camera.sleepStatus === "sleeping";
  const battery = camera.batteryState;
  const isCharging =
    battery?.chargeStatus === "charging" ||
    battery?.adapterStatus === "solarPanel";
  const iconBtnClass =
    "p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-foreground-subtle)] hover:text-[var(--color-foreground)] transition-colors";

  return (
    <div
      onClick={onClick}
      className={cn(
        "w-full rounded-lg border p-3 text-left transition-colors cursor-pointer",
        selected
          ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10"
          : "border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]",
        !isOnline && !selected && "opacity-50",
      )}
    >
      <div className="flex items-center justify-between mb-2 gap-2">
        <span className="text-sm font-medium truncate">
          {camera.name || camera.host}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {battery && (
            <span
              className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium bg-[var(--color-surface-hover)] text-[var(--color-foreground-subtle)]"
              title={
                isCharging
                  ? `Battery ${battery.percent}% (charging)`
                  : `Battery ${battery.percent}%`
              }
            >
              {isCharging ? <BatteryCharging size={9} /> : <Battery size={9} />}
              {battery.percent}%
            </span>
          )}
          {isSleeping && (
            <span
              className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium bg-[var(--color-surface-hover)] text-[var(--color-foreground-subtle)]"
              title="Camera is sleeping (idle)"
            >
              <Moon size={8} />
              sleeping
            </span>
          )}
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              isOnline
                ? isSleeping
                  ? "bg-[var(--color-foreground-subtle)]"
                  : "bg-[var(--color-success)]"
                : "bg-[var(--color-danger)]",
            )}
          />
        </div>
      </div>
      <div className="text-[11px] text-[var(--color-foreground-muted)]">
        {camera.deviceInfo?.model && `${camera.deviceInfo.model} · `}
        {camera.host}
      </div>

      {/* Stream badges — clickable to open the WebRTC inline preview via the
          in-process BaichuanWebRTCServer (tRPC `webrtc.*`). */}
      {streams.length > 0 && (
        <div className="flex gap-1 mt-2">
          {streams.map((s) => {
            const server = rtspServers.find(
              (r) => r.cameraId === camera.id && r.profile === s.profile,
            );
            const viewers =
              server?.status === "running" ? (server.connections ?? 0) : 0;
            return (
              <button
                key={s.profile}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenStream?.(s);
                }}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] transition-opacity flex items-center gap-0.5 hover:opacity-80",
                  selected
                    ? "bg-[var(--color-primary)]/20"
                    : "bg-[var(--color-surface-hover)]",
                )}
                title={`Open ${s.profile} stream${viewers > 0 ? ` (${viewers} viewer${viewers > 1 ? "s" : ""})` : ""}`}
              >
                <Play size={8} />
                {s.profile}
                {viewers > 0 && (
                  <span className="flex items-center gap-0.5 ml-0.5 text-[var(--color-foreground-subtle)]">
                    <Eye size={7} />
                    {viewers}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Quick actions */}
      {isOnline ? (
        (onOpenPtz ||
          onOpenDeviceControls ||
          onOpenEvents ||
          onOpenSessions) && (
          <div className="flex items-center gap-0.5 mt-2 -mb-1">
            {onOpenPtz && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenPtz();
                }}
                className={iconBtnClass}
                title="PTZ Controls"
              >
                <Move size={12} />
              </button>
            )}
            {onOpenDeviceControls && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenDeviceControls();
                }}
                className={iconBtnClass}
                title="Device Controls"
              >
                <Lightbulb size={12} />
              </button>
            )}
            {onOpenEvents && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenEvents();
                }}
                className={iconBtnClass}
                title="Events"
              >
                <Bell size={12} />
              </button>
            )}
            {onOpenSessions && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSessions();
                }}
                className={iconBtnClass}
                title="Device sessions"
              >
                <Users size={12} />
              </button>
            )}
          </div>
        )
      ) : onConnect ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onConnect();
          }}
          disabled={connecting}
          className="flex items-center gap-1.5 mt-2 rounded-md bg-[var(--color-primary)]/15 text-[var(--color-primary)] px-2.5 py-1 text-[10px] font-medium hover:bg-[var(--color-primary)]/25 transition-colors disabled:opacity-50"
        >
          <Plug size={10} />
          {connecting ? "Connecting..." : "Connect"}
        </button>
      ) : null}
    </div>
  );
}
