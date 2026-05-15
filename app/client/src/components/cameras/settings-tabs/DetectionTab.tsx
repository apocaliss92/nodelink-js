import { useEffect, useState, useCallback } from "react";
import {
  Section,
  FieldGrid,
  Field,
  NumberInput,
  Toggle,
  ApplyBar,
  type TabProps,
} from "./shared";
import { trpcQuery, trpcMutation } from "../../../api";

interface MotionAlarm {
  enabled?: boolean;
  enable?: boolean;
  sensitivity?: number;
  [k: string]: unknown;
}

interface AiAlarm {
  channel?: number;
  alarm_state?: number;
  support?: number;
  [k: string]: unknown;
}

interface MotionForm {
  enabled: boolean;
  sensitivity: number;
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
        trpcQuery<MotionAlarm>("baichuan.getMotionAlarm", { cameraId, channel }),
        trpcQuery<AiAlarm>("baichuan.getAiAlarm", { cameraId, channel }).catch(() => null),
      ]);
      const mForm: MotionForm = {
        enabled: Boolean(m.enabled ?? m.enable ?? false),
        sensitivity: typeof m.sensitivity === "number" ? m.sensitivity : 50,
      };
      setMotion(mForm);
      setLoadedMotion(mForm);
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
        description="Camera-side motion alarm (cmd_id 47). The same setting Reolink calls 'Motion Detection' in the mobile app."
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
