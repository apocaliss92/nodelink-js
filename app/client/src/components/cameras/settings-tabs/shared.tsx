/**
 * Primitives shared by every CameraSettingsModal tab — small enough to live
 * in one file. Each tab pulls its own data via tRPC, owns a local form state,
 * and uses these wrappers for layout consistency.
 */
import { type ReactNode, useState, useEffect, useCallback } from "react";
import { Loader2, Save, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";
import { trpcQuery, trpcMutation } from "../../../api";

export interface TabProps {
  cameraId: string;
  channel: number;
}

interface SectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function Section({ title, description, children }: SectionProps) {
  return (
    <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-[var(--color-foreground)]">{title}</h3>
        {description && (
          <p className="text-[11px] text-[var(--color-foreground-muted)] mt-0.5">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

export function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>;
}

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">{label}</span>
      {children}
      {hint && (
        <span className="text-[10px] text-[var(--color-foreground-muted)]">{hint}</span>
      )}
    </label>
  );
}

const baseInput =
  "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-accent,#22d3ee)]";

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  disabled,
}: {
  value: number | undefined;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      className={baseInput}
      value={value ?? ""}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

export function TextInput({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: string | undefined;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      className={baseInput}
      value={value ?? ""}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T | undefined;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <select
      className={baseInput}
      value={String(value ?? "")}
      disabled={disabled}
      onChange={(e) => {
        const raw = e.target.value;
        const opt = options.find((o) => String(o.value) === raw);
        if (opt) onChange(opt.value);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  value,
  onChange,
  disabled,
  labelOn = "On",
  labelOff = "Off",
}: {
  value: boolean | undefined;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  labelOn?: string;
  labelOff?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${
        value
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
          : "border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground-muted)]"
      }`}
    >
      {value ? labelOn : labelOff}
    </button>
  );
}

export function ApplyBar({
  dirty,
  saving,
  saved,
  error,
  onApply,
  onRevert,
  onRefresh,
}: {
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
  onApply: () => void;
  onRevert?: () => void;
  onRefresh?: () => void;
}) {
  return (
    <div className="sticky bottom-0 -mx-4 px-4 pt-3 pb-1 mt-2 bg-gradient-to-t from-[var(--color-background)] via-[var(--color-background)] to-transparent flex items-center gap-2">
      {error && (
        <span className="flex items-center gap-1 text-[11px] text-red-300">
          <AlertCircle size={12} /> {error}
        </span>
      )}
      {saved && !dirty && !error && (
        <span className="flex items-center gap-1 text-[11px] text-emerald-300">
          <CheckCircle2 size={12} /> Saved
        </span>
      )}
      <span className="flex-1" />
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={saving}
          className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground-muted)] px-3 py-1.5 text-xs hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          <RefreshCw size={12} />
          Refresh
        </button>
      )}
      {onRevert && (
        <button
          type="button"
          onClick={onRevert}
          disabled={!dirty || saving}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground-muted)] px-3 py-1.5 text-xs hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          Revert
        </button>
      )}
      <button
        type="button"
        onClick={onApply}
        disabled={!dirty || saving}
        className="flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 px-3 py-1.5 text-xs hover:bg-emerald-500/20 disabled:opacity-50"
      >
        {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
        Apply
      </button>
    </div>
  );
}

/**
 * Recursively search a parsed-XML JSON object for the FIRST string/number
 * leaf with the given tag name. The library returns
 * `parseXmlFragmentToJson(...)` output where the actual fields live
 * deep inside the response — `<body><VideoInput><bright>128</bright>...</VideoInput></body>`
 * becomes `{body: {VideoInput: {bright: 128}}}`. Different cmd_ids nest
 * differently (and the same cmd_id may even nest differently across
 * firmwares), so every tab has to walk the result rather than guess.
 */
export function findValue(obj: unknown, key: string): string | number | undefined {
  const stack: unknown[] = [obj];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    const rec = node as Record<string, unknown>;
    const v = rec[key];
    if (typeof v === "string" || typeof v === "number") return v;
    for (const child of Object.values(rec)) {
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return undefined;
}

/** Same as `findValue`, coerced to a number. Returns `undefined` if absent or not numeric. */
export function findNumber(obj: unknown, key: string): number | undefined {
  const v = findValue(obj, key);
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return undefined;
}

/** Same as `findValue`, coerced to a string. Returns `undefined` if absent. */
export function findString(obj: unknown, key: string): string | undefined {
  const v = findValue(obj, key);
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

/**
 * Generic load+save lifecycle wrapper for a settings tab.
 *
 *   - Calls `getProcedure` on mount to populate the form.
 *   - Tracks "dirty" by deep-comparing the current form against the last
 *     loaded snapshot.
 *   - Apply runs `setProcedure(formBuilder(form))` and refreshes from the
 *     server.
 *   - Surfaces the standard ApplyBar at the bottom.
 */
export function useSettingsForm<G, F>(opts: {
  getProcedure: string;
  channel: number;
  cameraId: string;
  toForm: (data: G) => F;
}) {
  const [loaded, setLoaded] = useState<F | null>(null);
  const [form, setForm] = useState<F | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await trpcQuery<G>(opts.getProcedure, {
        cameraId: opts.cameraId,
        channel: opts.channel,
      });
      const f = opts.toForm(data);
      setLoaded(f);
      setForm(f);
      setSaved(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [opts]);

  useEffect(() => {
    void refresh();
  }, [opts.cameraId, opts.channel]);

  const dirty = JSON.stringify(loaded) !== JSON.stringify(form);

  const apply = useCallback(async (mutationName: string, buildInput: (f: F) => Record<string, unknown>) => {
    if (!form) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await trpcMutation(mutationName, {
        cameraId: opts.cameraId,
        channel: opts.channel,
        ...buildInput(form),
      });
      setSaved(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [form, opts.cameraId, opts.channel, refresh]);

  return {
    loaded,
    form,
    setForm,
    error,
    saving,
    saved,
    dirty,
    loading,
    refresh,
    revert: () => { if (loaded) setForm(loaded); },
    apply,
  };
}
