import { useCallback, useEffect, useState } from "react";
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

interface AudioCfg {
  volume?: number;
  talkAndReplyVolume?: number;
  visitorVolume?: number;
  visitorLoudspeaker?: number;
  [k: string]: unknown;
}

interface AudioNoise {
  enable?: number;
  level?: number;
  [k: string]: unknown;
}

interface Form {
  volume?: number;
  talkAndReplyVolume?: number;
  visitorVolume?: number;
  visitorLoudspeaker: boolean;
  noiseEnabled: boolean;
  noiseLevel: number;
}

const cfgFromRaw = (
  cfg: AudioCfg | null,
  noise: AudioNoise | null,
): Form => ({
  volume: findNumber(cfg, "volume"),
  talkAndReplyVolume: findNumber(cfg, "talkAndReplyVolume"),
  visitorVolume: findNumber(cfg, "visitorVolume"),
  visitorLoudspeaker: findNumber(cfg, "visitorLoudspeaker") === 1,
  noiseEnabled: findNumber(noise, "enable") === 1,
  noiseLevel: findNumber(noise, "level") ?? 50,
});

export function AudioTab({ cameraId, channel }: TabProps) {
  const [form, setForm] = useState<Form | null>(null);
  const [loaded, setLoaded] = useState<Form | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfg, noise] = await Promise.all([
        trpcQuery<AudioCfg | null>("baichuan.getAudioCfg", { cameraId, channel }).catch(() => null),
        trpcQuery<AudioNoise | null>("baichuan.getAudioNoise", { cameraId, channel }).catch(() => null),
      ]);
      const f = cfgFromRaw(cfg, noise);
      setForm(f);
      setLoaded(f);
      setSaved(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cameraId, channel]);

  useEffect(() => { void refresh(); }, [refresh]);

  const dirty = JSON.stringify(loaded) !== JSON.stringify(form);

  const apply = useCallback(async () => {
    if (!form || !loaded) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // Two independent commands, sent in parallel. Either may fail
      // (e.g. AI noise unsupported on this firmware); we surface the
      // first error but still let the rest go through.
      const ops: Array<Promise<unknown>> = [];
      if (
        form.volume !== loaded.volume ||
        form.talkAndReplyVolume !== loaded.talkAndReplyVolume ||
        form.visitorVolume !== loaded.visitorVolume ||
        form.visitorLoudspeaker !== loaded.visitorLoudspeaker
      ) {
        ops.push(
          trpcMutation("baichuan.setAudioCfg", {
            cameraId,
            channel,
            volume: form.volume,
            talkAndReplyVolume: form.talkAndReplyVolume,
            visitorVolume: form.visitorVolume,
            visitorLoudspeaker: form.visitorLoudspeaker ? 1 : 0,
          }),
        );
      }
      if (
        form.noiseEnabled !== loaded.noiseEnabled ||
        form.noiseLevel !== loaded.noiseLevel
      ) {
        ops.push(
          trpcMutation("baichuan.setAudioNoise", {
            cameraId,
            channel,
            level: form.noiseEnabled ? form.noiseLevel : 0,
          }),
        );
      }
      await Promise.all(ops);
      setSaved(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [form, loaded, cameraId, channel, refresh]);

  const update = <K extends keyof Form>(key: K, value: Form[K]): void => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  return (
    <div>
      <Section
        title="Speaker volumes"
        description="Volumes Reolink exposes for the camera's built-in speaker. 0–100 range; defaults vary by model."
      >
        {loading || !form ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-4">Loading…</div>
        ) : (
          <FieldGrid>
            <Field label="Speaker volume">
              <RangeInput value={form.volume} min={0} max={100} onChange={(v) => update("volume", v)} disabled={saving} />
            </Field>
            <Field label="Talk-and-reply volume" hint="Doorbell / intercom only">
              <RangeInput value={form.talkAndReplyVolume} min={0} max={100} onChange={(v) => update("talkAndReplyVolume", v)} disabled={saving} />
            </Field>
            <Field label="Visitor volume" hint="Pre-set greeting clips">
              <RangeInput value={form.visitorVolume} min={0} max={100} onChange={(v) => update("visitorVolume", v)} disabled={saving} />
            </Field>
            <Field label="Visitor loudspeaker">
              <Toggle value={form.visitorLoudspeaker} onChange={(v) => update("visitorLoudspeaker", v)} disabled={saving} />
            </Field>
          </FieldGrid>
        )}
      </Section>

      <Section
        title="AI noise reduction"
        description="On-device denoiser applied to the camera mic. Some models silently ignore the field — if Apply succeeds but nothing changes, your firmware doesn't support it."
      >
        {loading || !form ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-4">Loading…</div>
        ) : (
          <FieldGrid>
            <Field label="Enabled">
              <Toggle value={form.noiseEnabled} onChange={(v) => update("noiseEnabled", v)} disabled={saving} />
            </Field>
            <Field label="Level" hint="1–100 (only applied when enabled)">
              <RangeInput
                value={form.noiseLevel}
                min={1}
                max={100}
                onChange={(v) => update("noiseLevel", v)}
                disabled={saving || !form.noiseEnabled}
              />
            </Field>
          </FieldGrid>
        )}
      </Section>

      <ApplyBar
        dirty={dirty}
        saving={saving}
        saved={saved}
        error={error}
        onApply={() => void apply()}
        onRevert={() => setForm(loaded)}
        onRefresh={() => void refresh()}
      />
    </div>
  );
}
