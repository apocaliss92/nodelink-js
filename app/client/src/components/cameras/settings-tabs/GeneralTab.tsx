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
 * General tab — settings that aren't tied to a specific feature: camera
 * name, display format, language, login lockout policy, scheduled reboot.
 *
 * The pure clock-related setters (timezone, NTP, DST, manual time) live in
 * the dedicated Time tab to keep both panes focused.
 */

const WEEKDAYS_SHORT = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

interface SystemGeneral {
  timeZone: number;
  osdFormat: "DMY" | "MDY" | "YMD";
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  timeFormat: 0 | 1;
  language: string;
  deviceName: string;
  loginLock: 0 | 1;
  lockTime: number;
  allowedTimes: number;
  isDst: 0 | 1;
}

interface AutoRebootConfig {
  enable: 0 | 1;
  weekDay:
    | "Sunday"
    | "Monday"
    | "Tuesday"
    | "Wednesday"
    | "Thursday"
    | "Friday"
    | "Saturday"
    | "everyday";
  hour: number;
  minute: number;
  second: number;
}

export function GeneralTab({ cameraId, channel: _channel }: TabProps) {
  void _channel; // SystemGeneral and AutoReboot are host-level on standalone cams.
  const [sys, setSys] = useState<SystemGeneral | null>(null);
  const [sysSnapshot, setSysSnapshot] = useState<SystemGeneral | null>(null);
  const [autoReboot, setAutoReboot] = useState<AutoRebootConfig | null>(null);
  const [autoRebootSnapshot, setAutoRebootSnapshot] =
    useState<AutoRebootConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    null | "deviceName" | "display" | "loginLock" | "autoReboot"
  >(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sg, ar] = await Promise.all([
        trpcQuery<SystemGeneral>("baichuan.getSystemGeneral", { cameraId }),
        trpcQuery<AutoRebootConfig>("baichuan.getAutoReboot", { cameraId }),
      ]);
      setSys(sg);
      setSysSnapshot(sg);
      setAutoReboot(ar);
      setAutoRebootSnapshot(ar);
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
    patch: Partial<SystemGeneral>,
    busyKey: "deviceName" | "display" | "loginLock",
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

  const applyAutoReboot = async () => {
    if (!autoReboot) return;
    setBusy("autoReboot");
    setError(null);
    try {
      await trpcMutation("baichuan.setAutoReboot", { cameraId, ...autoReboot });
      showFeedback("Auto-reboot saved");
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
        <Loader2 size={16} className="animate-spin mr-2" /> Loading general
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

      {/* ─────────── Camera name ─────────── */}
      {sys && (
        <Section
          title="Camera name"
          description="The friendly name shown in OSD and in the Reolink app. The setter uses the camera's dedicated `deviceNameOnly=1` shape."
        >
          <FieldGrid>
            <Field label="Device name">
              <TextInput
                value={sys.deviceName}
                onChange={(v) => setSys({ ...sys, deviceName: v })}
              />
            </Field>
          </FieldGrid>
          <div className="mt-2 flex gap-2 justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                sysSnapshot &&
                setSys({ ...sys, deviceName: sysSnapshot.deviceName })
              }
              disabled={
                busy !== null || sys.deviceName === sysSnapshot?.deviceName
              }
            >
              Revert
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                void applySystemGeneral(
                  { deviceName: sys.deviceName },
                  "deviceName",
                )
              }
              disabled={
                busy !== null || sys.deviceName === sysSnapshot?.deviceName
              }
              className="gap-1"
            >
              {busy === "deviceName" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Save size={12} />
              )}
              Save
            </Button>
          </div>
        </Section>
      )}

      {/* ─────────── Display & locale (OSD format + time format + language) ─────────── */}
      {sys && (
        <Section
          title="Display & locale"
          description="How the camera renders dates/times on the OSD and which UI language it speaks."
        >
          <FieldGrid>
            <Field label="OSD date format">
              <Select
                value={sys.osdFormat}
                options={[
                  { value: "DMY" as const, label: "DD-MM-YYYY (Europe)" },
                  { value: "MDY" as const, label: "MM-DD-YYYY (US)" },
                  { value: "YMD" as const, label: "YYYY-MM-DD (ISO)" },
                ]}
                onChange={(v) => setSys({ ...sys, osdFormat: v })}
              />
            </Field>
            <Field label="Time format">
              <Select
                value={sys.timeFormat}
                options={[
                  { value: 0 as const, label: "24-hour" },
                  { value: 1 as const, label: "12-hour" },
                ]}
                onChange={(v) => setSys({ ...sys, timeFormat: v as 0 | 1 })}
              />
            </Field>
            <Field label="Language">
              <TextInput
                value={sys.language}
                onChange={(v) => setSys({ ...sys, language: v })}
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
                void applySystemGeneral(
                  {
                    osdFormat: sys.osdFormat,
                    timeFormat: sys.timeFormat,
                    language: sys.language,
                  },
                  "display",
                )
              }
              disabled={busy !== null}
              className="gap-1"
            >
              {busy === "display" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Save size={12} />
              )}
              Save
            </Button>
          </div>
        </Section>
      )}

      {/* ─────────── Login policy ─────────── */}
      {sys && (
        <Section
          title="Login lockout"
          description="Failed-login protection. When enabled, after N failed attempts the camera locks logins for `lockTime` seconds."
        >
          <FieldGrid>
            <Field label="Enable">
              <Toggle
                value={sys.loginLock === 1}
                onChange={(v) =>
                  setSys({ ...sys, loginLock: v ? 1 : 0 })
                }
              />
            </Field>
            <Field
              label="Allowed failed attempts"
              hint="Login is locked once this many bad credentials have been tried."
            >
              <NumberInput
                value={sys.allowedTimes}
                min={1}
                max={100}
                onChange={(v) => setSys({ ...sys, allowedTimes: v })}
              />
            </Field>
            <Field
              label="Lock duration (seconds)"
              hint="How long the camera refuses logins after the lockout triggers."
            >
              <NumberInput
                value={sys.lockTime}
                min={1}
                max={86400}
                onChange={(v) => setSys({ ...sys, lockTime: v })}
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
                void applySystemGeneral(
                  {
                    loginLock: sys.loginLock,
                    lockTime: sys.lockTime,
                    allowedTimes: sys.allowedTimes,
                  },
                  "loginLock",
                )
              }
              disabled={busy !== null}
              className="gap-1"
            >
              {busy === "loginLock" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Save size={12} />
              )}
              Save
            </Button>
          </div>
        </Section>
      )}

      {/* ─────────── Auto-reboot ─────────── */}
      {autoReboot && (
        <Section
          title="Auto-reboot schedule"
          description="Cameras with long uptimes can develop slow memory leaks — schedule a weekly reboot to keep them healthy."
        >
          <FieldGrid>
            <Field label="Enable">
              <Toggle
                value={autoReboot.enable === 1}
                onChange={(v) =>
                  setAutoReboot({ ...autoReboot, enable: v ? 1 : 0 })
                }
              />
            </Field>
            <Field label="Day">
              <Select
                value={autoReboot.weekDay}
                options={[
                  { value: "everyday" as const, label: "Every day" },
                  ...WEEKDAYS_SHORT.map((d, i) => ({
                    value: [
                      "Sunday",
                      "Monday",
                      "Tuesday",
                      "Wednesday",
                      "Thursday",
                      "Friday",
                      "Saturday",
                    ][i] as AutoRebootConfig["weekDay"],
                    label: d,
                  })),
                ]}
                onChange={(v) =>
                  setAutoReboot({
                    ...autoReboot,
                    weekDay: v as AutoRebootConfig["weekDay"],
                  })
                }
              />
            </Field>
            <Field label="Hour">
              <NumberInput
                value={autoReboot.hour}
                min={0}
                max={23}
                onChange={(v) =>
                  setAutoReboot({ ...autoReboot, hour: v })
                }
              />
            </Field>
            <Field label="Minute">
              <NumberInput
                value={autoReboot.minute}
                min={0}
                max={59}
                onChange={(v) =>
                  setAutoReboot({ ...autoReboot, minute: v })
                }
              />
            </Field>
          </FieldGrid>
          <div className="mt-2 flex gap-2 justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                autoRebootSnapshot && setAutoReboot(autoRebootSnapshot)
              }
              disabled={busy !== null}
            >
              Revert
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={applyAutoReboot}
              disabled={busy !== null}
              className="gap-1"
            >
              {busy === "autoReboot" ? (
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
