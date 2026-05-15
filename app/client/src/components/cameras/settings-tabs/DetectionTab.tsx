import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Section,
  FieldGrid,
  Field,
  NumberInput,
  Toggle,
  ApplyBar,
  findNumber,
  findString,
  type TabProps,
} from "./shared";
import { trpcQuery, trpcMutation } from "../../../api";

/**
 * Motion + AI detection tab.
 *
 * Two independent forms in one tab:
 *
 *   1. Motion alarm (cmd_46/47) — top-level enable + sensitivity slider.
 *      Modern firmwares ship a per-time-window sensitivity array under
 *      `<sensitivityInfoList>`; we surface the FIRST window's value
 *      until the full schedule editor lands.
 *
 *   2. Per-class AI sensitivity (cmd_342/343) — the camera advertises
 *      which classes it supports via cmd_299's `<detectType>` list
 *      ("people,dog_cat" etc.). For each, we fetch the AiDetectCfg
 *      via the raw `getAiAlarmRaw` call to pull `sensitivity` and
 *      `stayTime` out, then let the user edit. Apply writes per class
 *      via `setAiDetection`.
 */
interface MotionForm {
  enabled: boolean;
  sensitivity: number;
}

interface AiClassForm {
  type: string;
  sensitivity: number | undefined;
  stayTime: number | undefined;
}

function readMotionForm(raw: unknown): MotionForm {
  const enable = findNumber(raw, "enable");
  let sens = findNumber(raw, "sensitivity");
  if (sens === undefined) sens = findNumber(raw, "sensitivityDefault");
  return { enabled: enable === 1, sensitivity: sens ?? 50 };
}

function readAiTypes(aiCfg: unknown): string[] {
  // <AiCfg><detectType>people,dog_cat</detectType>...</AiCfg>
  const detect = findString(aiCfg, "detectType");
  if (!detect) return [];
  return detect.split(",").map((s) => s.trim()).filter(Boolean);
}

const CLASS_LABELS: Record<string, string> = {
  people: "People",
  vehicle: "Vehicle",
  dog_cat: "Animals (dog / cat)",
  face: "Face",
  package: "Package",
};

const labelForClass = (type: string): string =>
  CLASS_LABELS[type] ?? type;

export function DetectionTab({ cameraId, channel }: TabProps) {
  const [motion, setMotion] = useState<MotionForm | null>(null);
  const [loadedMotion, setLoadedMotion] = useState<MotionForm | null>(null);
  const [aiClasses, setAiClasses] = useState<AiClassForm[]>([]);
  const [loadedAi, setLoadedAi] = useState<AiClassForm[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [m, aiCfg] = await Promise.all([
        trpcQuery<unknown>("baichuan.getMotionAlarm", { cameraId, channel }),
        trpcQuery<unknown>("baichuan.getAiCfg", { cameraId, channel }).catch(() => null),
      ]);
      const f = readMotionForm(m);
      setMotion(f);
      setLoadedMotion(f);

      const types = readAiTypes(aiCfg);
      const classForms: AiClassForm[] = [];
      for (const type of types) {
        const raw = await trpcQuery<unknown>(
          "baichuan.getAiAlarmRaw",
          { cameraId, channel, aiType: type },
        ).catch(() => null);
        classForms.push({
          type,
          sensitivity: findNumber(raw, "sensitivity"),
          stayTime: findNumber(raw, "stayTime"),
        });
      }
      setAiClasses(classForms);
      setLoadedAi(classForms.map((c) => ({ ...c })));
      setSaved(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cameraId, channel]);

  useEffect(() => { void refresh(); }, [refresh]);

  const dirty = useMemo(() => {
    if (JSON.stringify(loadedMotion) !== JSON.stringify(motion)) return true;
    if (JSON.stringify(loadedAi) !== JSON.stringify(aiClasses)) return true;
    return false;
  }, [motion, loadedMotion, aiClasses, loadedAi]);

  const apply = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      if (
        motion &&
        loadedMotion &&
        JSON.stringify(motion) !== JSON.stringify(loadedMotion)
      ) {
        await trpcMutation("baichuan.setMotionAlarm", {
          cameraId,
          channel,
          enabled: motion.enabled,
          sensitivity: motion.sensitivity,
        });
      }
      for (let i = 0; i < aiClasses.length; i++) {
        const cur = aiClasses[i]!;
        const old = loadedAi[i];
        if (!old || JSON.stringify(cur) === JSON.stringify(old)) continue;
        await trpcMutation("baichuan.setAiDetection", {
          cameraId,
          channel,
          aiType: cur.type,
          ...(cur.sensitivity !== undefined ? { sensitivity: cur.sensitivity } : {}),
          ...(cur.stayTime !== undefined ? { stayTime: cur.stayTime } : {}),
        });
      }
      setSaved(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [motion, loadedMotion, aiClasses, loadedAi, cameraId, channel, refresh]);

  const revertAll = useCallback(() => {
    if (loadedMotion) setMotion(loadedMotion);
    setAiClasses(loadedAi.map((c) => ({ ...c })));
  }, [loadedMotion, loadedAi]);

  const updateAi = (idx: number, field: "sensitivity" | "stayTime", value: number): void => {
    setAiClasses((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, [field]: value } : c)),
    );
  };

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
        title="AI detection per class"
        description="Sensitivity per AI class advertised by the camera. The list is built from the `detectType` field of cmd_299 (so it reflects exactly what this model/firmware supports). stayTime is the minimum dwell time before an alarm fires (seconds)."
      >
        {loading ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-4">Loading…</div>
        ) : aiClasses.length === 0 ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-2">
            Camera did not report any AI classes (cmd_299 detectType was empty). Typical on models without on-device AI.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {aiClasses.map((cls, idx) => (
              <div
                key={cls.type}
                className="rounded-md border border-[var(--color-border)] p-3"
              >
                <div className="text-[12px] font-semibold text-[var(--color-foreground)] mb-2">
                  {labelForClass(cls.type)}
                  <span className="ml-2 text-[10px] text-[var(--color-foreground-muted)] font-mono">
                    type={cls.type}
                  </span>
                </div>
                <FieldGrid>
                  <Field label="Sensitivity" hint="0–100; higher = more sensitive">
                    <NumberInput
                      value={cls.sensitivity}
                      min={0}
                      max={100}
                      onChange={(v) => updateAi(idx, "sensitivity", v)}
                      disabled={saving}
                    />
                  </Field>
                  <Field label="Stay time (s)" hint="0 = trigger on first detection">
                    <NumberInput
                      value={cls.stayTime}
                      min={0}
                      max={600}
                      onChange={(v) => updateAi(idx, "stayTime", v)}
                      disabled={saving}
                    />
                  </Field>
                </FieldGrid>
              </div>
            ))}
          </div>
        )}
      </Section>

      <ApplyBar
        dirty={dirty}
        saving={saving}
        saved={saved}
        error={error}
        onApply={() => void apply()}
        onRevert={revertAll}
        onRefresh={() => void refresh()}
      />
    </div>
  );
}
