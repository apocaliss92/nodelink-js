import { useState, useEffect, useCallback } from 'react';
import { Button } from '@camstack/ui-library';
import { trpcQuery, trpcMutation } from '../../api';
import type { ControlsState } from './types';

type PtzCommand = 'Up' | 'Down' | 'Left' | 'Right' | 'ZoomIn' | 'ZoomOut';

interface PtzFloatingContentProps {
  cameraId: string;
}

export function PtzFloatingContent({ cameraId }: PtzFloatingContentProps) {
  const [controlsState, setControlsState] = useState<ControlsState>(null);

  useEffect(() => {
    trpcQuery<ControlsState>('cameras.getControlsState', { id: cameraId })
      .then((st) => setControlsState(st ?? null))
      .catch(() => setControlsState(null));
  }, [cameraId]);

  const handlePtzStart = useCallback(
    (cmd: PtzCommand) => {
      void trpcMutation('cameras.ptzControl', {
        id: cameraId,
        command: cmd,
        action: 'start',
      });
    },
    [cameraId],
  );

  const handlePtzStop = useCallback(
    (cmd: PtzCommand) => {
      void trpcMutation('cameras.ptzControl', {
        id: cameraId,
        command: cmd,
        action: 'stop',
      });
    },
    [cameraId],
  );

  const handleGotoPreset = useCallback(
    (presetId: number) => () => {
      void trpcMutation('cameras.ptzGotoPreset', { id: cameraId, preset: presetId });
    },
    [cameraId],
  );

  if (!controlsState) {
    return (
      <div className="p-3 text-xs text-[var(--color-foreground-muted)]">Loading PTZ controls...</div>
    );
  }

  if (!controlsState.hasPtz && (!controlsState.ptzPresets || controlsState.ptzPresets.length === 0)) {
    return (
      <div className="p-3 text-xs text-[var(--color-foreground-muted)]">
        PTZ not available for this camera.
      </div>
    );
  }

  return (
    <div className="p-3 flex flex-col gap-3">
      {(controlsState.hasPan || controlsState.hasTilt) && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gridTemplateRows: '1fr 1fr 1fr',
            gap: 4,
          }}
        >
          <div />
          <Button
            variant="secondary"
            onMouseDown={() => handlePtzStart('Up')}
            onMouseUp={() => handlePtzStop('Up')}
            onMouseLeave={() => handlePtzStop('Up')}
            className="p-2"
          >
            ↑
          </Button>
          <div />
          <Button
            variant="secondary"
            onMouseDown={() => handlePtzStart('Left')}
            onMouseUp={() => handlePtzStop('Left')}
            onMouseLeave={() => handlePtzStop('Left')}
            className="p-2"
          >
            ←
          </Button>
          <div className="flex items-center justify-center text-[var(--color-foreground-muted)]">•</div>
          <Button
            variant="secondary"
            onMouseDown={() => handlePtzStart('Right')}
            onMouseUp={() => handlePtzStop('Right')}
            onMouseLeave={() => handlePtzStop('Right')}
            className="p-2"
          >
            →
          </Button>
          <div />
          <Button
            variant="secondary"
            onMouseDown={() => handlePtzStart('Down')}
            onMouseUp={() => handlePtzStop('Down')}
            onMouseLeave={() => handlePtzStop('Down')}
            className="p-2"
          >
            ↓
          </Button>
          <div />
        </div>
      )}

      {controlsState.hasZoom && (
        <div className="flex gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            onMouseDown={() => handlePtzStart('ZoomIn')}
            onMouseUp={() => handlePtzStop('ZoomIn')}
            onMouseLeave={() => handlePtzStop('ZoomIn')}
          >
            Zoom+
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onMouseDown={() => handlePtzStart('ZoomOut')}
            onMouseUp={() => handlePtzStop('ZoomOut')}
            onMouseLeave={() => handlePtzStop('ZoomOut')}
          >
            Zoom−
          </Button>
        </div>
      )}

      {controlsState.ptzPresets && controlsState.ptzPresets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {controlsState.ptzPresets.map((p) => (
            <Button
              key={p.id}
              variant="secondary"
              size="sm"
              onClick={handleGotoPreset(p.id)}
            >
              {p.name || `Preset ${p.id}`}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
