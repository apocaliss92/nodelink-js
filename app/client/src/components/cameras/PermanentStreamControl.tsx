import { useState } from 'react';
import { trpcMutation } from '../../api';
import { Toggle, NumberInput, TextInput, RangeInput } from './settings-tabs/shared';
import type { CameraInfo, PermanentStreamTrigger } from './types';

type PermanentStreamValue = NonNullable<CameraInfo['permanentStream']>;

interface PermanentStreamControlProps {
  cameraId: string;
  value?: PermanentStreamValue;
}

const DEFAULT_WINDOW_SECONDS = 15;
/** Mirrors ALWAYS_ON_DEFAULTS.idleFps in the library. */
const DEFAULT_IDLE_FPS = 1;
const DEFAULT_PLACEHOLDER_TEXT = 'Sleeping';
const DEFAULT_PLACEHOLDER_OPACITY = 0.5;

// Library default when triggers is omitted (AlwaysOnOptions defaults).
const DEFAULT_TRIGGERS: PermanentStreamTrigger[] = ['motion', 'doorbell'];
const TRIGGER_OPTIONS: { value: PermanentStreamTrigger; label: string }[] = [
  { value: 'motion', label: 'Motion' },
  { value: 'doorbell', label: 'Doorbell' },
  { value: 'people', label: 'Person' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'animal', label: 'Animal' },
  { value: 'face', label: 'Face' },
  { value: 'package', label: 'Package' },
];

/**
 * Permanent (continuous) RTSP stream control for battery cameras. When
 * enabled, the RTSP server keeps serving frames continuously so downstream
 * consumers like Frigate get an uninterrupted stream. The parent is
 * responsible for rendering this ONLY for battery cameras.
 */
export function PermanentStreamControl({ cameraId, value }: PermanentStreamControlProps) {
  const [config, setConfig] = useState<PermanentStreamValue>(value ?? {});
  const [saving, setSaving] = useState(false);

  const enabled = Boolean(config.enabled);
  const activeTriggers = config.triggers ?? DEFAULT_TRIGGERS;

  const toggleTrigger = (t: PermanentStreamTrigger) => {
    const next = activeTriggers.includes(t)
      ? activeTriggers.filter((x) => x !== t)
      : [...activeTriggers, t];
    // Keep at least one trigger so the stream can still wake.
    if (next.length === 0) return;
    persist({ ...config, triggers: next });
  };

  const persist = (next: PermanentStreamValue) => {
    setConfig(next);
    setSaving(true);
    void trpcMutation('cameras.setPermanentStream', {
      id: cameraId,
      config: {
        enabled: Boolean(next.enabled),
        ...(next.triggers !== undefined ? { triggers: next.triggers } : {}),
        ...(next.windowSeconds !== undefined ? { windowSeconds: next.windowSeconds } : {}),
        ...(next.idleFps !== undefined ? { idleFps: next.idleFps } : {}),
        ...(next.placeholderText !== undefined ? { placeholderText: next.placeholderText } : {}),
        ...(next.placeholderOpacity !== undefined
          ? { placeholderOpacity: next.placeholderOpacity }
          : {}),
        ...(next.placeholderEnabled !== undefined
          ? { placeholderEnabled: next.placeholderEnabled }
          : {}),
      },
    })
      .catch(() => {
        /* keep optimistic state; surfaced via server logs */
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="rounded-lg bg-[var(--color-surface)] p-3 mb-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
          Permanent stream
          {saving ? <span className="ml-1 normal-case opacity-60">saving…</span> : null}
        </div>
        <Toggle value={enabled} onChange={(v) => persist({ ...config, enabled: v })} />
      </div>
      <div className="text-[11px] text-[var(--color-foreground-muted)] mb-2">
        Continuous, Frigate-friendly stream. Serves real frames during motion and a
        dimmed “Sleeping” placeholder while the camera sleeps.
      </div>

      {enabled ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--color-foreground-muted)]">
              Wake on
            </span>
            <div className="flex flex-wrap gap-1">
              {TRIGGER_OPTIONS.map((opt) => {
                const on = activeTriggers.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggleTrigger(opt.value)}
                    className={[
                      'rounded-full px-2 py-0.5 text-[10px] border transition-colors',
                      on
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white'
                        : 'border-[var(--color-border)] text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-hover)]',
                    ].join(' ')}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <span className="text-[10px] text-[var(--color-foreground-subtle)]">
              While the camera sleeps these arrive via Email Push.
            </span>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--color-foreground-muted)]">Window (s)</span>
            <div className="w-24">
              <NumberInput
                value={config.windowSeconds ?? DEFAULT_WINDOW_SECONDS}
                min={1}
                max={600}
                step={1}
                onChange={(v) => persist({ ...config, windowSeconds: v })}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--color-foreground-muted)]">Idle FPS</span>
            <div className="w-24">
              <NumberInput
                value={config.idleFps ?? DEFAULT_IDLE_FPS}
                min={0.1}
                max={30}
                step={0.1}
                onChange={(v) => persist({ ...config, idleFps: v })}
              />
            </div>
          </div>
          <span className="-mt-1 text-[10px] text-[var(--color-foreground-subtle)]">
            How often the “Sleeping” placeholder is repeated while the camera is
            asleep. Higher values keep fussy consumers fed at the cost of a
            little CPU; they do not wake the camera.
          </span>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--color-foreground-muted)]">Placeholder text</span>
            <div className="w-36">
              <TextInput
                value={config.placeholderText ?? DEFAULT_PLACEHOLDER_TEXT}
                placeholder={DEFAULT_PLACEHOLDER_TEXT}
                onChange={(v) => persist({ ...config, placeholderText: v })}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--color-foreground-muted)]">Dim (0–1)</span>
            <div className="flex-1 max-w-[180px]">
              <RangeInput
                value={config.placeholderOpacity ?? DEFAULT_PLACEHOLDER_OPACITY}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => persist({ ...config, placeholderOpacity: v })}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
