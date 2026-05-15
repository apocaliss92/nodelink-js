import {
  Section,
  FieldGrid,
  Field,
  TextInput,
  Toggle,
  Select,
  ApplyBar,
  useSettingsForm,
  type TabProps,
} from "./shared";

interface OsdConfig {
  channel: number;
  osdChannel: { enable: number; name: string; pos: string };
  osdTime: { enable: number; pos: string };
  watermark: number;
  bgcolor?: number;
}

interface Form {
  channelName: string;
  channelEnable: boolean;
  channelPos: string;
  timeEnable: boolean;
  timePos: string;
  watermark: boolean;
  bgcolor: boolean | undefined;
}

const POS_OPTIONS = [
  { value: "topLeft", label: "Top left" },
  { value: "topCenter", label: "Top center" },
  { value: "topRight", label: "Top right" },
  { value: "lowerLeft", label: "Bottom left" },
  { value: "lowerCenter", label: "Bottom center" },
  { value: "lowerRight", label: "Bottom right" },
];

export function OsdTab({ cameraId, channel }: TabProps) {
  const { form, setForm, dirty, saving, saved, error, apply, revert, refresh, loading } =
    useSettingsForm<OsdConfig, Form>({
      getProcedure: "baichuan.getOsd",
      cameraId,
      channel,
      toForm: (d) => ({
        channelName: d.osdChannel.name,
        channelEnable: d.osdChannel.enable === 1,
        channelPos: d.osdChannel.pos,
        timeEnable: d.osdTime.enable === 1,
        timePos: d.osdTime.pos,
        watermark: d.watermark === 1,
        bgcolor: d.bgcolor === undefined ? undefined : d.bgcolor === 1,
      }),
    });

  const update = <K extends keyof Form>(key: K, value: Form[K]): void => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  return (
    <div>
      <Section
        title="On-screen overlay"
        description="Text Reolink burns into the encoded video. Datetime is the timestamp the camera draws in the corner; channel name is the friendly label."
      >
        {loading || !form ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-4">Loading…</div>
        ) : (
          <FieldGrid>
            <Field label="Show channel name">
              <Toggle
                value={form.channelEnable}
                onChange={(v) => update("channelEnable", v)}
                disabled={saving}
              />
            </Field>
            <Field label="Channel name">
              <TextInput value={form.channelName} onChange={(v) => update("channelName", v)} disabled={saving || !form.channelEnable} />
            </Field>
            <Field label="Channel name position">
              <Select
                value={form.channelPos}
                onChange={(v) => update("channelPos", v)}
                disabled={saving || !form.channelEnable}
                options={POS_OPTIONS}
              />
            </Field>
            <Field label="Show timestamp">
              <Toggle value={form.timeEnable} onChange={(v) => update("timeEnable", v)} disabled={saving} />
            </Field>
            <Field label="Timestamp position">
              <Select
                value={form.timePos}
                onChange={(v) => update("timePos", v)}
                disabled={saving || !form.timeEnable}
                options={POS_OPTIONS}
              />
            </Field>
            <Field label="Watermark">
              <Toggle value={form.watermark} onChange={(v) => update("watermark", v)} disabled={saving} />
            </Field>
            {form.bgcolor !== undefined && (
              <Field label="Background color">
                <Toggle value={form.bgcolor} onChange={(v) => update("bgcolor", v)} disabled={saving} />
              </Field>
            )}
          </FieldGrid>
        )}
      </Section>

      <ApplyBar
        dirty={dirty}
        saving={saving}
        saved={saved}
        error={error}
        onApply={() =>
          void apply("baichuan.setOsd", (f) => ({
            osd: {
              channel,
              osdChannel: {
                enable: f.channelEnable ? 1 : 0,
                name: f.channelName,
                pos: f.channelPos,
              },
              osdTime: {
                enable: f.timeEnable ? 1 : 0,
                pos: f.timePos,
              },
              watermark: f.watermark ? 1 : 0,
              ...(f.bgcolor !== undefined
                ? { bgcolor: f.bgcolor ? 1 : 0 }
                : {}),
            },
          }))
        }
        onRevert={revert}
        onRefresh={() => void refresh()}
      />
    </div>
  );
}
