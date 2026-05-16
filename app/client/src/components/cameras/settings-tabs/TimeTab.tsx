import { useCallback, useEffect, useState } from "react";
import { Loader2, Save, RefreshCw } from "lucide-react";
import { Button } from "@camstack/ui-library";
import {
  Section,
  FieldGrid,
  Field,
  TextInput,
  Select,
  Toggle,
  NumberInput,
  type TabProps,
} from "./shared";
import { trpcQuery, trpcMutation } from "../../../api";

/**
 * Time tab — clock-only settings:
 *
 * - Timezone (cmd_id 105 partial patch).
 * - Manual clock (cmd_id 105 with year+month+day+hour+minute+second).
 * - NTP (cmd_id 38 / 39).
 * - DST (cmd_id 106 / 107).
 *
 * Display format, language, device name and auto-reboot live in the
 * General tab — they're not "time" per se.
 */

const TIME_ZONE_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: "UTC-12:00", seconds: 43200 },
  { label: "UTC-11:00", seconds: 39600 },
  { label: "UTC-10:00 (Hawaii)", seconds: 36000 },
  { label: "UTC-08:00 (Los Angeles)", seconds: 28800 },
  { label: "UTC-05:00 (New York)", seconds: 18000 },
  { label: "UTC+00:00 (UTC)", seconds: 0 },
  { label: "UTC+01:00 (Rome / Berlin)", seconds: -3600 },
  { label: "UTC+02:00 (Helsinki / Cairo)", seconds: -7200 },
  { label: "UTC+03:00 (Moscow)", seconds: -10800 },
  { label: "UTC+05:30 (India)", seconds: -19800 },
  { label: "UTC+08:00 (Beijing / Shanghai)", seconds: -28800 },
  { label: "UTC+09:00 (Tokyo)", seconds: -32400 },
  { label: "UTC+10:00 (Sydney)", seconds: -36000 },
  { label: "UTC+12:00 (Auckland)", seconds: -43200 },
];

interface SystemGeneral {
  timeZone: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  isDst: 0 | 1;
}

interface NtpConfig {
  enable: 0 | 1;
  server: string;
  synchronizeInterval: number;
  port: number;
}

interface DstConfig {
  enable: 0 | 1;
  offset: number;
  startMonth: number;
  startWeekIndex: number;
  startWeekday:
    | "Sunday"
    | "Monday"
    | "Tuesday"
    | "Wednesday"
    | "Thursday"
    | "Friday"
    | "Saturday";
  startHour: number;
  startMinute: number;
  startSecond: number;
  endMonth: number;
  endWeekIndex: number;
  endWeekday: DstConfig["startWeekday"];
  endHour: number;
  endMinute: number;
  endSecond: number;
}

function formatTimezone(seconds: number): string {
  // POSIX convention: UTC+1 → -3600. Flip the sign for display.
  const display = -seconds;
  const hours = Math.trunc(display / 3600);
  const minutes = Math.abs((display % 3600) / 60);
  const sign = hours >= 0 ? "+" : "-";
  return `UTC${sign}${Math.abs(hours).toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}`;
}

export function TimeTab({ cameraId, channel: _channel }: TabProps) {
  void _channel; // host-level commands
  const [sys, setSys] = useState<SystemGeneral | null>(null);
  const [sysSnapshot, setSysSnapshot] = useState<SystemGeneral | null>(null);
  const [ntp, setNtp] = useState<NtpConfig | null>(null);
  const [ntpSnapshot, setNtpSnapshot] = useState<NtpConfig | null>(null);
  const [dst, setDst] = useState<DstConfig | null>(null);
  const [dstSnapshot, setDstSnapshot] = useState<DstConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    null | "timezone" | "manualTime" | "ntp" | "dst"
  >(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sg, n, d] = await Promise.all([
        trpcQuery<SystemGeneral>("baichuan.getSystemGeneral", { cameraId }),
        trpcQuery<NtpConfig>("baichuan.getNtp", { cameraId }),
        trpcQuery<DstConfig>("baichuan.getDst", { cameraId }),
      ]);
      setSys(sg);
      setSysSnapshot(sg);
      setNtp(n);
      setNtpSnapshot(n);
      setDst(d);
      setDstSnapshot(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cameraId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const showFeedback = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 4000);
  };

  const applySystemGeneral = async (
    patch: Partial<SystemGeneral> & {
      manualTime?: {
        year: number;
        month: number;
        day: number;
        hour: number;
        minute: number;
        second: number;
      };
    },
    busyKey: "timezone" | "manualTime",
  ) => {
    setBusy(busyKey);
    setError(null);
    try {
      await trpcMutation("baichuan.setSystemGeneral", { cameraId, ...patch });
      showFeedback("Saved");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const applyNtp = async () => {
    if (!ntp) return;
    setBusy("ntp");
    setError(null);
    try {
      await trpcMutation("baichuan.setNtp", {
        cameraId,
        enable: ntp.enable,
        server: ntp.server,
        synchronizeInterval: ntp.synchronizeInterval,
        port: ntp.port,
      });
      showFeedback("NTP saved");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const applyDst = async () => {
    if (!dst) return;
    setBusy("dst");
    setError(null);
    try {
      await trpcMutation("baichuan.setDst", { cameraId, ...dst });
      showFeedback("DST saved");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-[var(--color-foreground-muted)]">
        <Loader2 size={16} className="animate-spin mr-2" /> Loading time
        settings…
      </div>
    );
  }

  return (
    <div>
      {feedback && (
        <div className="mb-3 rounded-md bg-emerald-900/40 border border-emerald-700/60 px-3 py-2 text-[12px] text-emerald-200">
          {feedback}
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-md bg-red-900/40 border border-red-700/60 px-3 py-2 text-[12px] text-red-200">
          {error}
        </div>
      )}

      {/* ─────────── Timezone ─────────── */}
      {sys && (
        <Section
          title="Timezone"
          description={`Current camera clock: ${sys.year}-${String(sys.month).padStart(2, "0")}-${String(sys.day).padStart(2, "0")} ${String(sys.hour).padStart(2, "0")}:${String(sys.minute).padStart(2, "0")}:${String(sys.second).padStart(2, "0")} (camera-side, DST=${sys.isDst ? "on" : "off"}, ${formatTimezone(sys.timeZone)})`}
        >
          <FieldGrid>
            <Field
              label="Timezone"
              hint="POSIX convention: UTC+1 → -3600 (negative offset)."
            >
              <Select
                value={sys.timeZone}
                options={TIME_ZONE_PRESETS.map((p) => ({
                  value: p.seconds,
                  label: p.label,
                }))}
                onChange={(v) => setSys({ ...sys, timeZone: v as number })}
              />
            </Field>
          </FieldGrid>
          <div className="mt-2 flex gap-2 justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => sysSnapshot && setSys(sysSnapshot)}
              disabled={busy !== null}
            >
              Revert
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                void applySystemGeneral({ timeZone: sys.timeZone }, "timezone")
              }
              disabled={busy !== null}
              className="gap-1"
            >
              {busy === "timezone" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Save size={12} />
              )}
              Save
            </Button>
          </div>
        </Section>
      )}

      {/* ─────────── Manual clock ─────────── */}
      {sys && (
        <Section
          title="Manual clock"
          description="Force a specific date/time on the camera. NTP should be disabled first, otherwise the next sync overwrites this. Sends year + month + day + hour + minute + second together."
        >
          <ManualTimeForm
            current={sys}
            busy={busy === "manualTime"}
            onApply={(mt) =>
              void applySystemGeneral({ manualTime: mt }, "manualTime")
            }
          />
        </Section>
      )}

      {/* ─────────── NTP ─────────── */}
      {ntp && (
        <Section
          title="NTP synchronisation"
          description="When enabled the camera periodically resyncs its clock from this server."
        >
          <FieldGrid>
            <Field label="Enable">
              <Toggle
                value={ntp.enable === 1}
                onChange={(v) => setNtp({ ...ntp, enable: v ? 1 : 0 })}
              />
            </Field>
            <Field label="Server" hint="Hostname or IP">
              <TextInput
                value={ntp.server}
                onChange={(v) => setNtp({ ...ntp, server: v })}
              />
            </Field>
            <Field label="Port">
              <NumberInput
                value={ntp.port}
                min={1}
                max={65535}
                onChange={(v) => setNtp({ ...ntp, port: v })}
              />
            </Field>
            <Field
              label="Sync interval (minutes)"
              hint="Default 1440 = once per day"
            >
              <NumberInput
                value={ntp.synchronizeInterval}
                min={1}
                max={43200}
                onChange={(v) => setNtp({ ...ntp, synchronizeInterval: v })}
              />
            </Field>
          </FieldGrid>
          <div className="mt-2 flex gap-2 justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => ntpSnapshot && setNtp(ntpSnapshot)}
              disabled={busy !== null}
            >
              Revert
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={applyNtp}
              disabled={busy !== null}
              className="gap-1"
            >
              {busy === "ntp" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Save size={12} />
              )}
              Save
            </Button>
          </div>
        </Section>
      )}

      {/* ─────────── DST ─────────── */}
      {dst && (
        <Section
          title="Daylight Saving Time"
          description="The Reolink Client wires DST changes to the timezone selector, but you can also edit the window directly here."
        >
          <FieldGrid>
            <Field label="Enable DST">
              <Toggle
                value={dst.enable === 1}
                onChange={(v) => setDst({ ...dst, enable: v ? 1 : 0 })}
              />
            </Field>
            <Field label="Offset (hours)" hint="Usually 1">
              <NumberInput
                value={dst.offset}
                min={0}
                max={2}
                onChange={(v) => setDst({ ...dst, offset: v })}
              />
            </Field>
          </FieldGrid>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <DstTransitionEditor
              label="Start"
              month={dst.startMonth}
              weekIndex={dst.startWeekIndex}
              weekday={dst.startWeekday}
              hour={dst.startHour}
              minute={dst.startMinute}
              second={dst.startSecond}
              onChange={(p) =>
                setDst({
                  ...dst,
                  startMonth: p.month,
                  startWeekIndex: p.weekIndex,
                  startWeekday: p.weekday,
                  startHour: p.hour,
                  startMinute: p.minute,
                  startSecond: p.second,
                })
              }
            />
            <DstTransitionEditor
              label="End"
              month={dst.endMonth}
              weekIndex={dst.endWeekIndex}
              weekday={dst.endWeekday}
              hour={dst.endHour}
              minute={dst.endMinute}
              second={dst.endSecond}
              onChange={(p) =>
                setDst({
                  ...dst,
                  endMonth: p.month,
                  endWeekIndex: p.weekIndex,
                  endWeekday: p.weekday,
                  endHour: p.hour,
                  endMinute: p.minute,
                  endSecond: p.second,
                })
              }
            />
          </div>
          <div className="mt-3 flex gap-2 justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => dstSnapshot && setDst(dstSnapshot)}
              disabled={busy !== null}
            >
              Revert
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={applyDst}
              disabled={busy !== null}
              className="gap-1"
            >
              {busy === "dst" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Save size={12} />
              )}
              Save
            </Button>
          </div>
        </Section>
      )}

      <div className="flex justify-end mt-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void refresh()}
          disabled={busy !== null}
          className="gap-1"
        >
          <RefreshCw size={12} /> Refresh all
        </Button>
      </div>
    </div>
  );
}

// ─────────── Subcomponents ───────────

interface ManualTimeFormProps {
  current: SystemGeneral;
  busy: boolean;
  onApply: (mt: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  }) => void;
}

function ManualTimeForm({ current, busy, onApply }: ManualTimeFormProps) {
  const [mt, setMt] = useState({
    year: current.year,
    month: current.month,
    day: current.day,
    hour: current.hour,
    minute: current.minute,
    second: current.second,
  });

  const setNow = () => {
    const now = new Date();
    setMt({
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
      second: now.getSeconds(),
    });
  };

  return (
    <>
      <FieldGrid>
        <Field label="Year">
          <NumberInput
            value={mt.year}
            min={1970}
            max={2100}
            onChange={(v) => setMt({ ...mt, year: v })}
          />
        </Field>
        <Field label="Month">
          <NumberInput
            value={mt.month}
            min={1}
            max={12}
            onChange={(v) => setMt({ ...mt, month: v })}
          />
        </Field>
        <Field label="Day">
          <NumberInput
            value={mt.day}
            min={1}
            max={31}
            onChange={(v) => setMt({ ...mt, day: v })}
          />
        </Field>
        <Field label="Hour">
          <NumberInput
            value={mt.hour}
            min={0}
            max={23}
            onChange={(v) => setMt({ ...mt, hour: v })}
          />
        </Field>
        <Field label="Minute">
          <NumberInput
            value={mt.minute}
            min={0}
            max={59}
            onChange={(v) => setMt({ ...mt, minute: v })}
          />
        </Field>
        <Field label="Second">
          <NumberInput
            value={mt.second}
            min={0}
            max={59}
            onChange={(v) => setMt({ ...mt, second: v })}
          />
        </Field>
      </FieldGrid>
      <div className="mt-2 flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={setNow} disabled={busy}>
          Use my clock
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => onApply(mt)}
          disabled={busy}
          className="gap-1"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Set manual time
        </Button>
      </div>
    </>
  );
}

interface DstTransitionEditorProps {
  label: string;
  month: number;
  weekIndex: number;
  weekday: DstConfig["startWeekday"];
  hour: number;
  minute: number;
  second: number;
  onChange: (next: {
    month: number;
    weekIndex: number;
    weekday: DstConfig["startWeekday"];
    hour: number;
    minute: number;
    second: number;
  }) => void;
}

function DstTransitionEditor({
  label,
  month,
  weekIndex,
  weekday,
  hour,
  minute,
  second,
  onChange,
}: DstTransitionEditorProps) {
  return (
    <div className="rounded border border-[var(--color-border)] p-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider mb-2">
        {label}
      </h4>
      <FieldGrid>
        <Field label="Month">
          <NumberInput
            value={month}
            min={1}
            max={12}
            onChange={(v) =>
              onChange({ month: v, weekIndex, weekday, hour, minute, second })
            }
          />
        </Field>
        <Field label="Week (1-5, 5=last)">
          <NumberInput
            value={weekIndex}
            min={1}
            max={5}
            onChange={(v) =>
              onChange({ month, weekIndex: v, weekday, hour, minute, second })
            }
          />
        </Field>
        <Field label="Weekday">
          <Select
            value={weekday}
            options={[
              { value: "Sunday" as const, label: "Sunday" },
              { value: "Monday" as const, label: "Monday" },
              { value: "Tuesday" as const, label: "Tuesday" },
              { value: "Wednesday" as const, label: "Wednesday" },
              { value: "Thursday" as const, label: "Thursday" },
              { value: "Friday" as const, label: "Friday" },
              { value: "Saturday" as const, label: "Saturday" },
            ]}
            onChange={(v) =>
              onChange({ month, weekIndex, weekday: v, hour, minute, second })
            }
          />
        </Field>
        <Field label="Hour">
          <NumberInput
            value={hour}
            min={0}
            max={23}
            onChange={(v) =>
              onChange({ month, weekIndex, weekday, hour: v, minute, second })
            }
          />
        </Field>
        <Field label="Minute">
          <NumberInput
            value={minute}
            min={0}
            max={59}
            onChange={(v) =>
              onChange({ month, weekIndex, weekday, hour, minute: v, second })
            }
          />
        </Field>
        <Field label="Second">
          <NumberInput
            value={second}
            min={0}
            max={59}
            onChange={(v) =>
              onChange({ month, weekIndex, weekday, hour, minute, second: v })
            }
          />
        </Field>
      </FieldGrid>
    </div>
  );
}
