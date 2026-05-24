import { useEffect, useState, useCallback, useMemo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Section,
  FieldGrid,
  Field,
  RangeInput,
  Toggle,
  ApplyBar,
  findNumber,
  type TabProps,
} from "./shared";
import { trpcQuery, trpcMutation } from "../../../api";
import { withAuthTokenQuery } from "../utils";
import {
  decodeMotionScopeBitmap,
  encodeMotionScopeBitmap,
} from "../utils/motionZoneBitmap";
import { TargetSizeOverlay } from "./detection/TargetSizeOverlay";
import { BitmapGridEditor } from "./detection/BitmapGridEditor";

/**
 * Motion + AI detection tab.
 *
 *   1. Motion alarm (cmd_46/47) — enable + sensitivity slider.
 *   2. Per-class AI cfg (cmd_342/343) — full setter: sensitivity, stayTime,
 *      min/maxTarget* fractions, and the `<area>` detection-area bitmap
 *      (60×33 grid on E1 Zoom). The list of supported classes comes from
 *      cmd_299's `<detectType>` — same shape as before.
 */
interface MotionForm {
  enabled: boolean;
  sensitivity: number;
}

interface AiClassForm {
  type: string;
  sensitivity: number;
  stayTime: number;
  minTargetWidth: number;
  minTargetHeight: number;
  maxTargetWidth: number;
  maxTargetHeight: number;
  width: number;
  height: number;
  /** Decoded bitmap of width × height cells. */
  areaCells: boolean[];
}

interface AiDetectCfgRaw {
  chn: number;
  type: string;
  sensitivity: number;
  stayTime: number;
  minTargetWidth: number;
  minTargetHeight: number;
  maxTargetWidth: number;
  maxTargetHeight: number;
  width: number;
  height: number;
  area: string;
}

function readMotionForm(raw: unknown): MotionForm {
  const enable = findNumber(raw, "enable");
  let sens = findNumber(raw, "sensitivity");
  if (sens === undefined) sens = findNumber(raw, "sensitivityDefault");
  return { enabled: enable === 1, sensitivity: sens ?? 50 };
}

function readAiTypes(aiCfg: unknown): string[] {
  // <AiCfg><detectType>people,dog_cat</detectType>...</AiCfg>
  const visit = (v: unknown): string | undefined => {
    if (v === null || typeof v !== "object") return undefined;
    const rec = v as Record<string, unknown>;
    if (typeof rec.detectType === "string") return rec.detectType;
    for (const child of Object.values(rec)) {
      const hit = visit(child);
      if (hit) return hit;
    }
    return undefined;
  };
  const detect = visit(aiCfg);
  if (!detect) return [];
  return detect.split(",").map((s) => s.trim()).filter(Boolean);
}

function aiCfgToForm(cfg: AiDetectCfgRaw): AiClassForm {
  // Decode the area bitmap. The cfg ships width × height (typically 60×33).
  // We treat the active region as equal to the bitmap dimensions for AI
  // detection — there's no separate "scope columns × rows" like motion.
  let cells: boolean[];
  try {
    const decoded = decodeMotionScopeBitmap(
      cfg.area,
      cfg.width,
      cfg.height,
      cfg.width,
      cfg.height,
    );
    cells = decoded.cells;
  } catch {
    cells = new Array(cfg.width * cfg.height).fill(true);
  }
  return {
    type: cfg.type,
    sensitivity: cfg.sensitivity,
    stayTime: cfg.stayTime,
    minTargetWidth: cfg.minTargetWidth,
    minTargetHeight: cfg.minTargetHeight,
    maxTargetWidth: cfg.maxTargetWidth,
    maxTargetHeight: cfg.maxTargetHeight,
    width: cfg.width,
    height: cfg.height,
    areaCells: cells,
  };
}

const CLASS_LABELS: Record<string, string> = {
  people: "People",
  vehicle: "Vehicle",
  dog_cat: "Animals (dog / cat)",
  face: "Face",
  package: "Package",
};

const labelForClass = (type: string): string => CLASS_LABELS[type] ?? type;

export function DetectionTab({ cameraId, channel }: TabProps) {
  const [motion, setMotion] = useState<MotionForm | null>(null);
  const [loadedMotion, setLoadedMotion] = useState<MotionForm | null>(null);
  const [aiClasses, setAiClasses] = useState<AiClassForm[]>([]);
  const [loadedAi, setLoadedAi] = useState<AiClassForm[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedAreas, setExpandedAreas] = useState<Set<string>>(new Set());

  // Snapshot URL stays stable so the target overlay rectangles don't shift
  // when the parent re-renders.
  const [snapshotUrl] = useState(() =>
    withAuthTokenQuery(
      `${window.location.origin}/api/cameras/${cameraId}/snapshot?channel=${channel}`,
    ),
  );

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
        try {
          const cfg = await trpcQuery<AiDetectCfgRaw>(
            "baichuan.getAiDetectionFull",
            { cameraId, channel, aiType: type },
          );
          if (cfg && cfg.width > 0 && cfg.height > 0) {
            classForms.push(aiCfgToForm(cfg));
          }
        } catch {
          /* this AI type isn't supported by the firmware — skip */
        }
      }
      setAiClasses(classForms);
      setLoadedAi(classForms.map((c) => ({ ...c, areaCells: [...c.areaCells] })));
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
        const patch: Record<string, unknown> = {
          cameraId,
          channel,
          aiType: cur.type,
        };
        if (cur.sensitivity !== old.sensitivity)
          patch.sensitivity = cur.sensitivity;
        if (cur.stayTime !== old.stayTime) patch.stayTime = cur.stayTime;
        if (cur.minTargetWidth !== old.minTargetWidth)
          patch.minTargetWidth = cur.minTargetWidth;
        if (cur.minTargetHeight !== old.minTargetHeight)
          patch.minTargetHeight = cur.minTargetHeight;
        if (cur.maxTargetWidth !== old.maxTargetWidth)
          patch.maxTargetWidth = cur.maxTargetWidth;
        if (cur.maxTargetHeight !== old.maxTargetHeight)
          patch.maxTargetHeight = cur.maxTargetHeight;
        if (
          cur.areaCells.length !== old.areaCells.length ||
          cur.areaCells.some((v, idx) => v !== old.areaCells[idx])
        ) {
          patch.area = encodeMotionScopeBitmap({
            width: cur.width,
            height: cur.height,
            columns: cur.width,
            rows: cur.height,
            cells: cur.areaCells,
          });
        }
        await trpcMutation("baichuan.setAiDetectionFull", patch);
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
    setAiClasses(loadedAi.map((c) => ({ ...c, areaCells: [...c.areaCells] })));
  }, [loadedMotion, loadedAi]);

  const updateAi = (
    idx: number,
    patch: Partial<AiClassForm>,
  ): void => {
    setAiClasses((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    );
  };

  const toggleArea = (type: string) => {
    setExpandedAreas((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div>
      <Section
        title="Motion detection"
        description="Camera-side motion alarm (cmd_id 47). Sensitivity updates the default for the modern `<sensInfoNew>` block; per-time-band schedule is firmware-specific (legacy `<sensitivityInfoList>` is read-only on E1 Zoom)."
      >
        {loading || !motion ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-4">Loading…</div>
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
              <RangeInput
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
        description="Full per-class config: sensitivity, stay time, min/max target size (overlay rectangles), and the detection area grid (collapsed by default). Maps to cmd_id 342 (GET) + 343 (SET) — verified on E1 Zoom firmware."
      >
        {loading ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-4">Loading…</div>
        ) : aiClasses.length === 0 ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-2">
            Camera did not report any AI classes (cmd_299 detectType was empty).
            Typical on models without on-device AI.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {aiClasses.map((cls, idx) => {
              const areaOpen = expandedAreas.has(cls.type);
              return (
                <div
                  key={cls.type}
                  className="rounded-md border border-[var(--color-border)] p-3"
                >
                  <div className="text-[12px] font-semibold text-[var(--color-foreground)] mb-2">
                    {labelForClass(cls.type)}
                    <span className="ml-2 text-[10px] text-[var(--color-foreground-muted)] font-mono">
                      type={cls.type} · grid {cls.width}×{cls.height}
                    </span>
                  </div>

                  <FieldGrid>
                    <Field label="Sensitivity" hint="0–100; higher = more sensitive">
                      <RangeInput
                        value={cls.sensitivity}
                        min={0}
                        max={100}
                        onChange={(v) => updateAi(idx, { sensitivity: v })}
                        disabled={saving}
                      />
                    </Field>
                    <Field label="Stay time" hint="0 = trigger on first detection">
                      <RangeInput
                        value={cls.stayTime}
                        min={0}
                        max={600}
                        step={5}
                        unit="s"
                        onChange={(v) => updateAi(idx, { stayTime: v })}
                        disabled={saving}
                      />
                    </Field>
                  </FieldGrid>

                  <div className="mt-3">
                    <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)] mb-1">
                      Target size (drag rectangles to set min/max)
                    </div>
                    <TargetSizeOverlay
                      snapshotUrl={snapshotUrl}
                      minSize={{
                        width: cls.minTargetWidth,
                        height: cls.minTargetHeight,
                      }}
                      maxSize={{
                        width: cls.maxTargetWidth,
                        height: cls.maxTargetHeight,
                      }}
                      onMinChange={(s) =>
                        updateAi(idx, {
                          minTargetWidth: s.width,
                          minTargetHeight: s.height,
                        })
                      }
                      onMaxChange={(s) =>
                        updateAi(idx, {
                          maxTargetWidth: s.width,
                          maxTargetHeight: s.height,
                        })
                      }
                      disabled={saving}
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => toggleArea(cls.type)}
                    className="mt-3 inline-flex items-center gap-1 text-[11px] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]"
                  >
                    {areaOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    Detection area mask ({cls.areaCells.filter(Boolean).length} of{" "}
                    {cls.areaCells.length} cells)
                  </button>
                  {areaOpen && (
                    <div className="mt-3">
                      <BitmapGridEditor
                        cells={cls.areaCells}
                        width={cls.width}
                        height={cls.height}
                        snapshotUrl={snapshotUrl}
                        onCellsChange={(next) =>
                          updateAi(idx, { areaCells: next })
                        }
                        disabled={saving}
                      />
                    </div>
                  )}
                </div>
              );
            })}
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
