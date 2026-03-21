import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "camstack-ui";
import type { ControlsState } from "./types";

type PtzCommand = "Up" | "Down" | "Left" | "Right" | "ZoomIn" | "ZoomOut";

export function PtzDialog({
  open,
  onOpenChange,
  cameraName,
  controlsState,
  onPtzStart,
  onPtzStop,
  onGotoPreset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cameraName: string;
  controlsState: ControlsState;
  onPtzStart: (cmd: PtzCommand) => void;
  onPtzStop: (cmd: PtzCommand) => void;
  onGotoPreset: (presetId: number) => () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width="sm">
        <DialogHeader>
          <DialogTitle>PTZ – {cameraName}</DialogTitle>
        </DialogHeader>

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
            <div className="flex items-center justify-center text-foreground-muted">
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
      </DialogContent>
    </Dialog>
  );
}
