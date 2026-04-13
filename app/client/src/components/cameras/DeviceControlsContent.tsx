import { useState, useEffect, useCallback } from 'react';
import { Lightbulb, AlertTriangle, Crosshair, Eye, Moon, Activity } from 'lucide-react';
import { trpcQuery, trpcMutation } from '../../api';
import type { ControlsState } from './types';

interface DeviceControlsContentProps {
  cameraId: string;
}

interface ControlItem {
  key: string;
  label: string;
  sublabel?: string;
  icon: React.ElementType;
  has: boolean;
  on: boolean | undefined;
  mutation: string;
  field: string;
}

export function DeviceControlsContent({ cameraId }: DeviceControlsContentProps) {
  const [controls, setControls] = useState<ControlsState>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(false);
    trpcQuery<ControlsState>('cameras.getControlsState', { id: cameraId })
      .then((st) => { setControls(st ?? null); setLoading(false); })
      .catch(() => { setControls(null); setLoading(false); setError(true); });
  }, [cameraId]);

  const toggle = useCallback(
    async (key: string, mutation: string, field: string, currentValue: boolean) => {
      setToggling(key);
      try {
        await trpcMutation(mutation, { id: cameraId, on: !currentValue });
        setControls((prev) => (prev ? { ...prev, [field]: !currentValue } : null));
      } catch {
        // ignore
      } finally {
        setToggling(null);
      }
    },
    [cameraId],
  );

  if (loading) {
    return (
      <div className="p-3 text-xs text-[var(--color-foreground-muted)]">Loading controls...</div>
    );
  }

  if (error || !controls) {
    return (
      <div className="p-3 text-xs text-[var(--color-danger)]">
        Failed to load controls. Is the camera connected?
      </div>
    );
  }

  const items: ControlItem[] = [
    {
      key: 'light',
      label: 'Floodlight',
      icon: Lightbulb,
      has: controls.hasFloodlight,
      on: controls.lightOn,
      mutation: 'cameras.setLight',
      field: 'lightOn',
    },
    {
      key: 'lightOnMotion',
      label: 'Floodlight on motion',
      sublabel: 'Auto',
      icon: Activity,
      has: controls.hasFloodlight,
      on: controls.floodlightOnMotion,
      mutation: 'cameras.setFloodlightOnMotion',
      field: 'floodlightOnMotion',
    },
    {
      key: 'siren',
      label: 'Siren',
      icon: AlertTriangle,
      has: controls.hasSiren,
      on: controls.sirenOn,
      mutation: 'cameras.setSiren',
      field: 'sirenOn',
    },
    {
      key: 'sirenOnMotion',
      label: 'Siren on motion',
      sublabel: 'Auto',
      icon: Activity,
      has: controls.hasSiren,
      on: controls.sirenOnMotion,
      mutation: 'cameras.setSirenOnMotion',
      field: 'sirenOnMotion',
    },
    {
      key: 'autotrack',
      label: 'Autotracking',
      icon: Crosshair,
      has: controls.hasAutotracking,
      on: controls.autotrackingOn,
      mutation: 'cameras.setAutotracking',
      field: 'autotrackingOn',
    },
    {
      key: 'pir',
      label: 'PIR Sensor',
      icon: Eye,
      has: controls.hasPir,
      on: controls.pirOn,
      mutation: 'cameras.setPir',
      field: 'pirOn',
    },
  ].filter((i) => i.has);

  if (items.length === 0) {
    return (
      <div className="p-3 text-xs text-[var(--color-foreground-muted)]">
        No device controls available.
      </div>
    );
  }

  const sleeping = controls.isSleeping === true;

  return (
    <div className="p-3 flex flex-col gap-2">
      {sleeping && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-[var(--color-surface)] text-[10px] text-[var(--color-foreground-subtle)]">
          <Moon size={10} />
          Camera is sleeping — current state unknown. Toggling will wake it.
        </div>
      )}
      {items.map((item) => (
        <div
          key={item.key}
          className="flex items-center justify-between px-2 py-1.5 rounded-md bg-[var(--color-surface)]"
        >
          <div className="flex items-center gap-2 text-xs">
            <item.icon
              size={13}
              className={
                item.on
                  ? 'text-[var(--color-warning)]'
                  : 'text-[var(--color-foreground-subtle)]'
              }
            />
            <div className="flex flex-col leading-tight">
              <span>{item.label}</span>
              {item.sublabel && (
                <span className="text-[10px] text-[var(--color-foreground-subtle)]">
                  {item.sublabel}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={() => void toggle(item.key, item.mutation, item.field, !!item.on)}
            disabled={toggling === item.key}
            className={`relative w-8 h-[18px] rounded-full transition-colors ${
              item.on
                ? 'bg-[var(--color-primary)]'
                : 'bg-[var(--color-border)]'
            }`}
            title={sleeping ? `Wake camera and toggle ${item.label}` : item.on ? `Turn off ${item.label}` : `Turn on ${item.label}`}
          >
            <span
              className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform ${
                item.on ? 'left-[18px]' : 'left-[2px]'
              }`}
            />
          </button>
        </div>
      ))}
    </div>
  );
}
