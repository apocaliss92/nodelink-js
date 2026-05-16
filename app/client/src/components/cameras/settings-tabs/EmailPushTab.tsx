import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Mail, Copy, RefreshCw, Play, Send, Save } from "lucide-react";
import { Button } from "@camstack/ui-library";
import {
  Section,
  FieldGrid,
  Field,
  TextInput,
  Select,
  Toggle,
  RangeInput,
  type TabProps,
} from "./shared";
import { trpcQuery, trpcMutation } from "../../../api";

/**
 * Email Push tab.
 *
 * Workflow for battery cameras: the camera sends motion alerts via SMTP to
 * the manager's built-in mail server. Each camera gets a unique recipient
 * `cam-<id>@<domain>`. When mail arrives, we parse it, classify the trigger
 * (people / vehicle / motion) and emit a synthetic ReolinkSimpleEvent into
 * the events bus so MQTT / HA / Frigate downstream consumers receive motion
 * just like a native Baichuan push.
 *
 * This tab combines:
 * - the camera-side SMTP config (cmd_id 42/43, `Email` block)
 * - the camera-side schedule + triggers (cmd_id 216/217, `EmailTask`)
 * - the manager-side address assigned to this camera
 * - a one-click auto-configure that points the camera at the manager
 * - a live list of recent received events for this camera
 */

const ATTACHMENT_TYPES = [
  { value: "picture" as const, label: "Picture (snapshot JPEG)" },
  { value: "video" as const, label: "Video (short clip)" },
  { value: "none" as const, label: "None (text-only)" },
];

const KNOWN_TRIGGER_TYPES = ["MD", "people", "vehicle", "dog_cat", "face", "package"];

interface EmailConfig {
  smtpServer: string;
  userName: string;
  password: string;
  address1: string;
  address2: string;
  address3: string;
  smtpPort: number;
  sendNickname: string;
  attachment: 0 | 1;
  attachmentType: "picture" | "video" | "none";
  textType: "withText" | "noText";
  ssl: 0 | 1;
  interval: number;
}

interface EmailTaskScheduleItem {
  type: string;
  valueTable: string;
}

interface EmailTaskConfig {
  channelId: number;
  enable: 0 | 1;
  typeScheduleList: EmailTaskScheduleItem[];
}

interface EmailPushStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  bindHost: string;
  domain: string;
  requireAuth: boolean;
  tls: boolean;
  messagesAccepted: number;
  messagesRejected: number;
  startedAtMs: number | undefined;
  lastErrorMessage: string | undefined;
}

interface CameraAddress {
  cameraId: string;
  cameraName: string;
  address: string;
}

interface RecentEvent {
  cameraId: string;
  recipient: string;
  inferredType: string;
  receivedAtMs: number;
  subject: string;
  from: string;
  snapshotPath: string | undefined;
  snapshotBase64: string | undefined;
  bodyExcerpt: string;
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function EmailPushTab({ cameraId, channel }: TabProps) {
  const [status, setStatus] = useState<EmailPushStatus | null>(null);
  const [address, setAddress] = useState<CameraAddress | null>(null);
  const [emailCfg, setEmailCfg] = useState<EmailConfig | null>(null);
  const [emailTask, setEmailTask] = useState<EmailTaskConfig | null>(null);
  const [recent, setRecent] = useState<RecentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    | null
    | "autoConfigure"
    | "saveEmail"
    | "testEmail"
    | "verifyDelivery"
    | "toggleTask"
    | "schedule"
    | "refresh"
    | "injectTest"
  >(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, addr, cfg, task, events] = await Promise.all([
        trpcQuery<EmailPushStatus>("emailPush.status"),
        trpcQuery<CameraAddress>("emailPush.getCameraAddress", { cameraId }),
        trpcQuery<EmailConfig>("baichuan.getEmail", { cameraId }),
        trpcQuery<EmailTaskConfig>("baichuan.getEmailTask", {
          cameraId,
          channel,
        }),
        trpcQuery<RecentEvent[]>("emailPush.recentEvents", {
          cameraId,
          limit: 10,
          includeSnapshot: true,
        }),
      ]);
      setStatus(s);
      setAddress(addr);
      setEmailCfg(cfg);
      setEmailTask(task);
      setRecent(events);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cameraId, channel]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const showFeedback = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 4000);
  };

  const copyAddress = () => {
    if (!address) return;
    navigator.clipboard.writeText(address.address).catch(() => {});
    showFeedback("Address copied to clipboard");
  };

  const autoConfigure = async () => {
    if (!address || !status) return;
    setBusy("autoConfigure");
    setError(null);
    try {
      // Resolve the manager's LAN address server-side — `window.location.hostname`
      // would set the camera to `localhost`, which the camera can't reach.
      const hostInfo = await trpcQuery<{
        recommended: string | null;
        candidates: Array<{ iface: string; address: string }>;
      }>("emailPush.getRecommendedHost");
      const managerHost = hostInfo.recommended ?? window.location.hostname;
      const result = await trpcMutation<{
        setEmail: { applied: true };
        setEmailTask: { applied: true; touchedTypes: string[] };
        testEmail?: { success: boolean };
      }>("baichuan.setupEmailPushToManager", {
        cameraId,
        channel,
        managerHost,
        managerPort: status.port,
        recipientLocalPart: address.address.split("@")[0],
        domain: status.domain,
        attachmentType: "picture",
        sendNickname: address.cameraName,
        runTest: false,
        triggerTypes: ["MD", "people", "vehicle"],
      });
      showFeedback(
        `Auto-configured (host=${managerHost}). Triggers: ${result.setEmailTask.touchedTypes.join(", ") || "(none)"}.`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const saveEmailPatch = async (patch: Partial<EmailConfig>) => {
    setBusy("saveEmail");
    setError(null);
    try {
      await trpcMutation("baichuan.setEmail", { cameraId, ...patch });
      showFeedback("Email config saved on camera");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const sendTestEmail = async () => {
    setBusy("testEmail");
    setError(null);
    try {
      // ⚠ Camera response is unreliable: several Reolink firmwares (e.g. E1
      // Outdoor PoE v3.1.0.5223) reply 200 to cmd_id=141 *without* actually
      // performing the SMTP send — they only acknowledge the SET. We pass a
      // generous timeout so we don't bail early on cameras that DO test.
      const r = await trpcMutation<{ success: boolean }>(
        "baichuan.testEmail",
        { cameraId, timeoutMs: 90_000 },
      );
      showFeedback(
        r.success
          ? "Camera replied OK (warning: some firmwares lie — use \"Verify delivery\" for a true end-to-end check)"
          : "Camera reports test failed (response 482 — check credentials / server reachable)",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const verifyDelivery = async () => {
    setBusy("verifyDelivery");
    setError(null);
    const sinceMs = Date.now();
    try {
      // Fire test send (camera-side) and then wait for the manager to see
      // a fresh email-push event. This bypasses firmware bugs where
      // cmd_id=141 returns success without actually sending.
      await trpcMutation("baichuan.testEmail", {
        cameraId,
        timeoutMs: 90_000,
      }).catch(() => {
        /* Some firmwares 482 — keep going, mail may still arrive. */
      });
      const result = await trpcMutation<
        | { delivered: true; event: { inferredType: string; subject: string } }
        | { delivered: false }
      >("emailPush.verifyDelivery", {
        cameraId,
        timeoutMs: 60_000,
        sinceMs,
      });
      if (result.delivered) {
        showFeedback(
          `Delivery confirmed — manager received \"${result.event.subject || result.event.inferredType}\"`,
        );
        await refresh();
      } else {
        setError(
          "No email reached the manager within 60s. Probable causes: VLAN/firewall blocks 192.168.50.x → manager:2525, camera firmware bug, or SMTP plain rejected. Check Settings → Email Push status counters.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const applySchedulePreset = async (
    preset: "always" | "never" | "weekdays8to18" | "nights",
  ) => {
    if (!emailTask) return;
    setBusy("schedule");
    setError(null);
    try {
      const types = emailTask.typeScheduleList
        .filter((t) => KNOWN_TRIGGER_TYPES.includes(t.type))
        .map((t) => t.type);
      const schedule =
        preset === "always"
          ? { kind: "always" as const }
          : preset === "never"
            ? { kind: "never" as const }
            : preset === "weekdays8to18"
              ? {
                  kind: "windows" as const,
                  windows: [
                    {
                      days: [1, 2, 3, 4, 5],
                      startHour: 8,
                      endHour: 18,
                    },
                  ],
                }
              : {
                  // "nights" — 20:00 → 06:00 (split into two windows because
                  // the day boundary is exclusive)
                  kind: "windows" as const,
                  windows: [
                    {
                      days: [0, 1, 2, 3, 4, 5, 6],
                      startHour: 20,
                      endHour: 24,
                    },
                    {
                      days: [0, 1, 2, 3, 4, 5, 6],
                      startHour: 0,
                      endHour: 6,
                    },
                  ],
                };
      const r = await trpcMutation<{ touchedTypes: string[] }>(
        "baichuan.patchEmailSchedule",
        {
          cameraId,
          channel,
          types,
          schedule,
        },
      );
      showFeedback(
        `Schedule applied to: ${r.touchedTypes.join(", ") || "(none)"}`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleTask = async (nextEnable: 0 | 1) => {
    if (!emailTask) return;
    setBusy("toggleTask");
    setError(null);
    try {
      await trpcMutation("baichuan.setEmailTask", {
        cameraId,
        channel,
        enable: nextEnable,
        typeScheduleList: emailTask.typeScheduleList,
      });
      showFeedback(`Email task ${nextEnable ? "enabled" : "disabled"}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const injectTest = async () => {
    setBusy("injectTest");
    setError(null);
    try {
      await trpcMutation("emailPush.injectTestEvent", {
        cameraId,
        inferredType: "people",
        subject: "Manager UI synthetic event",
      });
      showFeedback("Synthetic event injected into the event bus");
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
        <Loader2 size={16} className="animate-spin mr-2" /> Loading email-push config…
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

      <Section
        title="Manager SMTP server"
        description="The built-in SMTP intake. Configure cameras to send motion mails to it; the manager parses them and emits motion events."
      >
        {!status?.enabled ? (
          <p className="text-[12px] text-amber-300">
            Email Push is <strong>disabled</strong> in global settings. Open
            the Settings page to turn it on.
          </p>
        ) : (
          <FieldGrid>
            <Field label="Status">
              <span
                className={
                  status.running
                    ? "text-emerald-300 text-[12px] font-medium"
                    : "text-red-300 text-[12px] font-medium"
                }
              >
                {status.running ? "Running" : "Stopped"}
              </span>
            </Field>
            <Field label="Listening on">
              <span className="text-[12px] font-mono">
                {status.bindHost}:{status.port}
              </span>
            </Field>
            <Field label="Domain">
              <span className="text-[12px] font-mono">{status.domain}</span>
            </Field>
            <Field label="Auth / TLS">
              <span className="text-[12px]">
                {status.requireAuth ? "AUTH required" : "Anonymous"} ·{" "}
                {status.tls ? "TLS on" : "Plain"}
              </span>
            </Field>
            <Field label="Accepted">
              <span className="text-[12px] tabular-nums">
                {status.messagesAccepted}
              </span>
            </Field>
            <Field label="Rejected">
              <span className="text-[12px] tabular-nums">
                {status.messagesRejected}
              </span>
            </Field>
          </FieldGrid>
        )}
      </Section>

      {address && (
        <Section
          title="Camera recipient"
          description="The unique mailbox assigned to this camera. Set it as sender AND recipient on the camera's SMTP config."
        >
          <div className="flex items-center gap-2">
            <code className="flex-1 px-2 py-1 rounded bg-[var(--color-surface-elevated)] text-[12px] font-mono">
              {address.address}
            </code>
            <Button
              variant="ghost"
              size="sm"
              onClick={copyAddress}
              className="gap-1"
            >
              <Copy size={12} /> Copy
            </Button>
          </div>
        </Section>
      )}

      <Section
        title="Auto-configure on camera"
        description="Push SMTP server + 24/7 schedule for motion/people/vehicle in a single call. Re-runs are safe (idempotent)."
      >
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={autoConfigure}
            disabled={busy !== null || !status?.running}
            className="gap-1"
          >
            {busy === "autoConfigure" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Play size={12} />
            )}
            Auto-configure
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
            disabled={busy !== null}
            className="gap-1"
          >
            <RefreshCw size={12} /> Refresh
          </Button>
          {!status?.running && (
            <span className="text-[11px] text-amber-300">
              Enable the SMTP server first.
            </span>
          )}
        </div>
      </Section>

      {emailCfg && (
        <Section
          title="Camera SMTP config (cmd_id 42/43)"
          description="What the camera currently uses to send motion alerts. Edit and save; the camera persists the new values."
        >
          <FieldGrid>
            <Field label="SMTP server">
              <TextInput
                value={emailCfg.smtpServer}
                onChange={(v) => setEmailCfg({ ...emailCfg, smtpServer: v })}
              />
            </Field>
            <Field label="SMTP port">
              <input
                type="number"
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-2 py-1 text-[12px]"
                value={emailCfg.smtpPort}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setEmailCfg({ ...emailCfg, smtpPort: n });
                }}
              />
            </Field>
            <Field label="Username (sender)">
              <TextInput
                value={emailCfg.userName}
                onChange={(v) => setEmailCfg({ ...emailCfg, userName: v })}
              />
            </Field>
            <Field label="Password">
              <TextInput
                value={emailCfg.password}
                onChange={(v) => setEmailCfg({ ...emailCfg, password: v })}
              />
            </Field>
            <Field label="Recipient 1">
              <TextInput
                value={emailCfg.address1}
                onChange={(v) => setEmailCfg({ ...emailCfg, address1: v })}
              />
            </Field>
            <Field label="Sender nickname">
              <TextInput
                value={emailCfg.sendNickname}
                onChange={(v) => setEmailCfg({ ...emailCfg, sendNickname: v })}
              />
            </Field>
            <Field label="Attachment">
              <Toggle
                value={emailCfg.attachment === 1}
                onChange={(v) =>
                  setEmailCfg({ ...emailCfg, attachment: v ? 1 : 0 })
                }
              />
            </Field>
            <Field label="Attachment type">
              <Select
                value={emailCfg.attachmentType}
                options={ATTACHMENT_TYPES}
                onChange={(v) =>
                  setEmailCfg({
                    ...emailCfg,
                    attachmentType: v,
                  })
                }
              />
            </Field>
            <Field label="SSL/TLS">
              <Toggle
                value={emailCfg.ssl === 1}
                onChange={(v) => setEmailCfg({ ...emailCfg, ssl: v ? 1 : 0 })}
              />
            </Field>
            <Field label="Interval (seconds)" hint="Ignored on battery cameras.">
              <RangeInput
                value={emailCfg.interval}
                min={0}
                max={3600}
                step={5}
                onChange={(v) => setEmailCfg({ ...emailCfg, interval: v })}
              />
            </Field>
          </FieldGrid>

          <div className="mt-3 flex gap-2 justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={sendTestEmail}
              disabled={busy !== null}
              className="gap-1"
            >
              {busy === "testEmail" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Send size={12} />
              )}
              Send test email
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={verifyDelivery}
              disabled={busy !== null}
              className="gap-1"
            >
              {busy === "verifyDelivery" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Send size={12} />
              )}
              Verify delivery
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void saveEmailPatch(emailCfg)}
              disabled={busy !== null}
            >
              {busy === "saveEmail" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : null}
              Save
            </Button>
          </div>
        </Section>
      )}

      {emailTask && (
        <Section
          title="Quick schedule presets"
          description="Apply a schedule template to every known AI trigger type (motion, people, vehicle, …). Other slots are left untouched."
        >
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void applySchedulePreset("always")}
              disabled={busy !== null}
            >
              24/7 always
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void applySchedulePreset("weekdays8to18")}
              disabled={busy !== null}
            >
              Weekdays 8–18
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void applySchedulePreset("nights")}
              disabled={busy !== null}
            >
              Nights 20–06
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void applySchedulePreset("never")}
              disabled={busy !== null}
            >
              Never
            </Button>
            {busy === "schedule" && (
              <Loader2 size={12} className="animate-spin text-emerald-300 self-center" />
            )}
          </div>
        </Section>
      )}

      {emailTask && (
        <Section
          title="Schedule editor (cmd_id 216/217)"
          description="Edit the 7×24 schedule for a specific AI trigger type. Click cells to toggle, drag to paint. Save writes the entire EmailTask list back to the camera — slots for other types are kept untouched."
        >
          <div className="flex items-center gap-3 mb-3">
            <Toggle
              value={emailTask.enable === 1}
              onChange={(v) => void toggleTask(v ? 1 : 0)}
              label={emailTask.enable === 1 ? "Task enabled" : "Task disabled"}
            />
            {busy === "toggleTask" && (
              <Loader2 size={12} className="animate-spin text-emerald-300" />
            )}
          </div>
          <ScheduleGridEditor
            task={emailTask}
            cameraId={cameraId}
            channel={channel}
            onSaved={() => void refresh()}
            disabled={busy !== null}
          />
        </Section>
      )}

      <Section
        title="Recent received events"
        description="In-memory ring of the most recent emails this camera delivered to the manager. Cleared on restart."
      >
        <div className="flex items-center gap-2 mb-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={injectTest}
            disabled={busy !== null}
            className="gap-1"
          >
            {busy === "injectTest" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Mail size={12} />
            )}
            Inject synthetic event
          </Button>
        </div>
        {recent.length === 0 ? (
          <p className="text-[12px] text-[var(--color-foreground-muted)]">
            No events received yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {recent.map((ev, idx) => (
              <li
                key={`${ev.receivedAtMs}-${idx}`}
                className="flex gap-3 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
              >
                {ev.snapshotBase64 ? (
                  <img
                    src={`data:image/jpeg;base64,${ev.snapshotBase64}`}
                    alt="snapshot"
                    className="w-24 h-16 object-cover rounded"
                  />
                ) : (
                  <div className="w-24 h-16 rounded bg-[var(--color-surface-elevated)] flex items-center justify-center text-[10px] text-[var(--color-foreground-subtle)]">
                    no image
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium">
                    {ev.inferredType} ·{" "}
                    <span className="text-[var(--color-foreground-muted)] font-normal">
                      {formatTimestamp(ev.receivedAtMs)}
                    </span>
                  </div>
                  <div className="text-[11px] text-[var(--color-foreground-muted)] truncate">
                    {ev.subject || "(no subject)"}
                  </div>
                  <div className="text-[10px] text-[var(--color-foreground-subtle)] truncate">
                    from {ev.from || "?"} · to {ev.recipient}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ─────────── Schedule grid editor ───────────

interface ScheduleGridEditorProps {
  task: EmailTaskConfig;
  cameraId: string;
  channel: number;
  disabled: boolean;
  onSaved: () => void;
}

const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => h);
// JavaScript Date.getDay() convention: 0 = Sunday → 6 = Saturday.
// The Baichuan valueTable uses the same indexing (confirmed via pcap).
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Visual 7×24 grid editor for a single trigger's `valueTable`. Click-and-drag
 * paints with the value chosen on the first cell of the drag (toggle-paint).
 *
 * The editor edits a LOCAL draft so the user can mess around without firing
 * an API call on every click. The Save button persists the entire EmailTask
 * back (we always write the full list — Reolink drops slots omitted from a SET).
 */
function ScheduleGridEditor({
  task,
  cameraId,
  channel,
  disabled,
  onSaved,
}: ScheduleGridEditorProps) {
  // Available types come from the camera's current EmailTask. We add the
  // KNOWN_TRIGGER_TYPES as fallbacks for cameras that haven't enabled them yet.
  const availableTypes = useMemo(() => {
    const set = new Set<string>(task.typeScheduleList.map((i) => i.type));
    for (const t of KNOWN_TRIGGER_TYPES) set.add(t);
    return Array.from(set).filter((t) => t !== "none");
  }, [task]);

  const [selectedType, setSelectedType] = useState<string>(
    () =>
      task.typeScheduleList.find((i) =>
        KNOWN_TRIGGER_TYPES.includes(i.type),
      )?.type ??
      availableTypes[0] ??
      "MD",
  );

  // Load the valueTable for the currently selected type (or fresh zeros if
  // the camera doesn't have a slot for it yet).
  const loadValueTable = useCallback(
    (type: string): boolean[] => {
      const slot = task.typeScheduleList.find((i) => i.type === type);
      const raw = slot?.valueTable ?? "0".repeat(168);
      const padded = raw.padEnd(168, "0").slice(0, 168);
      return Array.from(padded).map((ch) => ch === "1");
    },
    [task],
  );

  const [draft, setDraft] = useState<boolean[]>(() =>
    loadValueTable(selectedType),
  );
  const [paintMode, setPaintMode] = useState<"on" | "off" | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whenever the user picks a different trigger type, reload the draft.
  useEffect(() => {
    setDraft(loadValueTable(selectedType));
  }, [selectedType, loadValueTable]);

  // Reload draft when the task changes upstream (e.g. after a Save).
  useEffect(() => {
    setDraft(loadValueTable(selectedType));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  const cellAt = (day: number, hour: number): number => day * 24 + hour;

  const toggleCell = (day: number, hour: number, forceValue?: boolean) => {
    setDraft((prev) => {
      const next = [...prev];
      const idx = cellAt(day, hour);
      next[idx] = forceValue !== undefined ? forceValue : !next[idx];
      return next;
    });
  };

  const beginPaint = (day: number, hour: number) => {
    if (disabled || saving) return;
    const current = draft[cellAt(day, hour)] ?? false;
    const mode = current ? "off" : "on";
    setPaintMode(mode);
    toggleCell(day, hour, mode === "on");
  };

  const continuePaint = (day: number, hour: number) => {
    if (paintMode === null) return;
    toggleCell(day, hour, paintMode === "on");
  };

  const endPaint = () => setPaintMode(null);

  // Stop painting if the user releases the mouse outside the grid.
  useEffect(() => {
    const handler = () => setPaintMode(null);
    window.addEventListener("mouseup", handler);
    return () => window.removeEventListener("mouseup", handler);
  }, []);

  // Bulk operations on the local draft.
  const fillAll = (value: boolean) => setDraft(new Array(168).fill(value));
  const invertAll = () => setDraft((prev) => prev.map((b) => !b));
  const fillRow = (day: number, value: boolean) => {
    setDraft((prev) => {
      const next = [...prev];
      for (let h = 0; h < 24; h++) next[cellAt(day, h)] = value;
      return next;
    });
  };
  const fillCol = (hour: number, value: boolean) => {
    setDraft((prev) => {
      const next = [...prev];
      for (let d = 0; d < 7; d++) next[cellAt(d, hour)] = value;
      return next;
    });
  };
  const resetFromCamera = () => setDraft(loadValueTable(selectedType));

  const activeCount = draft.filter(Boolean).length;
  const dirty = draft.join("") !== loadValueTable(selectedType).join("");

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Build the full list: keep every existing slot, but replace the
      // currently-edited type's valueTable. Add a slot if the type wasn't
      // present yet.
      const valueTable = draft.map((b) => (b ? "1" : "0")).join("");
      const existingIdx = task.typeScheduleList.findIndex(
        (i) => i.type === selectedType,
      );
      const newList =
        existingIdx >= 0
          ? task.typeScheduleList.map((item, idx) =>
              idx === existingIdx ? { ...item, valueTable } : item,
            )
          : [...task.typeScheduleList, { type: selectedType, valueTable }];

      await trpcMutation("baichuan.setEmailTask", {
        cameraId,
        channel,
        enable: task.enable,
        typeScheduleList: newList,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const cellBaseCls =
    "h-5 w-5 border border-[var(--color-border)] cursor-pointer transition-colors";
  const cellOnCls = "bg-emerald-500/70 hover:bg-emerald-400";
  const cellOffCls = "bg-[var(--color-surface-elevated)] hover:bg-[var(--color-surface-hover)]";

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md bg-red-900/40 border border-red-700/60 px-2 py-1 text-[11px] text-red-200">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
          Editing trigger
        </span>
        <select
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-2 py-1 text-[12px] font-mono"
          value={selectedType}
          onChange={(e) => setSelectedType(e.currentTarget.value)}
          disabled={disabled || saving}
        >
          {availableTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-[var(--color-foreground-muted)] tabular-nums">
          {activeCount} / 168 active hours
        </span>
      </div>

      <div
        className="inline-block select-none"
        onMouseLeave={endPaint}
      >
        <table className="border-collapse">
          <thead>
            <tr>
              <th />
              {HOUR_LABELS.map((h) => (
                <th
                  key={h}
                  className="text-[9px] text-[var(--color-foreground-subtle)] tabular-nums px-0 cursor-pointer hover:text-[var(--color-foreground)]"
                  title="Click: fill column ON · Shift+click: fill column OFF"
                  onClick={(e) =>
                    fillCol(h, !e.shiftKey)
                  }
                >
                  {h.toString().padStart(2, "0")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAY_LABELS.map((dayLabel, d) => (
              <tr key={d}>
                <td
                  className="text-[10px] text-[var(--color-foreground-subtle)] uppercase pr-2 cursor-pointer hover:text-[var(--color-foreground)]"
                  title="Click: fill row ON · Shift+click: fill row OFF"
                  onClick={(e) =>
                    fillRow(d, !e.shiftKey)
                  }
                >
                  {dayLabel}
                </td>
                {HOUR_LABELS.map((h) => {
                  const on = draft[cellAt(d, h)] ?? false;
                  return (
                    <td key={h} className="p-0">
                      <div
                        className={`${cellBaseCls} ${on ? cellOnCls : cellOffCls}`}
                        onMouseDown={() => beginPaint(d, h)}
                        onMouseEnter={() => continuePaint(d, h)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => fillAll(true)}
          disabled={disabled || saving}
        >
          All on
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => fillAll(false)}
          disabled={disabled || saving}
        >
          All off
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={invertAll}
          disabled={disabled || saving}
        >
          Invert
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={resetFromCamera}
          disabled={disabled || saving || !dirty}
        >
          Revert
        </Button>
        <span className="flex-1" />
        <Button
          variant="primary"
          size="sm"
          onClick={save}
          disabled={disabled || saving || !dirty}
          className="gap-1"
        >
          {saving ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Save size={12} />
          )}
          Save schedule
        </Button>
      </div>

      <p className="text-[10px] text-[var(--color-foreground-subtle)]">
        Tip: click an hour header to fill that column (Shift+click for off), or
        a day label to fill that row.
      </p>
    </div>
  );
}
