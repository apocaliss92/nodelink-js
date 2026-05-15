import {
  Section,
  FieldGrid,
  Field,
  TextInput,
  NumberInput,
  Toggle,
  Select,
  ApplyBar,
  useSettingsForm,
  type TabProps,
} from "./shared";

/**
 * Reolink's actual OSD payload (cmd_44 GetOsdDatetime / cmd_45 SetOsdDatetime)
 * splits into two top-level XML blocks: `<OsdDatetime>` for the timestamp
 * burn-in and `<OsdChannelName>` for the friendly camera name. Position is
 * given in **camera pixel coordinates** — (1, 1) is top-left; 65536 is the
 * sentinel some firmwares use for "hidden". The OSD tab edits both blocks
 * in one form.
 *
 * Note: the library also exposes a legacy `setOsd` (cmd_25, write-through
 * via the Image config) which we keep for older firmwares. This tab uses
 * `setOsdDatetime` which is what current Reolink builds expect.
 */
type OsdDatetimeResult = {
  osdDatetime?: {
    channelId?: number;
    enable?: boolean;
    topLeftX?: number;
    topLeftY?: number;
    width?: number;
    height?: number;
    language?: string;
  };
  osdChannelName?: {
    channelId?: number;
    name?: string;
    enable?: boolean;
    topLeftX?: number;
    topLeftY?: number;
    enWatermark?: boolean;
    enBgcolor?: boolean;
  };
};

interface Form {
  timeEnable: boolean;
  timeX: number;
  timeY: number;
  language: string;
  nameEnable: boolean;
  name: string;
  nameX: number;
  nameY: number;
  watermark: boolean;
  bgcolor: boolean;
}

const LANGUAGE_OPTIONS = [
  { value: "English", label: "English" },
  { value: "Chinese", label: "Chinese" },
  { value: "German", label: "German" },
  { value: "French", label: "French" },
  { value: "Spanish", label: "Spanish" },
  { value: "Italian", label: "Italian" },
  { value: "Russian", label: "Russian" },
  { value: "Polish", label: "Polish" },
  { value: "Czech", label: "Czech" },
];

export function OsdTab({ cameraId, channel }: TabProps) {
  const { form, setForm, dirty, saving, saved, error, apply, revert, refresh, loading } =
    useSettingsForm<OsdDatetimeResult, Form>({
      getProcedure: "baichuan.getOsdDatetime",
      cameraId,
      channel,
      toForm: (d) => ({
        timeEnable: d.osdDatetime?.enable === true,
        timeX: d.osdDatetime?.topLeftX ?? 1,
        timeY: d.osdDatetime?.topLeftY ?? 1,
        language: d.osdDatetime?.language ?? "English",
        nameEnable: d.osdChannelName?.enable === true,
        name: d.osdChannelName?.name ?? "",
        nameX: d.osdChannelName?.topLeftX ?? 1,
        nameY: d.osdChannelName?.topLeftY ?? 1,
        watermark: d.osdChannelName?.enWatermark === true,
        bgcolor: d.osdChannelName?.enBgcolor === true,
      }),
    });

  const update = <K extends keyof Form>(key: K, value: Form[K]): void => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  return (
    <div>
      <Section
        title="Timestamp overlay"
        description="The clock the camera burns into the encoded video. Position is in camera pixels — (1, 1) is the top-left corner."
      >
        {loading || !form ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-4">Loading…</div>
        ) : (
          <FieldGrid>
            <Field label="Show timestamp">
              <Toggle value={form.timeEnable} onChange={(v) => update("timeEnable", v)} disabled={saving} />
            </Field>
            <Field label="Language">
              <Select
                value={form.language}
                onChange={(v) => update("language", v)}
                disabled={saving || !form.timeEnable}
                options={LANGUAGE_OPTIONS}
              />
            </Field>
            <Field label="Position X (px)">
              <NumberInput value={form.timeX} min={0} onChange={(v) => update("timeX", v)} disabled={saving || !form.timeEnable} />
            </Field>
            <Field label="Position Y (px)">
              <NumberInput value={form.timeY} min={0} onChange={(v) => update("timeY", v)} disabled={saving || !form.timeEnable} />
            </Field>
          </FieldGrid>
        )}
      </Section>

      <Section
        title="Channel name overlay"
        description="The friendly camera label burned into the picture (independent of the dashboard name). Some firmwares display 65536 for an unset position — change to a real coordinate to make it visible."
      >
        {loading || !form ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-4">Loading…</div>
        ) : (
          <FieldGrid>
            <Field label="Show channel name">
              <Toggle value={form.nameEnable} onChange={(v) => update("nameEnable", v)} disabled={saving} />
            </Field>
            <Field label="Channel name">
              <TextInput value={form.name} onChange={(v) => update("name", v)} disabled={saving || !form.nameEnable} />
            </Field>
            <Field label="Position X (px)">
              <NumberInput value={form.nameX} min={0} onChange={(v) => update("nameX", v)} disabled={saving || !form.nameEnable} />
            </Field>
            <Field label="Position Y (px)">
              <NumberInput value={form.nameY} min={0} onChange={(v) => update("nameY", v)} disabled={saving || !form.nameEnable} />
            </Field>
            <Field label="Watermark">
              <Toggle value={form.watermark} onChange={(v) => update("watermark", v)} disabled={saving} />
            </Field>
            <Field label="Background color">
              <Toggle value={form.bgcolor} onChange={(v) => update("bgcolor", v)} disabled={saving} />
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
          void apply("baichuan.setOsdDatetime", (f) => ({
            datetime: {
              enable: f.timeEnable,
              topLeftX: f.timeX,
              topLeftY: f.timeY,
              language: f.language,
            },
            channelName: {
              name: f.name,
              enable: f.nameEnable,
              topLeftX: f.nameX,
              topLeftY: f.nameY,
              enWatermark: f.watermark,
              enBgcolor: f.bgcolor,
            },
          }))
        }
        onRevert={revert}
        onRefresh={() => void refresh()}
      />
    </div>
  );
}
