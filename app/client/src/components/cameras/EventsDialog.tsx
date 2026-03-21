import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "camstack-ui";
import type { CameraEvent } from "./types";
import { eventBadgeColor } from "./utils";

export function EventsDialog({
  open,
  onOpenChange,
  cameraName,
  events,
  loading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cameraName: string;
  events: CameraEvent[];
  loading: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width="md" className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Events – {cameraName}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 text-foreground-muted">
            <span className="spinner" aria-hidden="true" />
            <span>Loading…</span>
          </div>
        ) : events.length === 0 ? (
          <div className="text-sm text-foreground-muted">
            No events. Events will appear with motion, doorbell, AI, etc.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {events.map((ev, i) => (
              <div
                key={`${ev.timestamp}-${i}`}
                className="flex items-center justify-between rounded-lg px-2.5 py-2"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid var(--border)",
                }}
              >
                <span
                  className="text-xs font-semibold capitalize rounded-md px-2 py-1"
                  style={{
                    minWidth: 80,
                    background: eventBadgeColor(ev.type),
                    color: "var(--text)",
                  }}
                >
                  {ev.type === "stream_clients" &&
                  ev.streamType &&
                  ev.profile != null &&
                  ev.clientCount != null
                    ? `${ev.streamType}/${ev.profile}: ${ev.clientCount}`
                    : ev.type.replace(/_/g, " ")}
                </span>
                <span className="text-xs opacity-90">
                  {ev.timestampIso
                    ? new Date(ev.timestampIso).toLocaleString()
                    : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
