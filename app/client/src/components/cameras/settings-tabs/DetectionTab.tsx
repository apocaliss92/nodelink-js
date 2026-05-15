import { useEffect, useState, useCallback } from "react";
import {
  Section,
  FieldGrid,
  Field,
  NumberInput,
  Toggle,
  ApplyBar,
  findNumber,
  type TabProps,
} from "./shared";
import { trpcQuery, trpcMutation } from "../../../api";

/**
 * Motion + AI detection tab.
 *
 * The library returns the raw camera XML parsed as nested JSON. The
 * relevant fields live under `body.MD` for cmd_46 and `body.AiAlarm`
 * (or similar) for cmd_342, so we use `findNumber` to pluck what we
 * need without committing to a fixed shape.
 *
 * Sensitivity on E1 Zoom is reported as a per-time-window array under
 * `<sensitivityInfoList><sensitivityInfo>…</sensitivityInfo>…</sensitivityInfoList>`.
 * We surface the FIRST window's value (the camera UI in the official
 * app does the same when it shows a single slider). When the user
 * applies, the library setter writes only the top-level field — older
 * firmwares that expose a scalar respond correctly; newer firmwares
 * with the time-window list need additional work to roll out per-window
 * sensitivity which we'll do once we have a SET capture to verify.
 */
interface MotionForm {
  enabled: boolean;
  sensitivity: number;
}

interface AiAlarm {
  channel?: number;
  alarm_state?: number;
  support?: number;
  [k: string]: unknown;
}

function readMotionForm(raw: unknown): MotionForm {
  const enable = findNumber(raw, "enable");
  // First try a top-level <sensitivity> (older firmwares); otherwise
  // pluck the first <sensitivityInfo> entry's sensitivity (E1 Zoom and
  // similar). `findNumber` returns the first match in DFS order which is
  // exactly what we want.
  let sens = findNumber(raw, "sensitivity");
  if (sens === undefined) sens = findNumber(raw, "sensitivityDefault");
  return {
    enabled: enable === 1,
    sensitivity: sens ?? 50,
  };
}

export function DetectionTab({ cameraId, channel }: TabProps) {
  const [motion, setMotion] = useState<MotionForm | null>(null);
  const [loadedMotion, setLoadedMotion] = useState<MotionForm | null>(null);
  const [ai, setAi] = useState<AiAlarm | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [m, a] = await Promise.all([
        trpcQuery<unknown>("baichuan.getMotionAlarm", { cameraId, channel }),
        trpcQuery<AiAlarm>("baichuan.getAiAlarm", { cameraId, channel }).catch(() => null),
      ]);
      const f = readMotionForm(m);
      setMotion(f);
      setLoadedMotion(f);
      setAi(a);
      setSaved(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cameraId, channel]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dirty =
    JSON.stringify(loadedMotion) !== JSON.stringify(motion);

  const apply = useCallback(async () => {
    if (!motion) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await trpcMutation("baichuan.setMotionAlarm", {
        cameraId,
        channel,
        enabled: motion.enabled,
        sensitivity: motion.sensitivity,
      });
      setSaved(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [motion, cameraId, channel, refresh]);

  return (
    <div>
      <Section
        title="Motion detection"
        description="Camera-side motion alarm (cmd_id 47). The same setting Reolink calls 'Motion Detection' in the mobile app. Sensitivity here updates the FIRST time-window when the firmware exposes per-hour values; the full schedule editor is on the roadmap."
      >
        {loading || !motion ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-4">
            Loading…
          </div>
        ) : (
          <FieldGrid>
            <Field label="Enabled">
              <Toggle
                value={motion.enabled}
                onChange={(v) =>
                  setMotion((prev) => (prev ? { ...prev, enabled: v } : prev))
                }
                disabled={saving}
              />
            </Field>
            <Field label="Sensitivity" hint="0–50; higher = more sensitive">
              <NumberInput
                value={motion.sensitivity}
                min={0}
                max={50}
                onChange={(v) =>
                  setMotion((prev) => (prev ? { ...prev, sensitivity: v } : prev))
                }
                disabled={saving}
              />
            </Field>
          </FieldGrid>
        )}
      </Section>

      <Section
        title="AI detection state"
        description="Last AI-alarm snapshot reported by the camera. Per-class AI configuration (sensitivity, area, types) is captured by `getAiState` and `getAiCfg` — read-only here while we wire setters for each AI class."
      >
        {ai === null ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-2">
            Camera did not report AI alarm fields (typical for models without AI).
          </div>
        ) : (
          <pre className="text-[11px] font-mono bg-[var(--color-background)] border border-[var(--color-border)] rounded p-2 overflow-auto max-h-[200px]">
{JSON.stringify(ai, null, 2)}
          </pre>
        )}
      </Section>

      <ApplyBar
        dirty={dirty}
        saving={saving}
        saved={saved}
        error={error}
        onApply={() => void apply()}
        onRevert={() => setMotion(loadedMotion)}
        onRefresh={() => void refresh()}
      />
    </div>
  );
}
