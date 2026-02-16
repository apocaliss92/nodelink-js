import type { PreviewModalState, StreamProfile } from "./types";
import { HlsInlinePlayer } from "./HlsInlinePlayer";
import { WebRTCInlinePlayer } from "./WebRTCInlinePlayer";

export function PreviewModal({
  state,
  onClose,
}: {
  state: PreviewModalState;
  onClose: () => void;
}) {
  if (!state.open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="modalOverlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modalPanel" style={{ width: "min(960px, 100%)" }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 800 }}>{state.title}</div>
            <div className="subtitle">
              {state.kind.toUpperCase()} · {state.cameraName} · {state.profile}
            </div>
          </div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        {state.kind === "mjpeg" ? (
          <div className="previewBox" style={{ marginTop: 12 }}>
            <img
              src={state.mjpegUrl ?? ""}
              alt={state.title}
              style={{ width: "100%", display: "block" }}
            />
          </div>
        ) : state.kind === "webrtc" ? (
          <div style={{ marginTop: 12 }}>
            <WebRTCInlinePlayer
              cameraName={state.cameraName}
              profile={state.profile as StreamProfile}
            />
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            <HlsInlinePlayer url={state.hlsUrl ?? ""} />
          </div>
        )}
      </div>
    </div>
  );
}
