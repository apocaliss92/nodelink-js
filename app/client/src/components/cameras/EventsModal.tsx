import type { CameraEvent } from "./types";
import { eventBadgeColor } from "./utils";

export function EventsModal({
  cameraName,
  events,
  loading,
  onClose,
}: {
  cameraName: string;
  events: CameraEvent[];
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 999,
          background: "rgba(0,0,0,0.4)",
        }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="dropdownMenu"
        style={{
          position: "fixed",
          zIndex: 1000,
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          maxWidth: 400,
          maxHeight: 320,
          overflowY: "auto",
          padding: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="row"
          style={{
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <span style={{ fontWeight: 600 }}>Events – {cameraName}</span>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            style={{ padding: "4px 8px", fontSize: 12 }}
          >
            Close
          </button>
        </div>
        {loading ? (
          <div className="row" style={{ color: "var(--muted)" }}>
            <span className="spinner" aria-hidden="true" />
            <span>Loading…</span>
          </div>
        ) : events.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 13 }}>
            No events. Events will appear with motion, doorbell, AI, etc.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {events.map((ev, i) => (
              <div
                key={`${ev.timestamp}-${i}`}
                className="row"
                style={{
                  justifyContent: "space-between",
                  padding: "8px 10px",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    textTransform: "capitalize",
                    minWidth: 80,
                    padding: "4px 8px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
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
                <span style={{ fontSize: 12, opacity: 0.9 }}>
                  {ev.timestampIso
                    ? new Date(ev.timestampIso).toLocaleString()
                    : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
