import { useCallback, useEffect, useState } from "react";
import { Loader2, Save, RefreshCw, Power, PowerOff } from "lucide-react";
import { Button, Input, Switch } from "@camstack/ui-library";
import { trpcMutation, trpcQuery } from "../api";

/**
 * Settings → Email Push pane.
 *
 * Manages the manager-side SMTP intake server: bind host, port, optional
 * AUTH, optional STARTTLS, retention, and runtime status. All knobs map
 * 1:1 to the `emailPush.*` keys in settings.json — saving via
 * `emailPush.updateSettings` automatically restarts the running server.
 */

interface EmailPushSettings {
  enabled: boolean;
  port: number;
  bindHost: string;
  domain: string;
  requireAuth: boolean;
  authUsername: string;
  authPasswordConfigured: boolean;
  tls: boolean;
  maxMessageBytes: number;
  motionResetMs: number;
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

interface RecentEmailEvent {
  cameraId: string;
  recipient: string;
  inferredType: string;
  receivedAtMs: number;
  subject: string;
  from: string;
  bodyExcerpt: string;
}

interface Form {
  enabled: boolean;
  port: number;
  bindHost: string;
  domain: string;
  requireAuth: boolean;
  authUsername: string;
  authPassword: string;
  tls: boolean;
  maxMessageBytes: number;
  motionResetMs: number;
}

function settingsToForm(s: EmailPushSettings): Form {
  return {
    enabled: s.enabled,
    port: s.port,
    bindHost: s.bindHost,
    domain: s.domain,
    requireAuth: s.requireAuth,
    authUsername: s.authUsername,
    // Password is intentionally blank — only sent on save when the user types
    // a new one. The `authPasswordConfigured` flag from the server tells us
    // whether a password is currently stored.
    authPassword: "",
    tls: s.tls,
    maxMessageBytes: s.maxMessageBytes,
    motionResetMs: s.motionResetMs,
  };
}

export function EmailPushSettingsSection() {
  const [settings, setSettings] = useState<EmailPushSettings | null>(null);
  const [status, setStatus] = useState<EmailPushStatus | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [recent, setRecent] = useState<RecentEmailEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, st, ev] = await Promise.all([
        trpcQuery<EmailPushSettings>("emailPush.getSettings"),
        trpcQuery<EmailPushStatus>("emailPush.status"),
        trpcQuery<RecentEmailEvent[]>("emailPush.recentEvents", { limit: 300 }),
      ]);
      setSettings(s);
      setStatus(st);
      setForm(settingsToForm(s));
      setRecent(ev);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll the recent-events ring while the panel is visible so a new email
  // arriving from a camera shows up without the user having to click
  // refresh. 5s is generous — these are diagnostic logs, not live frames.
  useEffect(() => {
    const interval = setInterval(() => {
      trpcQuery<RecentEmailEvent[]>("emailPush.recentEvents", { limit: 300 })
        .then(setRecent)
        .catch(() => {
          /* transient — keep the previous list */
        });
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const showFeedback = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 3500);
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {
        enabled: form.enabled,
        port: form.port,
        bindHost: form.bindHost,
        domain: form.domain,
        requireAuth: form.requireAuth,
        authUsername: form.authUsername,
        tls: form.tls,
        maxMessageBytes: form.maxMessageBytes,
        motionResetMs: form.motionResetMs,
      };
      // Only send the password when the user actually typed one — empty
      // string would wipe an existing password, which is rarely the intent.
      if (form.authPassword) {
        patch.authPassword = form.authPassword;
      }
      await trpcMutation("emailPush.updateSettings", patch);
      showFeedback("Settings saved. Server restarted if it was running.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const action = async (kind: "start" | "stop" | "restart") => {
    setSaving(true);
    setError(null);
    try {
      await trpcMutation(`emailPush.${kind}`);
      showFeedback(`Server ${kind}ed`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading || !form) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-[var(--color-foreground-muted)]">
        <Loader2 size={14} className="animate-spin" /> Loading email-push
        settings…
      </div>
    );
  }

  const cardCls =
    "rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-4";
  const labelCls =
    "text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]";
  const inputCls =
    "w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-2 py-1 text-[12px]";

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-md bg-red-900/40 border border-red-700/60 px-3 py-2 text-[12px] text-red-200">
          {error}
        </div>
      )}
      {feedback && (
        <div className="mb-3 rounded-md bg-emerald-900/40 border border-emerald-700/60 px-3 py-2 text-[12px] text-emerald-200">
          {feedback}
        </div>
      )}

      <div className={cardCls}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold">SMTP intake</h3>
            <p className="text-[11px] text-[var(--color-foreground-muted)]">
              Cameras send motion mails here; the manager forwards them to the
              events bus as native motion events.
            </p>
          </div>
          {status && (
            <span
              className={
                status.running
                  ? "px-2 py-0.5 rounded text-[11px] bg-emerald-900/50 text-emerald-200"
                  : "px-2 py-0.5 rounded text-[11px] bg-zinc-800 text-zinc-300"
              }
            >
              {status.running ? "Running" : "Stopped"}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={labelCls}>Enabled</span>
            <div className="mt-1">
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm({ ...form, enabled: v })}
              />
            </div>
          </div>
          <div>
            <span className={labelCls}>Listen port</span>
            <Input
              type="number"
              className={inputCls}
              value={form.port}
              onChange={(e) => {
                const n = Number(e.currentTarget.value);
                if (Number.isFinite(n)) setForm({ ...form, port: n });
              }}
            />
          </div>
          <div>
            <span className={labelCls}>Bind host</span>
            <Input
              className={inputCls}
              value={form.bindHost}
              onChange={(e) => setForm({ ...form, bindHost: e.currentTarget.value })}
            />
            <span className="text-[10px] text-[var(--color-foreground-muted)]">
              0.0.0.0 = listen on LAN; 127.0.0.1 = local only
            </span>
          </div>
          <div>
            <span className={labelCls}>Virtual mail domain</span>
            <Input
              className={inputCls}
              value={form.domain}
              onChange={(e) => setForm({ ...form, domain: e.currentTarget.value })}
            />
            <span className="text-[10px] text-[var(--color-foreground-muted)]">
              Per-camera address is <code>cam-&lt;id&gt;@{form.domain}</code>
            </span>
          </div>
          <div>
            <span className={labelCls}>Require AUTH</span>
            <div className="mt-1">
              <Switch
                checked={form.requireAuth}
                onCheckedChange={(v) => setForm({ ...form, requireAuth: v })}
              />
            </div>
          </div>
          <div>
            <span className={labelCls}>STARTTLS</span>
            <div className="mt-1">
              <Switch
                checked={form.tls}
                onCheckedChange={(v) => setForm({ ...form, tls: v })}
              />
            </div>
            <span className="text-[10px] text-[var(--color-foreground-muted)]">
              Requires cert.pem + key.pem under DATA_PATH/email-push-tls/
            </span>
          </div>
          {form.requireAuth && (
            <>
              <div>
                <span className={labelCls}>AUTH username</span>
                <Input
                  className={inputCls}
                  value={form.authUsername}
                  onChange={(e) =>
                    setForm({ ...form, authUsername: e.currentTarget.value })
                  }
                />
              </div>
              <div>
                <span className={labelCls}>AUTH password</span>
                <Input
                  type="password"
                  className={inputCls}
                  placeholder={
                    settings?.authPasswordConfigured
                      ? "(unchanged — leave blank to keep)"
                      : ""
                  }
                  value={form.authPassword}
                  onChange={(e) =>
                    setForm({ ...form, authPassword: e.currentTarget.value })
                  }
                />
              </div>
            </>
          )}
          <div>
            <span className={labelCls}>Max message size (bytes)</span>
            <Input
              type="number"
              className={inputCls}
              value={form.maxMessageBytes}
              onChange={(e) => {
                const n = Number(e.currentTarget.value);
                if (Number.isFinite(n))
                  setForm({ ...form, maxMessageBytes: n });
              }}
            />
          </div>
          <div>
            <span className={labelCls}>Motion reset (ms)</span>
            <Input
              type="number"
              className={inputCls}
              value={form.motionResetMs}
              onChange={(e) => {
                const n = Number(e.currentTarget.value);
                if (Number.isFinite(n))
                  setForm({ ...form, motionResetMs: n });
              }}
            />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={saving}
            className="gap-1"
          >
            <RefreshCw size={12} /> Refresh
          </Button>
          {status?.running ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void action("restart")}
                disabled={saving}
                className="gap-1"
              >
                <RefreshCw size={12} /> Restart
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void action("stop")}
                disabled={saving}
                className="gap-1"
              >
                <PowerOff size={12} /> Stop
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void action("start")}
              disabled={saving || !form.enabled}
              className="gap-1"
            >
              <Power size={12} /> Start
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={saving}
            className="gap-1"
          >
            {saving ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Save size={12} />
            )}
            Save
          </Button>
        </div>
      </div>

      {status && (
        <div className={cardCls}>
          <h3 className="text-sm font-semibold mb-3">Runtime stats</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={labelCls}>Messages accepted</span>
              <Input className={inputCls} readOnly value={status.messagesAccepted} />
            </div>
            <div>
              <span className={labelCls}>Messages rejected</span>
              <Input className={inputCls} readOnly value={status.messagesRejected} />
            </div>
            <div>
              <span className={labelCls}>Started at</span>
              <Input
                className={inputCls}
                readOnly
                value={
                  status.startedAtMs
                    ? new Date(status.startedAtMs).toLocaleString()
                    : "—"
                }
              />
            </div>
            <div>
              <span className={labelCls}>Last error</span>
              <Input
                className={inputCls}
                readOnly
                value={status.lastErrorMessage ?? "—"}
              />
            </div>
          </div>
        </div>
      )}

      <div className={cardCls}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold">
              Recent emails ({recent.length})
            </h3>
            <p className="text-[11px] text-[var(--color-foreground-muted)]">
              In-memory log of the last 300 messages the SMTP intake received,
              most recent first. Cleared on restart. Metadata only — no
              attachments are stored.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
            className="gap-1"
          >
            <RefreshCw size={12} /> Refresh
          </Button>
        </div>
        {recent.length === 0 ? (
          <p className="text-[12px] text-[var(--color-foreground-muted)]">
            No emails received yet.
          </p>
        ) : (
          <div className="max-h-[480px] overflow-y-auto pr-1 -mr-1 flex flex-col gap-2">
            {recent.map((ev, idx) => (
              <div
                key={`${ev.receivedAtMs}-${idx}`}
                className="rounded border border-[var(--color-border)] bg-[var(--color-background)] p-2 text-[12px]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{ev.inferredType}</span>
                  <span className="text-[10px] text-[var(--color-foreground-muted)] tabular-nums">
                    {new Date(ev.receivedAtMs).toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-[var(--color-foreground-muted)] truncate">
                  <span className="opacity-70">subject:</span>{" "}
                  {ev.subject || "(none)"}
                </div>
                <div className="text-[10px] text-[var(--color-foreground-subtle)] truncate">
                  <span className="opacity-70">from:</span> {ev.from || "?"}{" "}
                  · <span className="opacity-70">to:</span> {ev.recipient}
                </div>
                <div className="text-[10px] text-[var(--color-foreground-subtle)] truncate">
                  <span className="opacity-70">cam:</span> {ev.cameraId}
                </div>
                {ev.bodyExcerpt ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]">
                      Body excerpt ({ev.bodyExcerpt.length} chars)
                    </summary>
                    <pre className="mt-1 whitespace-pre-wrap break-words text-[10px] leading-snug text-[var(--color-foreground-muted)]">
                      {ev.bodyExcerpt}
                    </pre>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
