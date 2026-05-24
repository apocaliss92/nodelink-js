import { Server, Settings, Search } from "lucide-react";
import type { CameraInfo, NvrInfo } from "./types";

/**
 * A first-class card for an NVR/Hub device. Shows the NVR's name + host,
 * how many child cameras it carries, and exposes "Settings" (opens
 * NvrSettingsModal for device-global ops: HDD, network, users, time) and
 * "Discover channels" (existing flow — kept as-is).
 *
 * Child cameras continue to render through CameraGrid as before; this
 * card simply makes the NVR itself addressable from the UI.
 */

interface NvrCardProps {
  nvr: NvrInfo;
  childCameras: CameraInfo[];
  onOpenSettings: (nvr: NvrInfo) => void;
  onDiscover?: (nvr: NvrInfo) => void;
}

export function NvrCard({
  nvr,
  childCameras,
  onOpenSettings,
  onDiscover,
}: NvrCardProps) {
  const onlineChildren = childCameras.filter(
    (c) => c.status === "connected",
  ).length;
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="w-8 h-8 rounded-md bg-[var(--color-background)] border border-[var(--color-border)] flex items-center justify-center shrink-0">
          <Server size={14} className="text-[var(--color-foreground-muted)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-[var(--color-foreground)] truncate">
            {nvr.name}
          </div>
          <div className="text-[10px] text-[var(--color-foreground-muted)] font-mono truncate">
            {nvr.host}:{nvr.port} · {childCameras.length} channel
            {childCameras.length === 1 ? "" : "s"}
            {childCameras.length > 0 && ` · ${onlineChildren} online`}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {onDiscover ? (
          <button
            type="button"
            onClick={() => onDiscover(nvr)}
            className="inline-flex items-center gap-1 text-[11px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1 hover:bg-[var(--color-surface-hover)]"
            title="Discover channels on this NVR"
          >
            <Search size={11} />
            Discover
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onOpenSettings(nvr)}
          className="inline-flex items-center gap-1 text-[11px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1 hover:bg-[var(--color-surface-hover)]"
          title="Open NVR-level settings (cmd_ids that target the device, not a channel)"
        >
          <Settings size={11} />
          Settings
        </button>
      </div>
    </div>
  );
}
