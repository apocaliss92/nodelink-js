import { useState } from "react";
import { Dialog, DialogContent } from "@camstack/ui-library";
import {
  Video,
  Image as ImageIcon,
  Eye,
  Grid3x3,
  Type,
  Cpu,
  Volume2,
  Move,
  Globe,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { StreamsTab } from "./settings-tabs/StreamsTab";
import { ImageTab } from "./settings-tabs/ImageTab";
import { DetectionTab } from "./settings-tabs/DetectionTab";
import { MotionZonesTab } from "./settings-tabs/MotionZonesTab";
import { OsdTab } from "./settings-tabs/OsdTab";
import { AudioTab } from "./settings-tabs/AudioTab";
import { PtzTab } from "./settings-tabs/PtzTab";
import { NetworkTab } from "./settings-tabs/NetworkTab";
import { SystemTab } from "./settings-tabs/SystemTab";

interface TabDef {
  id: string;
  label: string;
  icon: LucideIcon;
  hint: string;
  Component: React.ComponentType<{ cameraId: string; channel: number }>;
}

const TABS: TabDef[] = [
  {
    id: "streams",
    label: "Streams",
    icon: Video,
    hint: "Codec, resolution, frame rate, bitrate per profile.",
    Component: StreamsTab,
  },
  {
    id: "image",
    label: "Image",
    icon: ImageIcon,
    hint: "Brightness, contrast, saturation, hue, sharpen.",
    Component: ImageTab,
  },
  {
    id: "detection",
    label: "Detection",
    icon: Eye,
    hint: "Motion + AI alarm sensitivity.",
    Component: DetectionTab,
  },
  {
    id: "motion-zones",
    label: "Motion zones",
    icon: Grid3x3,
    hint: "Paint the detection grid over the camera frame.",
    Component: MotionZonesTab,
  },
  {
    id: "osd",
    label: "OSD",
    icon: Type,
    hint: "On-screen text overlay, timestamp, watermark.",
    Component: OsdTab,
  },
  {
    id: "audio",
    label: "Audio",
    icon: Volume2,
    hint: "Speaker volumes, visitor loudspeaker, AI noise reduction.",
    Component: AudioTab,
  },
  {
    id: "ptz",
    label: "PTZ",
    icon: Move,
    hint: "Live view + manual pan/tilt/zoom, presets save / recall / delete.",
    Component: PtzTab,
  },
  {
    id: "network",
    label: "Network",
    icon: Globe,
    hint: "IP, ports, Wi-Fi (read-only).",
    Component: NetworkTab,
  },
  {
    id: "system",
    label: "System",
    icon: Cpu,
    hint: "Device info, firmware, battery (read-only).",
    Component: SystemTab,
  },
];

interface CameraSettingsModalProps {
  open: boolean;
  cameraId: string;
  cameraName: string;
  channel: number;
  onClose: () => void;
}

/**
 * Wide multi-tab settings modal. Each tab is a self-contained component
 * that loads its own data and saves through tRPC. Add new tabs by
 * appending to TABS — no other wiring needed.
 */
export function CameraSettingsModal({
  open,
  cameraId,
  cameraName,
  channel,
  onClose,
}: CameraSettingsModalProps) {
  const [activeTabId, setActiveTabId] = useState<string>(TABS[0]?.id ?? "streams");
  const activeTab = TABS.find((t) => t.id === activeTabId) ?? TABS[0]!;
  const ActiveComponent = activeTab.Component;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        width="lg"
        className="m-auto max-w-[1080px] w-[95vw] h-[85vh] p-0 overflow-hidden bg-[var(--color-background-elevated)] text-[var(--color-foreground)] border-[var(--color-border)]"
      >
        <div className="flex h-full w-full">
          {/* Left sidebar with tab labels */}
          <aside className="w-[200px] shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] py-3 overflow-y-auto">
            <div className="px-3 pb-3 border-b border-[var(--color-border)] mb-2">
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
                Camera settings
              </div>
              <div className="text-[13px] font-semibold text-[var(--color-foreground)] truncate">
                {cameraName}
              </div>
            </div>
            <nav className="flex flex-col gap-0.5 px-2">
              {TABS.map((tab) => {
                const Icon = tab.icon;
                const active = tab.id === activeTabId;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTabId(tab.id)}
                    className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-left transition-colors ${
                      active
                        ? "bg-[var(--color-accent,#22d3ee)]/10 text-[var(--color-foreground)] border border-[var(--color-accent,#22d3ee)]/30"
                        : "text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] hover:bg-[var(--color-surface-hover)] border border-transparent"
                    }`}
                  >
                    <Icon size={14} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          {/* Right pane: header + active tab */}
          <section className="flex-1 flex flex-col min-w-0">
            <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3 bg-[var(--color-background)]">
              <div>
                <div className="text-[13px] font-semibold text-[var(--color-foreground)]">
                  {activeTab.label}
                </div>
                <div className="text-[11px] text-[var(--color-foreground-muted)]">
                  {activeTab.hint}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] transition-colors"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </header>
            <main className="flex-1 overflow-y-auto p-4 bg-[var(--color-background)]">
              <ActiveComponent cameraId={cameraId} channel={channel} />
            </main>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
