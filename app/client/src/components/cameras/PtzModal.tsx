import type { ControlsState } from "./types";

type PtzCommand = "Up" | "Down" | "Left" | "Right" | "ZoomIn" | "ZoomOut";

export function PtzModal({
  cameraName,
  controlsState,
  onPtzStart,
  onPtzStop,
  onGotoPreset,
  onClose,
}: {
  cameraName: string;
  controlsState: ControlsState;
  onPtzStart: (cmd: PtzCommand) => void;
  onPtzStop: (cmd: PtzCommand) => void;
  onGotoPreset: (presetId: number) => () => void;
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
          <span style={{ fontWeight: 600 }}>PTZ – {cameraName}</span>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            style={{ padding: "4px 8px", fontSize: 12 }}
          >
            Close
          </button>
        </div>
        {controlsState?.hasPtz && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gridTemplateRows: "1fr 1fr 1fr",
              gap: 4,
              marginBottom: 12,
            }}
          >
            <div />
            <button
              type="button"
              className="btn"
              onMouseDown={() => onPtzStart("Up")}
              onMouseUp={() => onPtzStop("Up")}
              onMouseLeave={() => onPtzStop("Up")}
              style={{ padding: 8 }}
            >
              ↑
            </button>
            <div />
            <button
              type="button"
              className="btn"
              onMouseDown={() => onPtzStart("Left")}
              onMouseUp={() => onPtzStop("Left")}
              onMouseLeave={() => onPtzStop("Left")}
              style={{ padding: 8 }}
            >
              ←
            </button>
            <div style={{ padding: 8, textAlign: "center" }}>•</div>
            <button
              type="button"
              className="btn"
              onMouseDown={() => onPtzStart("Right")}
              onMouseUp={() => onPtzStop("Right")}
              onMouseLeave={() => onPtzStop("Right")}
              style={{ padding: 8 }}
            >
              →
            </button>
            <div />
            <button
              type="button"
              className="btn"
              onMouseDown={() => onPtzStart("Down")}
              onMouseUp={() => onPtzStop("Down")}
              onMouseLeave={() => onPtzStop("Down")}
              style={{ padding: 8 }}
            >
              ↓
            </button>
            <div />
          </div>
        )}
        {controlsState?.hasPtz && (
          <div
            className="row"
            style={{ gap: 4, marginBottom: 8 }}
          >
            <button
              type="button"
              className="btn"
              onMouseDown={() => onPtzStart("ZoomIn")}
              onMouseUp={() => onPtzStop("ZoomIn")}
              onMouseLeave={() => onPtzStop("ZoomIn")}
              style={{ padding: "4px 8px", fontSize: 12 }}
            >
              Zoom+
            </button>
            <button
              type="button"
              className="btn"
              onMouseDown={() => onPtzStart("ZoomOut")}
              onMouseUp={() => onPtzStop("ZoomOut")}
              onMouseLeave={() => onPtzStop("ZoomOut")}
              style={{ padding: "4px 8px", fontSize: 12 }}
            >
              Zoom−
            </button>
          </div>
        )}
        {controlsState &&
          controlsState.ptzPresets &&
          controlsState.ptzPresets.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {controlsState.ptzPresets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="btn"
                  onClick={onGotoPreset(p.id)}
                  style={{ padding: "4px 10px", fontSize: 12 }}
                >
                  {p.name || `Preset ${p.id}`}
                </button>
              ))}
            </div>
          )}
      </div>
    </>
  );
}
