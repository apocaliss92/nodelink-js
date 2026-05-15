import { useEffect, useState, useCallback } from "react";
import { X, RefreshCw, Save, Loader2 } from "lucide-react";
import { trpcQuery, trpcMutation } from "../../api";

/**
 * Stream encoding settings panel. Reads `getEncOptions` (cmd_146) and the
 * current `getStreamMetadata` (cmd_56) from the camera, then renders one
 * editor per profile (mainStream / subStream / thirdStream) with selectors
 * populated EXCLUSIVELY from values the camera reports as supported.
 *
 * Picking an unsupported combination causes the camera to reject the
 * SET_ENC command, so we filter the dropdowns aggressively rather than show
 * everything and surface a 400 to the user.
 */

type ProfileKey = "mainStream" | "subStream" | "thirdStream";

interface ResolutionOpt {
  width: number;
  height: number;
  videoEncTypes: Array<"h264" | "h265">;
  framerateOptions: number[];
  bitrateOptions: number[];
  defaultFramerate?: number;
  defaultBitrate?: number;
}

interface StreamOpt {
  type: ProfileKey;
  resolutions: ResolutionOpt[];
  encoderTypes: Array<"vbr" | "cbr">;
  encoderProfiles: Array<"high" | "main" | "baseline">;
}

interface EncOptions {
  channel: number;
  mainStream?: StreamOpt;
  subStream?: StreamOpt;
  thirdStream?: StreamOpt;
}

interface StreamMetadata {
  channel: number;
  streams: Array<{
    profile: "main" | "sub" | "ext";
    audio: number;
    width: number;
    height: number;
    videoEncType: string;
    videoEncTypeInt: number;
    frameRate: number;
    bitRate: number;
  }>;
}

interface ProfileForm {
  width: number;
  height: number;
  bitRate: number;
  frameRate: number;
  videoEncType: "h264" | "h265";
  audio: 0 | 1;
}

const PROFILE_LABELS: Record<ProfileKey, string> = {
  mainStream: "Main",
  subStream: "Sub",
  thirdStream: "Ext",
};

const PROFILE_TO_API: Record<ProfileKey, "main" | "sub" | "ext"> = {
  mainStream: "main",
  subStream: "sub",
  thirdStream: "ext",
};

interface StreamSettingsPanelProps {
  cameraId: string;
  channel: number;
  onClose: () => void;
}

export function StreamSettingsPanel({
  cameraId,
  channel,
  onClose,
}: StreamSettingsPanelProps) {
  const [options, setOptions] = useState<EncOptions | null>(null);
  const [current, setCurrent] = useState<StreamMetadata | null>(null);
  const [forms, setForms] = useState<Partial<Record<ProfileKey, ProfileForm>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<ProfileKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [opts, meta] = await Promise.all([
        trpcQuery<EncOptions>("baichuan.getEncOptions", { cameraId, channel }),
        trpcQuery<StreamMetadata>("baichuan.getStreamMetadata", { cameraId, channel }),
      ]);
      setOptions(opts);
      setCurrent(meta);
      // Seed each profile's form from the current metadata.
      const seeded: Partial<Record<ProfileKey, ProfileForm>> = {};
      for (const key of ["mainStream", "subStream", "thirdStream"] as const) {
        const apiName = PROFILE_TO_API[key];
        const cur = meta.streams.find((s) => s.profile === apiName);
        if (!cur) continue;
        seeded[key] = {
          width: cur.width,
          height: cur.height,
          bitRate: cur.bitRate,
          frameRate: cur.frameRate,
          videoEncType: cur.videoEncTypeInt === 1 ? "h265" : "h264",
          audio: cur.audio === 1 ? 1 : 0,
        };
      }
      setForms(seeded);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cameraId, channel]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateForm = (key: ProfileKey, patch: Partial<ProfileForm>) => {
    setForms((prev) => ({
      ...prev,
      [key]: { ...(prev[key] as ProfileForm), ...patch },
    }));
  };

  const onResolutionChange = (key: ProfileKey, resKey: string) => {
    const opt = options?.[key];
    if (!opt) return;
    const [w, h] = resKey.split("x").map(Number);
    const res = opt.resolutions.find((r) => r.width === w && r.height === h);
    if (!res) return;
    const cur = forms[key];
    if (!cur) return;
    // Snap framerate / bitrate / codec to the new resolution's allowed values.
    const newCodec = res.videoEncTypes.includes(cur.videoEncType)
      ? cur.videoEncType
      : (res.videoEncTypes[0] ?? cur.videoEncType);
    const newFps = res.framerateOptions.includes(cur.frameRate)
      ? cur.frameRate
      : (res.defaultFramerate ?? res.framerateOptions[0] ?? cur.frameRate);
    const newBitrate = res.bitrateOptions.includes(cur.bitRate)
      ? cur.bitRate
      : (res.defaultBitrate ?? res.bitrateOptions[0] ?? cur.bitRate);
    updateForm(key, {
      width: w!,
      height: h!,
      videoEncType: newCodec,
      frameRate: newFps,
      bitRate: newBitrate,
    });
  };

  const apply = async (key: ProfileKey) => {
    if (!forms[key]) return;
    setSaving(key);
    setError(null);
    setSuccess(null);
    try {
      const f = forms[key]!;
      await trpcMutation("baichuan.setEnc", {
        cameraId,
        channel,
        [key]: {
          width: f.width,
          height: f.height,
          bitRate: f.bitRate,
          frameRate: f.frameRate,
          videoEncType: f.videoEncType,
          audio: f.audio,
        },
      });
      setSuccess(`${PROFILE_LABELS[key]} stream updated`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="rounded-lg bg-[var(--color-surface)] p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
          Stream Settings
        </div>
        <div className="flex items-center gap-1">
          <button
            className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)]"
            onClick={() => void refresh()}
            title="Refresh"
            disabled={loading}
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)]"
            onClick={onClose}
            title="Close"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-2 text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-2 text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded px-2 py-1">
          {success}
        </div>
      )}

      {loading && !options && (
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-foreground-muted)] py-2">
          <Loader2 size={12} className="animate-spin" />
          Loading camera options…
        </div>
      )}

      {options && (
        <div className="flex flex-col gap-3">
          {(["mainStream", "subStream", "thirdStream"] as const).map((key) => {
            const opt = options[key];
            const form = forms[key];
            if (!opt || !form) return null;
            const cur = current?.streams.find(
              (s) => s.profile === PROFILE_TO_API[key],
            );
            const selectedRes = opt.resolutions.find(
              (r) => r.width === form.width && r.height === form.height,
            );
            return (
              <div
                key={key}
                className="rounded-md border border-[var(--color-border)] p-2"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[12px] font-semibold text-[var(--color-foreground)]">
                    {PROFILE_LABELS[key]}
                  </div>
                  {cur && (
                    <div className="text-[10px] text-[var(--color-foreground-muted)] font-mono">
                      now: {cur.width}×{cur.height} {cur.videoEncType} {cur.frameRate}fps {cur.bitRate}kbps
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <FormField label="Resolution">
                    <select
                      className="select"
                      value={`${form.width}x${form.height}`}
                      onChange={(e) => onResolutionChange(key, e.target.value)}
                    >
                      {opt.resolutions.map((r) => (
                        <option key={`${r.width}x${r.height}`} value={`${r.width}x${r.height}`}>
                          {r.width}×{r.height}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Codec">
                    <select
                      className="select"
                      value={form.videoEncType}
                      onChange={(e) =>
                        updateForm(key, {
                          videoEncType: e.target.value as "h264" | "h265",
                        })
                      }
                    >
                      {(selectedRes?.videoEncTypes ?? []).map((c) => (
                        <option key={c} value={c}>
                          {c.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Frame rate">
                    <select
                      className="select"
                      value={form.frameRate}
                      onChange={(e) =>
                        updateForm(key, { frameRate: Number(e.target.value) })
                      }
                    >
                      {(selectedRes?.framerateOptions ?? [form.frameRate]).map((f) => (
                        <option key={f} value={f}>
                          {f} fps
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Bitrate">
                    <select
                      className="select"
                      value={form.bitRate}
                      onChange={(e) =>
                        updateForm(key, { bitRate: Number(e.target.value) })
                      }
                    >
                      {(selectedRes?.bitrateOptions ?? [form.bitRate]).map((b) => (
                        <option key={b} value={b}>
                          {b} kbps
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Audio">
                    <select
                      className="select"
                      value={form.audio}
                      onChange={(e) =>
                        updateForm(key, { audio: e.target.value === "1" ? 1 : 0 })
                      }
                    >
                      <option value="1">On</option>
                      <option value="0">Off</option>
                    </select>
                  </FormField>
                </div>
                <div className="flex justify-end mt-2">
                  <button
                    className="flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 px-3 py-1 text-[11px] hover:bg-emerald-500/20 disabled:opacity-50"
                    onClick={() => void apply(key)}
                    disabled={saving !== null}
                  >
                    {saving === key ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Save size={12} />
                    )}
                    Apply
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <style>{`
        .select {
          width: 100%;
          background: var(--color-background);
          color: var(--color-foreground);
          border: 1px solid var(--color-border);
          border-radius: 4px;
          padding: 3px 6px;
          font-size: 11px;
        }
      `}</style>
    </div>
  );
}

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
        {label}
      </span>
      {children}
    </label>
  );
}
