import { useState } from 'react';
import { FloatingPanel } from './FloatingPanel';
import { WebRTCInlinePlayer } from './WebRTCInlinePlayer';
import { DetectionBoxOverlay } from './DetectionBoxOverlay';
import type { PreviewModalState } from './types';

interface PreviewPanelProps {
  state: PreviewModalState & { open: true };
  onClose: () => void;
}

export function PreviewPanel({ state, onClose }: PreviewPanelProps) {
  const [showBoxes, setShowBoxes] = useState(true);

  return (
    <FloatingPanel
      title={state.title}
      onClose={onClose}
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
            cameraId={state.cameraId}
            profile={state.profile}
            overlayRender={(video) =>
              state.cameraId && showBoxes ? (
                <DetectionBoxOverlay
                  videoEl={video}
                  cameraId={state.cameraId}
                  profile={state.profile}
                />
              ) : null
            }
          />
        </div>
      </div>
    </FloatingPanel>
  );
}
