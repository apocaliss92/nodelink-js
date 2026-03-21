import type { CameraEvent } from "./types";
import { eventBadgeColor } from "./utils";

interface EventsPanelProps {
  cameraName: string;
  events: CameraEvent[];
  loading: boolean;
  onClose: () => void;
}

export function EventsPanel({
  cameraName,
  events,
  loading,
  onClose,
}: EventsPanelProps) {
  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-3 mt-3 max-h-64 overflow-y-auto">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
          Events – {cameraName}
        </span>
        <button
          onClick={onClose}
          className="text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] text-xs"
        >
          ✕
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[var(--color-foreground-muted)]">
          <span className="spinner" aria-hidden="true" />
          <span>Loading…</span>
        </div>
      ) : events.length === 0 ? (
        <div className="text-sm text-[var(--color-foreground-muted)]">
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
    </div>
  );
}
