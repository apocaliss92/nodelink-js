import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@camstack/ui-library';
import type { PreviewModalState } from "./types";
import { WebRTCInlinePlayer } from "./WebRTCInlinePlayer";

export function PreviewDialog({
  state,
  onOpenChange,
}: {
  state: PreviewModalState;
  onOpenChange: (open: boolean) => void;
}) {
  const open = state.open;

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

            <div className="mt-2">
              <WebRTCInlinePlayer
                streamName={state.streamName ?? state.cameraName}
                go2rtcApiPort={state.go2rtcApiPort}
                serviceIp={state.serviceIp}
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
