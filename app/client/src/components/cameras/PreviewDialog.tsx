import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@camstack/ui-library';
import type { PreviewModalState } from "./types";
import { WebRTCInlinePlayer } from "./WebRTCInlinePlayer";
import { DetectionBoxOverlay } from "./DetectionBoxOverlay";

export function PreviewDialog({
  state,
  onOpenChange,
}: {
  state: PreviewModalState;
  onOpenChange: (open: boolean) => void;
}) {
  const open = state.open;
  const [showBoxes, setShowBoxes] = useState(true);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width="lg" className="m-auto max-w-[960px] bg-[var(--color-background-elevated)] text-[var(--color-foreground)] border-[var(--color-border)]">
        {open && (
          <>
            <DialogHeader>
              <DialogTitle>{state.title}</DialogTitle>
              <DialogDescription>
                WebRTC · {state.cameraName} · {state.profile}
              </DialogDescription>
            </DialogHeader>

            <div className="mt-2 flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showBoxes}
                  onChange={(e) => setShowBoxes(e.target.checked)}
                />
                Show detection boxes
              </label>
            </div>

            <div className="mt-2">
              <WebRTCInlinePlayer
                streamName={state.streamName ?? state.cameraName}
                go2rtcApiPort={state.go2rtcApiPort}
                serviceIp={state.serviceIp}
                useNative={state.useNative}
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
