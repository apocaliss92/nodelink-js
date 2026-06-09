import { useState } from "react";
import { FloatingPanel } from "./FloatingPanel";
import { WebRTCInlinePlayer } from "./WebRTCInlinePlayer";
import { DetectionBoxOverlay } from "./DetectionBoxOverlay";
import type { AvailableStream, CameraInfo } from "./types";

export interface StreamFloatingPanelProps {
  panelId: string;
  camera: CameraInfo;
  stream: AvailableStream;
  offsetIndex: number;
  onClose: () => void;
}

/**
 * Stream preview floating panel. Owns its own "show boxes" toggle so each
 * window can be controlled independently — useful when comparing two cameras
 * side-by-side and toggling the overlay on one of them.
 */
export function StreamFloatingPanel({
  panelId,
  camera,
  stream,
  offsetIndex,
  onClose,
}: StreamFloatingPanelProps) {
  const [showBoxes, setShowBoxes] = useState(true);
  void panelId;

  return (
    <FloatingPanel
      title={`${camera.name || camera.host} — ${stream.profile}`}
      onClose={onClose}
      offsetIndex={offsetIndex}
      defaultWidth={480}
      defaultHeight={310}
      minWidth={320}
      minHeight={200}
    >
      <div className="h-full bg-black flex flex-col">
        <div className="flex items-center gap-2 px-2 py-1 text-xs bg-[var(--color-surface,#1f2937)] text-[var(--color-foreground,#e5e7eb)]">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showBoxes}
              onChange={(e) => setShowBoxes(e.target.checked)}
            />
            Show detection boxes
          </label>
        </div>
        <div className="flex-1 relative">
          <WebRTCInlinePlayer
            cameraId={camera.id}
            profile={stream.profile}
            overlayRender={(video) =>
              showBoxes ? (
                <DetectionBoxOverlay
                  videoEl={video}
                  cameraId={camera.id}
                  profile={stream.profile}
                />
              ) : null
            }
          />
        </div>
      </div>
    </FloatingPanel>
  );
}
