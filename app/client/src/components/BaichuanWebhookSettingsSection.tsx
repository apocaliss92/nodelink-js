import { useCallback, useEffect, useState } from "react";
import { Loader2, Save, RefreshCw, Power, PowerOff } from "lucide-react";
import { Button, Input, Switch } from "@camstack/ui-library";
import { trpcMutation, trpcQuery } from "../api";

interface BaichuanWebhookSettings {
  enabled: boolean;
  port: number;
  bindHost: string;
  pathPrefix: string;
}

interface BaichuanWebhookStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  bindHost: string;
  pathPrefix: string;
  messagesAccepted: number;
  messagesRejected: number;
  startedAtMs: number | undefined;
  lastErrorMessage: string | undefined;
}

interface RecentEvent {
  cameraId: string;
  event: string;
  reason?: string;
  receivedAtMs: number;
}

/**
 * Settings → Baichuan Webhook pane (HaCfg cmd 806/807 intake).
 */
export function BaichuanWebhookSettingsSection() {
  const [settings, setSettings] = useState<BaichuanWebhookSettings | null>(
    null,
  );
  const [status, setStatus] = useState<BaichuanWebhookStatus | null>(null);
  const [recent, setRecent] = useState<RecentEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<BaichuanWebhookSettings | null>(null);

  const refresh = useCallback(async () => {
    const [s, st, ev] = await Promise.all([
      trpcQuery<BaichuanWebhookSettings>("baichuanWebhook.getSettings"),
      trpcQuery<BaichuanWebhookStatus>("baichuanWebhook.status"),
      trpcQuery<RecentEvent[]>("baichuanWebhook.recentEvents", { limit: 20 }),
    ]);
    setSettings(s);
    setForm(s);
    setStatus(st);
    setRecent(ev);
  }, []);

  useEffect(() => {
    void refresh().catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [refresh]);

  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      const next = await trpcMutation<BaichuanWebhookSettings>(
        "baichuanWebhook.updateSettings",
        form,
      );
      setSettings(next);
      setForm(next);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startStop(action: "start" | "stop" | "restart") {
    setBusy(true);
    setError(null);
    try {
      await trpcMutation(`baichuanWebhook.${action}`, undefined);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!form || !settings) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-foreground-muted)]">
        Loading Baichuan webhook settings…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-medium text-[var(--color-foreground)]">
              Baichuan Webhook (HaCfg)
            </div>
            <div className="text-xs text-[var(--color-foreground-muted)] mt-1 max-w-xl">
              Battery cameras POST wake/sleep JSON here (cmd 806/807) while the
              control socket is idle-disconnected. Parallel to Email Push —
              arm a camera with <code>baichuanWebhook.setupCamera</code>.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={form.enabled}
              onCheckedChange={(v) => setForm({ ...form, enabled: v })}
            />
            <span className="text-xs text-[var(--color-foreground-muted)]">
              Enabled
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="text-xs space-y-1">
            <span className="text-[var(--color-foreground-muted)]">Port</span>
            <Input
              type="number"
              value={form.port}
              onChange={(e) =>
                setForm({ ...form, port: Number(e.target.value) || 9081 })
              }
            />
          </label>
          <label className="text-xs space-y-1">
            <span className="text-[var(--color-foreground-muted)]">
              Bind host
            </span>
            <Input
              value={form.bindHost}
              onChange={(e) => setForm({ ...form, bindHost: e.target.value })}
            />
          </label>
          <label className="text-xs space-y-1">
            <span className="text-[var(--color-foreground-muted)]">
              Path prefix
            </span>
            <Input
              value={form.pathPrefix}
              onChange={(e) =>
                setForm({ ...form, pathPrefix: e.target.value })
              }
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void save()} disabled={busy}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void startStop("start")}
            disabled={busy}
          >
            <Power className="h-3.5 w-3.5" />
            Start
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void startStop("stop")}
            disabled={busy}
          >
            <PowerOff className="h-3.5 w-3.5" />
            Stop
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void startStop("restart")}
            disabled={busy}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Restart
          </Button>
        </div>

        {error ? (
          <div className="text-xs text-[var(--color-danger,#ef4444)]">
            {error}
          </div>
        ) : null}

        {status ? (
          <div className="text-xs text-[var(--color-foreground-muted)] space-y-1">
            <div>
              Status:{" "}
              <strong className="text-[var(--color-foreground)]">
                {status.running ? "running" : "stopped"}
              </strong>{" "}
              on {status.bindHost}:{status.port}
              {status.pathPrefix}
            </div>
            <div>
              Accepted {status.messagesAccepted} / rejected{" "}
              {status.messagesRejected}
              {status.lastErrorMessage
                ? ` — last error: ${status.lastErrorMessage}`
                : ""}
            </div>
          </div>
        ) : null}
      </div>

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="text-sm font-medium mb-2">Recent events</div>
        {recent.length === 0 ? (
          <div className="text-xs text-[var(--color-foreground-muted)]">
            No webhook events yet.
          </div>
        ) : (
          <ul className="text-xs space-y-1 font-mono">
            {recent.map((e, i) => (
              <li key={`${e.receivedAtMs}-${i}`}>
                {new Date(e.receivedAtMs).toLocaleTimeString()} {e.cameraId}{" "}
                {e.event}
                {e.reason ? `/${e.reason}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
