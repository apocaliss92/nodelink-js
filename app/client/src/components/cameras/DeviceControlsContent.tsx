import { useState, useEffect, useCallback } from 'react';
import { Lightbulb, AlertTriangle, Crosshair, Eye } from 'lucide-react';
import { trpcQuery, trpcMutation } from '../../api';
import type { ControlsState } from './types';

interface DeviceControlsContentProps {
  cameraId: string;
}

export function DeviceControlsContent({ cameraId }: DeviceControlsContentProps) {
  const [controls, setControls] = useState<ControlsState>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    trpcQuery<ControlsState>('cameras.getControlsState', { id: cameraId })
      .then((st) => setControls(st ?? null))
      .catch(() => setControls(null));
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

  if (!controls) {
    return (
      <div className="p-3 text-xs text-[var(--color-foreground-muted)]">Loading controls...</div>
    );
  }

  const items = [
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
      key: 'siren',
      label: 'Siren',
      icon: AlertTriangle,
      has: controls.hasSiren,
      on: controls.sirenOn,
      mutation: 'cameras.setSiren',
      field: 'sirenOn',
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

  return (
    <div className="p-3 flex flex-col gap-2">
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
            <span>{item.label}</span>
          </div>
          <button
            onClick={() => void toggle(item.key, item.mutation, item.field, !!item.on)}
            disabled={toggling === item.key}
            className={`relative w-8 h-[18px] rounded-full transition-colors ${
              item.on ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-border)]'
            }`}
            title={item.on ? `Turn off ${item.label}` : `Turn on ${item.label}`}
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
