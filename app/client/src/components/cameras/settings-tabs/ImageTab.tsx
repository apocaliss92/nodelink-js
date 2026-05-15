import {
  Section,
  FieldGrid,
  Field,
  NumberInput,
  ApplyBar,
  useSettingsForm,
  type TabProps,
} from "./shared";

interface ImageGet {
  bright?: number;
  contrast?: number;
  saturation?: number;
  hue?: number;
  sharpen?: number;
}

type Form = ImageGet;

export function ImageTab({ cameraId, channel }: TabProps) {
  const { form, setForm, dirty, saving, saved, error, apply, revert, refresh, loading } =
    useSettingsForm<ImageGet, Form>({
      getProcedure: "baichuan.getImage",
      cameraId,
      channel,
      toForm: (data) => ({
        bright: data.bright,
        contrast: data.contrast,
        saturation: data.saturation,
        hue: data.hue,
        sharpen: data.sharpen,
      }),
    });

  const updateField = (key: keyof Form, value: number): void => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  return (
    <div>
      <Section
        title="Image quality"
        description="Image processor (ISP) parameters. Reolink uses a 0–255 range for every slider; defaults are around 128."
      >
        {loading || !form ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-4">
            Loading…
          </div>
        ) : (
          <FieldGrid>
            <Field label="Brightness" hint="0–255">
              <NumberInput value={form.bright} min={0} max={255} onChange={(v) => updateField("bright", v)} disabled={saving} />
            </Field>
            <Field label="Contrast" hint="0–255">
              <NumberInput value={form.contrast} min={0} max={255} onChange={(v) => updateField("contrast", v)} disabled={saving} />
            </Field>
            <Field label="Saturation" hint="0–255">
              <NumberInput value={form.saturation} min={0} max={255} onChange={(v) => updateField("saturation", v)} disabled={saving} />
            </Field>
            <Field label="Hue" hint="0–255">
              <NumberInput value={form.hue} min={0} max={255} onChange={(v) => updateField("hue", v)} disabled={saving} />
            </Field>
            <Field label="Sharpen" hint="0–255">
              <NumberInput value={form.sharpen} min={0} max={255} onChange={(v) => updateField("sharpen", v)} disabled={saving} />
            </Field>
          </FieldGrid>
        )}
      </Section>

      <ApplyBar
        dirty={dirty}
        saving={saving}
        saved={saved}
        error={error}
        onApply={() =>
          void apply("baichuan.setImage", (f) => ({
            bright: f.bright,
            contrast: f.contrast,
            saturation: f.saturation,
            hue: f.hue,
            sharpen: f.sharpen,
          }))
        }
        onRevert={revert}
        onRefresh={() => void refresh()}
      />
    </div>
  );
}
