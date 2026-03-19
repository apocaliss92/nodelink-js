import type { PreviewModalState } from "./types";
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
              WebRTC · {state.cameraName} · {state.profile}
            </div>
          </div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ marginTop: 12 }}>
          <WebRTCInlinePlayer
            streamName={state.streamName ?? state.cameraName}
            go2rtcApiPort={state.go2rtcApiPort}
            serviceIp={state.serviceIp}
          />
        </div>
      </div>
    </div>
  );
}
