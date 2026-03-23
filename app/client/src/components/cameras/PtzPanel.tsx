import { Button } from '@camstack/ui-library';
import type { ControlsState } from "./types";

type PtzCommand = "Up" | "Down" | "Left" | "Right" | "ZoomIn" | "ZoomOut";

interface PtzPanelProps {
  cameraName: string;
  controlsState: ControlsState;
  onPtzStart: (cmd: PtzCommand) => void;
  onPtzStop: (cmd: PtzCommand) => void;
  onGotoPreset: (presetId: number) => () => void;
  onClose: () => void;
}

export function PtzPanel({
  cameraName,
  controlsState,
  onPtzStart,
  onPtzStop,
  onGotoPreset,
  onClose,
}: PtzPanelProps) {
  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-3 mt-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
          PTZ – {cameraName}
        </span>
        <button
          onClick={onClose}
          className="text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] text-xs"
        >
          ✕
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
          <Button
            variant="secondary"
            onMouseDown={() => onPtzStart("Up")}
            onMouseUp={() => onPtzStop("Up")}
            onMouseLeave={() => onPtzStop("Up")}
            className="p-2"
          >
            ↑
          </Button>
          <div />
          <Button
            variant="secondary"
            onMouseDown={() => onPtzStart("Left")}
            onMouseUp={() => onPtzStop("Left")}
            onMouseLeave={() => onPtzStop("Left")}
            className="p-2"
          >
            ←
          </Button>
          <div className="flex items-center justify-center text-[var(--color-foreground-muted)]">
            •
          </div>
          <Button
            variant="secondary"
            onMouseDown={() => onPtzStart("Right")}
            onMouseUp={() => onPtzStop("Right")}
            onMouseLeave={() => onPtzStop("Right")}
            className="p-2"
          >
            →
          </Button>
          <div />
          <Button
            variant="secondary"
            onMouseDown={() => onPtzStart("Down")}
            onMouseUp={() => onPtzStop("Down")}
            onMouseLeave={() => onPtzStop("Down")}
            className="p-2"
          >
            ↓
          </Button>
          <div />
        </div>
      )}

      {controlsState?.hasPtz && (
        <div className="flex gap-1.5 mb-2">
          <Button
            variant="secondary"
            size="sm"
            onMouseDown={() => onPtzStart("ZoomIn")}
            onMouseUp={() => onPtzStop("ZoomIn")}
            onMouseLeave={() => onPtzStop("ZoomIn")}
          >
            Zoom+
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onMouseDown={() => onPtzStart("ZoomOut")}
            onMouseUp={() => onPtzStop("ZoomOut")}
            onMouseLeave={() => onPtzStop("ZoomOut")}
          >
            Zoom−
          </Button>
        </div>
      )}

      {controlsState?.ptzPresets && controlsState.ptzPresets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {controlsState.ptzPresets.map((p) => (
            <Button
              key={p.id}
              variant="secondary"
              size="sm"
              onClick={onGotoPreset(p.id)}
            >
              {p.name || `Preset ${p.id}`}
            </Button>
          ))}
        </div>
      )}

      {!controlsState?.hasPtz && (
        <div className="text-xs text-[var(--color-foreground-muted)] py-1">
          PTZ not available for this camera.
        </div>
      )}
    </div>
  );
}
