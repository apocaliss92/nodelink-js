import { useCallback, useEffect, useMemo, useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@camstack/ui-library";
import { fetchUpdates, trpcMutation, trpcQuery, type UpdateInfo } from "../api";
import { useAuth } from "../auth";
import { getStoredAuthToken, setStoredAuthToken } from "../authToken";
import { EmailPushSettingsSection } from "../components/EmailPushSettingsSection";
import { useEmailPushFeature } from "../hooks/useEmailPushFeature";

/** Build Frigate camera YAML from streamInfo + feature options. */
function buildFrigateYaml(
  streams: any[],
  frigateName: string,
  opts: {
    useFrigateGo2rtc: boolean;
    recordEnabled: boolean;
    detectEnabled: boolean;
    snapshotsEnabled: boolean;
    audioEnabled: boolean;
  },
): string {
  const inputs: any[] = [];
  const go2rtcStreamsBlock: string[] = [];
  for (const s of streams) {
    if (!s.roles?.length) continue;
    const streamPath = opts.useFrigateGo2rtc
      ? `rtsp://127.0.0.1:8554/${s.go2rtcName}`
      : s.rtspUrl;
    const inp: any = { path: streamPath, roles: s.roles };
    const inputArgs = s._inputArgs ?? "preset-rtsp-restream";
    if (inputArgs) inp.input_args = inputArgs;
    const hwaccel = s._hwaccelArgs ?? "";
    if (hwaccel) inp.hwaccel_args = hwaccel;
    inputs.push(inp);
    if (opts.useFrigateGo2rtc) {
      go2rtcStreamsBlock.push(`    ${s.go2rtcName}: "${s.rtspUrl}"`);
    }
  }
  const cam: any = { enabled: true, ffmpeg: { inputs } };
  cam.detect = { enabled: opts.detectEnabled };
  cam.record = { enabled: opts.recordEnabled };
  cam.snapshots = { enabled: opts.snapshotsEnabled };
  cam.audio = { enabled: opts.audioEnabled };

  const yamlLines: string[] = [];
  const write = (obj: any, indent: number) => {
    const pad = "  ".repeat(indent);
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === "object" && item !== null) {
          const entries = Object.entries(item);
          yamlLines.push(`${pad}- ${entries[0]![0]}: ${JSON.stringify(entries[0]![1])}`);
          for (let i = 1; i < entries.length; i++) {
            const [k, v] = entries[i]!;
            if (Array.isArray(v)) {
              yamlLines.push(`${pad}  ${k}:`);
              for (const vi of v) yamlLines.push(`${pad}    - ${vi}`);
            } else {
              yamlLines.push(`${pad}  ${k}: ${typeof v === "string" && /[:#]/.test(v) ? JSON.stringify(v) : v}`);
            }
          }
        } else {
          yamlLines.push(`${pad}- ${item}`);
        }
      }
    } else if (typeof obj === "object" && obj !== null) {
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null) continue;
        if (typeof v === "object") {
          yamlLines.push(`${pad}${k}:`);
          write(v, indent + 1);
        } else {
          yamlLines.push(`${pad}${k}: ${v}`);
        }
      }
    }
  };
  if (go2rtcStreamsBlock.length > 0) {
    yamlLines.push("# go2rtc streams (add to go2rtc section)");
    yamlLines.push("go2rtc:");
    yamlLines.push("  streams:");
    for (const line of go2rtcStreamsBlock) yamlLines.push(line);
    yamlLines.push("");
  }
  yamlLines.push(`${frigateName}:`);
  write(cam, 1);
  return yamlLines.join("\n");
}

type Settings = {
  logLevel: "error" | "warn" | "info" | "debug";
  logRetentionDays: number;
  rtspRequireAuth: boolean;
  serviceIp?: string;
  auth?: {
    trustedProxy?: {
      enabled: boolean;
      allowedIps: string[];
      usernameHeader: string;
      groupsHeader: string;
      adminGroup: string;
    };
  };
  webrtc?: {
    icePortRange: string;
    iceAdditionalHostAddresses: string;
  };
  mqtt?: {
    enabled: boolean;
    brokerUrl: string;
    username?: string;
    password?: string;
    clientId?: string;
    topicPrefix: string;
    qos: 0 | 1 | 2;
    reconnectPeriod: number;
  };
  homeassistant?: {
    enabled: boolean;
    discoveryPrefix: string;
    pollIntervalSeconds: number;
    stateTopicPrefix: string;
  };
  restreamer?: "go2rtc" | "local";
  localRtsp?: {
    port: number;
    bindHost: string;
    requireAuth?: boolean;
  };
  go2rtc?: {
    enabled: boolean;
    binaryPath: string;
    apiPort: number;
    rtspPort: number;
    webrtcPort: number;
    iceServers: string[];
  };
  frigate?: {
    host: string;
    username: string;
    password: string;
  };
};

type RuntimeInfo = {
  httpPort: number;
  rtspPort: number;
  dataPath: string;
  appVersion?: string | null;
};

type DashboardUser = {
  username: string;
  role: "admin" | "user";
  createdAt?: number;
  updatedAt?: number;
};

type Metrics = {
  timestamp: string;
  process: {
    pid: number;
    nodeVersion: string;
    uptimeSeconds: number;
    memory: {
      rss: number;
      heapUsed: number;
      heapTotal: number;
      external: number;
      arrayBuffers: number;
    };
    cpu: {
      percent: number | null;
      userUs: number;
      systemUs: number;
      windowMs: number;
    };
    eventLoop: {
      utilization: number;
    };
  };
  system: {
    cpuCount: number | null;
    loadAvg: number[];
    totalMem: number;
    freeMem: number;
  };
};

// ---------------------------------------------------------------------------
// Shared Tailwind class strings
// ---------------------------------------------------------------------------
const cardCls =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4";

const labelCls =
  "text-xs font-medium text-[var(--color-foreground-muted)] uppercase tracking-wider mb-1.5 block";

const inputCls =
  "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm text-[var(--color-foreground)] outline-none";

const btnCls =
  "border border-[var(--color-border)] bg-white/[.06] text-[var(--color-foreground)] rounded-md cursor-pointer text-xs px-3 py-1.5 disabled:opacity-60 disabled:cursor-not-allowed";

const btnPrimaryCls =
  "border border-[rgba(59,130,246,0.55)] bg-[rgba(59,130,246,0.28)] text-[var(--color-foreground)] rounded-md cursor-pointer text-xs px-3 py-1.5 disabled:opacity-60 disabled:cursor-not-allowed";

const btnDangerCls =
  "border border-[rgba(239,68,68,0.5)] bg-[rgba(239,68,68,0.18)] text-[var(--color-foreground)] rounded-md cursor-pointer text-xs px-3 py-1.5 disabled:opacity-60 disabled:cursor-not-allowed";

const monoCls = "font-mono";

export default function SettingsPage() {
  const { state: authState, refresh: refreshAuth } = useAuth();

  const [settings, setSettings] = useState<Settings | null>(null);
  // Last-loaded snapshot used to detect settings that require a server
  // restart to take effect (e.g. restreamer backend).
  const [loadedRestreamer, setLoadedRestreamer] = useState<
    "go2rtc" | "local" | undefined
  >(undefined);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);

  const [dashUsers, setDashUsers] = useState<DashboardUser[]>([]);
  const [savingDashUsers, setSavingDashUsers] = useState(false);
  const [addDashUserOpen, setAddDashUserOpen] = useState(false);
  const [dashUserDraft, setDashUserDraft] = useState<{
    username: string;
    password: string;
    role: "admin" | "user";
  }>({ username: "", password: "", role: "user" });

  const [personalToken, setPersonalToken] = useState<string | null>(null);
  const [creatingPersonalToken, setCreatingPersonalToken] = useState(false);

  const [go2rtcStatus, setGo2rtcStatus] = useState<{
    running: boolean;
    apiUrl: string | null;
    streams: Record<string, unknown>;
  } | null>(null);
  const [go2rtcLoading, setGo2rtcLoading] = useState(false);

  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsAutoRefresh, setMetricsAutoRefresh] = useState(true);

  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  const [frigateLoading, setFrigateLoading] = useState(false);
  const [frigateConnected, setFrigateConnected] = useState<{
    ok: boolean;
    version?: string;
    error?: string;
  } | null>(null);
  const [frigateExistingCameras, setFrigateExistingCameras] = useState<string[]>([]);
  const [frigateSelectedId, setFrigateSelectedId] = useState<string>("");
  const [frigatePreview, setFrigatePreview] = useState<any>(null);
  const [frigateApplying, setFrigateApplying] = useState(false);
  const [frigateMessage, setFrigateMessage] = useState<string | null>(null);
  const [frigateMatchData, setFrigateMatchData] = useState<any>(null);
  const [frigateRemoveNames, setFrigateRemoveNames] = useState<Set<string>>(new Set());
  const [frigateBackups, setFrigateBackups] = useState<Array<{ id: string; timestamp: string; summary: string }>>([]);
  const [frigateBackupsOpen, setFrigateBackupsOpen] = useState(false);
  const [frigateCameraList, setFrigateCameraList] = useState<
    Array<{ id: string; name: string; status: string }>
  >([]);
  const [frigateSystemInfo, setFrigateSystemInfo] = useState<{
    globalHwaccel: string;
    hwaccelFamily: string | null;
  } | null>(null);

  type TabId =
    | "general"
    | "go2rtc"
    | "frigate"
    | "auth"
    | "mqtt"
    | "webrtc"
    | "proxy"
    | "metrics"
    | "email-push";
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const emailPushFeature = useEmailPushFeature();

  const dirty = useMemo(() => settings !== null, [settings]);

  // Auto-connect to Frigate when the tab is opened or settings are saved
  const connectToFrigate = useCallback(async () => {
    const fg = settings?.frigate;
    if (!fg?.host) return;
    setFrigateLoading(true);
    setFrigateMessage(null);
    try {
      const fgConn = { host: fg.host, username: fg.username, password: fg.password };
      const camList = await trpcQuery<Array<{ id: string; name: string; status: string }>>("cameras.list");
      setFrigateCameraList(camList);
      const res = await trpcQuery<{ ok: boolean; version?: string; error?: string }>("frigate.ping", fgConn);
      setFrigateConnected(res);
      if (res.ok) {
        const [cams, matchData, backups, sysInfo] = await Promise.all([
          trpcQuery<string[]>("frigate.getCameras", fgConn),
          trpcQuery<any>("frigate.match", fgConn),
          trpcQuery<Array<{ id: string; timestamp: string; summary: string }>>("frigate.listBackups"),
          trpcQuery<{ globalHwaccel: string; hwaccelFamily: string | null }>("frigate.getSystemInfo", fgConn),
        ]);
        setFrigateExistingCameras(cams);
        setFrigateMatchData(matchData);
        setFrigateBackups(backups);
        setFrigateSystemInfo(sysInfo);
        setFrigateRemoveNames(new Set());
      }
    } catch (e) {
      setFrigateConnected({ ok: false, error: String(e) });
    } finally {
      setFrigateLoading(false);
    }
  }, [settings?.frigate?.host, settings?.frigate?.username, settings?.frigate?.password]);

  // Auto-connect when switching to the frigate tab
  useEffect(() => {
    if (activeTab === "frigate" && settings?.frigate?.host && !frigateConnected && !frigateLoading) {
      void connectToFrigate();
    }
  }, [activeTab, settings?.frigate?.host, frigateConnected, frigateLoading, connectToFrigate]);

  useEffect(() => {
    // Fast path: show whatever is currently stored.
    setPersonalToken(getStoredAuthToken());
  }, []);

  useEffect(() => {
    if (!authState.enabled || !authState.user) return;

    let cancelled = false;

    (async () => {
      try {
        const currentToken = getStoredAuthToken();
        if (!currentToken) return;

        const res = await fetch("/api/auth/personal-token", {
          method: "GET",
          headers: {
            ...(currentToken
              ? { Authorization: `Bearer ${currentToken}` }
              : {}),
          },
        });

        if (cancelled) return;

        if (res.status === 404) {
          setPersonalToken(null);
          return;
        }

        if (!res.ok) {
          // Don't hard-fail the whole page, just ignore.
          return;
        }

        const data = (await res.json()) as { token: string };
        if (data?.token) {
          // Avoid infinite refresh loops:
          // Only update storage / refresh auth if the token actually changed.
          if (data.token !== currentToken) {
            setPersonalToken(data.token);
            setStoredAuthToken(data.token);
            await refreshAuth();
          } else {
            // Keep UI in sync without forcing a refresh.
            setPersonalToken((prev) =>
              prev === data.token ? prev : data.token,
            );
          }
        }
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    authState.enabled,
    authState.user?.username,
    authState.user?.kind,
    refreshAuth,
  ]);

  useEffect(() => {
    (async () => {
      try {
        const s = await trpcQuery<Settings>("settings.get");
        setSettings(s);
        setLoadedRestreamer(s.restreamer ?? "go2rtc");

        const r = await trpcQuery<RuntimeInfo>("settings.getRuntime");
        setRuntime(r);

        if (authState.user?.role === "admin") {
          try {
            const u = await trpcQuery<DashboardUser[]>(
              "settings.listDashboardUsers",
            );
            setDashUsers(u);
          } catch {
            // Ignore if server refuses (not admin) or not available
          }
        }
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [authState.user?.role]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await fetchUpdates();
        if (!cancelled) setUpdateInfo(info);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authState.enabled, authState.user?.username]);

  const isAuthEnabled = authState.enabled === true;
  const canEditSettings = isAuthEnabled
    ? authState.user?.role === "admin"
    : true;

  const canViewMetrics =
    isAuthEnabled === false || authState.user?.role === "admin";

  const fetchMetricsOnce = useCallback(async () => {
    if (!canViewMetrics) return;
    setMetricsLoading(true);
    try {
      const token = getStoredAuthToken();
      const res = await fetch("/api/metrics", {
        method: "GET",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (res.status === 403) {
        setMetricsError("Forbidden");
        return;
      }

      if (!res.ok) {
        setMetricsError(`HTTP ${res.status}`);
        return;
      }

      const data = (await res.json()) as Metrics;
      setMetrics(data);
      setMetricsError(null);
    } catch (e) {
      setMetricsError(String(e));
    } finally {
      setMetricsLoading(false);
    }
  }, [canViewMetrics]);

  useEffect(() => {
    if (!canViewMetrics) return;
    void fetchMetricsOnce();
  }, [canViewMetrics, fetchMetricsOnce]);

  useEffect(() => {
    if (!canViewMetrics) return;
    if (!metricsAutoRefresh) return;

    let cancelled = false;
    const timer = window.setInterval(() => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") return;
      void fetchMetricsOnce();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [canViewMetrics, fetchMetricsOnce, metricsAutoRefresh]);

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes)) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    const digits = i === 0 ? 0 : i === 1 ? 1 : 2;
    return `${n.toFixed(digits)} ${units[i]}`;
  }

  function formatSeconds(seconds: number): string {
    if (!Number.isFinite(seconds)) return "";
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  async function refreshDashboardUsers() {
    const list = await trpcQuery<DashboardUser[]>(
      "settings.listDashboardUsers",
    );
    setDashUsers(list);
  }

  async function addDashboardUser() {
    if (!dashUserDraft.username || !dashUserDraft.password) return;
    setSavingDashUsers(true);
    try {
      await trpcMutation("settings.addDashboardUser", {
        username: dashUserDraft.username,
        password: dashUserDraft.password,
        role: dashUserDraft.role,
      });
      setDashUserDraft({ username: "", password: "", role: "user" });
      await refreshDashboardUsers();
      setAddDashUserOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingDashUsers(false);
    }
  }

  async function deleteDashboardUser(username: string) {
    if (!confirm(`Delete dashboard user '${username}'?`)) return;
    setSavingDashUsers(true);
    try {
      await trpcMutation("settings.deleteDashboardUser", { username });
      await refreshDashboardUsers();
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingDashUsers(false);
    }
  }

  async function resetDashboardUserPassword(username: string) {
    const newPassword = prompt(`New password for '${username}':`);
    if (!newPassword) return;
    setSavingDashUsers(true);
    try {
      await trpcMutation("settings.setDashboardUserPassword", {
        username,
        password: newPassword,
      });
      await refreshDashboardUsers();
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingDashUsers(false);
    }
  }

  async function save() {
    if (!settings) return;
    // The restreamer backend swap requires a full process restart to take
    // effect (go2rtc sidecar lifecycle is boot-time only). Detect the change
    // and let the user confirm before we save + restart.
    const newRestreamer = settings.restreamer ?? "go2rtc";
    const needsRestart =
      loadedRestreamer !== undefined && newRestreamer !== loadedRestreamer;
    if (needsRestart) {
      setRestartConfirmOpen(true);
      return;
    }
    await persistSettings();
  }

  async function persistSettings() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      await trpcMutation("settings.update", {
        serviceIp: settings.serviceIp,
        logLevel: settings.logLevel,
        logRetentionDays: settings.logRetentionDays,
        rtspRequireAuth: settings.rtspRequireAuth,
        auth: settings.auth,
        webrtc: settings.webrtc,
        mqtt: settings.mqtt,
        homeassistant: settings.homeassistant,
        go2rtc: settings.go2rtc,
        restreamer: settings.restreamer,
        localRtsp: settings.localRtsp,
        frigate: settings.frigate,
      });
      setLoadedRestreamer(settings.restreamer ?? "go2rtc");
      // Re-connect to Frigate after saving (connection params may have changed)
      if (settings.frigate?.host) {
        setFrigateConnected(null);
        void connectToFrigate();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  /**
   * Save settings and then request a server restart. The backend exits the
   * Node process; an external supervisor (systemd/docker/pm2) brings it
   * back up. The UI shows a "Restarting..." state and reloads the page
   * after a short delay so the user lands on the fresh instance.
   */
  async function saveAndRestart() {
    setRestartConfirmOpen(false);
    await persistSettings();
    setRestarting(true);
    try {
      await trpcMutation("settings.restart", {});
    } catch (e) {
      // Server likely exited before the response came back — that's OK.
      // Ignore connection errors, surface real schema/validation errors.
      const msg = String(e);
      if (
        !msg.toLowerCase().includes("failed to fetch") &&
        !msg.toLowerCase().includes("networkerror")
      ) {
        setError(msg);
      }
    }
    // Poll the app until it responds again, then reload.
    const startedAt = Date.now();
    const timeoutMs = 60_000;
    const poll = async () => {
      if (Date.now() - startedAt > timeoutMs) {
        setError(
          "Server did not come back up within 60s. Check your supervisor (docker/systemd/pm2) and reload manually.",
        );
        setRestarting(false);
        return;
      }
      try {
        const res = await fetch("/api/trpc/settings.getRuntime", {
          method: "GET",
          cache: "no-store",
        });
        if (res.ok) {
          window.location.reload();
          return;
        }
      } catch {
        // still down — keep polling
      }
      window.setTimeout(poll, 1_000);
    };
    window.setTimeout(poll, 2_000);
  }

  async function createPersonalToken() {
    setCreatingPersonalToken(true);
    setError(null);
    try {
      const token = getStoredAuthToken();
      const res = await fetch("/api/auth/personal-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: "{}",
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
      }

      const data = (await res.json()) as { token: string };
      // Store it as the active token immediately; the server revokes previous
      // tokens for this user when generating a new personal token.
      setStoredAuthToken(data.token);
      setPersonalToken(data.token);
      await refreshAuth();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreatingPersonalToken(false);
    }
  }

  return (
    <div className="p-5">
      {/* Page header */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <h1 className="text-lg font-bold m-0">Settings</h1>
        <button
          className={btnPrimaryCls}
          disabled={!dirty || saving || !canEditSettings}
          onClick={save}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-[rgba(239,68,68,0.5)] bg-[var(--color-surface)] p-4 mb-3">
          <div className="text-[#fecaca]">Error: {error}</div>
        </div>
      ) : null}

      {!settings ? (
        <div className={cardCls}>Loading…</div>
      ) : (
        <>
          {/* Tab bar */}
          <div className="flex gap-1 border-b border-[var(--color-border)] mb-4 flex-wrap">
            {(
              [
                ["general", "General"],
                ["go2rtc", "Restreamer"],
                ["frigate", "Frigate"],
                ["auth", "Auth"],
                ["mqtt", "MQTT"],
                ["webrtc", "WebRTC"],
                ["proxy", "Proxy"],
                ["metrics", "Metrics"],
                // Email Push is hidden behind the master feature flag; only
                // surface the tab when the flag is on.
                ...(emailPushFeature.enabled
                  ? ([["email-push", "Email Push"]] as const)
                  : ([] as const)),
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={
                  activeTab === id
                    ? "px-3 py-2 text-xs font-medium transition-colors border-b-2 border-[var(--color-primary)] text-[var(--color-foreground)] cursor-pointer bg-transparent"
                    : "px-3 py-2 text-xs font-medium transition-colors text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] cursor-pointer bg-transparent border-b-2 border-transparent"
                }
                onClick={() => setActiveTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* General tab */}
          {activeTab === "general" ? (
            <div className={cardCls}>
              <span className={labelCls}>Runtime (read-only)</span>
              <div className="grid grid-cols-2 gap-3 mt-2.5">
                <div>
                  <span className={labelCls}>HTTP port</span>
                  <input
                    className={inputCls}
                    readOnly
                    value={runtime ? String(runtime.httpPort) : ""}
                  />
                </div>
                <div>
                  <span className={labelCls}>RTSP port</span>
                  <input
                    className={inputCls}
                    readOnly
                    value={runtime ? String(runtime.rtspPort) : ""}
                  />
                </div>
              </div>

              <div className="mt-3">
                <span className={labelCls}>App version</span>
                <input
                  className={inputCls}
                  readOnly
                  value={runtime?.appVersion ? String(runtime.appVersion) : ""}
                />
                <div className="text-[var(--color-foreground-muted)] text-xs mt-1.5">
                  {updateInfo?.updateAvailable && updateInfo.latestVersion ? (
                    <>
                      Update available:{" "}
                      <a
                        href={updateInfo.releaseUrl ?? "#"}
                        target={updateInfo.releaseUrl ? "_blank" : undefined}
                        rel={updateInfo.releaseUrl ? "noreferrer" : undefined}
                        className="underline"
                      >
                        v{updateInfo.latestVersion}
                      </a>
                    </>
                  ) : updateInfo?.error ? (
                    <>Update check unavailable</>
                  ) : updateInfo ? (
                    <>Up to date</>
                  ) : (
                    <>Checking updates…</>
                  )}
                </div>
              </div>

              <div className="mt-3">
                <span className={labelCls}>Data folder</span>
                <input
                  className={inputCls}
                  readOnly
                  value={runtime ? runtime.dataPath : ""}
                />
              </div>

              <div className="mt-3">
                <span className={labelCls}>Service IP (for RTSP/MJPEG URLs)</span>
                <input
                  className={inputCls}
                  value={settings.serviceIp ?? "localhost"}
                  disabled={!canEditSettings}
                  onChange={(e) =>
                    setSettings({ ...settings, serviceIp: e.target.value })
                  }
                />
              </div>

              <span className={`${labelCls} mt-4`}>Logging</span>
              <div className="grid grid-cols-2 gap-3 mt-2.5">
                <div>
                  <span className={labelCls}>Log level</span>
                  <select
                    className={inputCls}
                    value={settings.logLevel}
                    disabled={!canEditSettings}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        logLevel: e.target.value as Settings["logLevel"],
                      })
                    }
                  >
                    <option value="error">error</option>
                    <option value="warn">warn</option>
                    <option value="info">info</option>
                    <option value="debug">debug</option>
                  </select>
                </div>
                <div>
                  <span className={labelCls}>Log retention days</span>
                  <input
                    className={inputCls}
                    type="number"
                    value={settings.logRetentionDays}
                    disabled={!canEditSettings}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        logRetentionDays: Number(e.target.value),
                      })
                    }
                  />
                </div>
              </div>

              {isAuthEnabled ? (
                <div className="flex items-center gap-2.5 flex-wrap mt-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.rtspRequireAuth}
                      disabled={!canEditSettings}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          rtspRequireAuth: e.target.checked,
                        })
                      }
                    />
                    <span>
                      Require auth for RTSP connections (uses the Users list)
                    </span>
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Auth tab */}
          {activeTab === "auth" ? (
            <div className={cardCls}>
              <span className={labelCls}>Dashboard authentication</span>
              {authState.enabled && authState.user ? (
                <>
                  <div className="mt-3">
                    <span className={labelCls}>Personal token</span>
                    <div className="text-[var(--color-foreground-muted)] text-xs">
                      Generate a long-lived token for streaming endpoints (MJPEG/HLS
                      via <span className={monoCls}>?token=</span>, WebRTC via
                      <span className={monoCls}> Authorization: Bearer</span>). This
                      token does not expire.
                    </div>

                    <div className="flex items-center justify-end gap-2.5 mt-2.5">
                      <button
                        className={btnPrimaryCls}
                        disabled={creatingPersonalToken}
                        onClick={() => void createPersonalToken()}
                      >
                        Generate personal token
                      </button>
                    </div>

                    {personalToken ? (
                      <div className="mt-2.5">
                        <div className="flex items-center gap-2.5 mt-2">
                          <input
                            className={`${inputCls} ${monoCls} flex-1 min-w-0`}
                            readOnly
                            value={personalToken}
                          />
                          <button
                            className={btnCls}
                            onClick={() =>
                              void navigator.clipboard
                                .writeText(personalToken)
                                .catch(() => {})
                            }
                          >
                            Copy
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {authState.user?.role === "admin" ? (
                    <div className="mt-4">
                      <span className={labelCls}>Users</span>
                      <div className="text-[var(--color-foreground-muted)] text-xs">
                        Users that can access this web dashboard and authenticate to
                        the RTSP proxy (Digest).
                      </div>

                      <div className="flex items-center justify-end gap-2.5 mt-2.5">
                        <button
                          className={btnCls}
                          disabled={savingDashUsers}
                          onClick={() => void refreshDashboardUsers()}
                        >
                          Refresh users
                        </button>
                        <button
                          className={btnPrimaryCls}
                          disabled={savingDashUsers}
                          onClick={() => {
                            setDashUserDraft({
                              username: "",
                              password: "",
                              role: "user",
                            });
                            setAddDashUserOpen(true);
                          }}
                        >
                          Add user
                        </button>
                      </div>

                      {dashUsers.length === 0 ? (
                        <div className="text-[var(--color-foreground-muted)] text-sm mt-2.5">
                          No dashboard users configured.
                        </div>
                      ) : (
                        <table className="w-full text-sm mt-2.5">
                          <thead>
                            <tr>
                              <th className="text-left px-2.5 py-2 border-b border-[var(--color-border)] text-[var(--color-foreground-muted)] text-xs font-semibold" style={{ width: 220 }}>Username</th>
                              <th className="text-left px-2.5 py-2 border-b border-[var(--color-border)] text-[var(--color-foreground-muted)] text-xs font-semibold" style={{ width: 110 }}>Role</th>
                              <th className="text-left px-2.5 py-2 border-b border-[var(--color-border)] text-[var(--color-foreground-muted)] text-xs font-semibold" />
                              <th className="text-left px-2.5 py-2 border-b border-[var(--color-border)] text-[var(--color-foreground-muted)] text-xs font-semibold" style={{ width: 220 }} />
                            </tr>
                          </thead>
                          <tbody>
                            {dashUsers.map((u) => (
                              <tr key={u.username}>
                                <td className={`${monoCls} px-2.5 py-2 border-b border-[var(--color-border)] align-top`}>{u.username}</td>
                                <td className="px-2.5 py-2 border-b border-[var(--color-border)] align-top">{u.role}</td>
                                <td className="px-2.5 py-2 border-b border-[var(--color-border)] align-top" />
                                <td className="px-2.5 py-2 border-b border-[var(--color-border)] align-top text-right">
                                  <button
                                    className={btnCls}
                                    disabled={savingDashUsers}
                                    onClick={() =>
                                      void resetDashboardUserPassword(u.username)
                                    }
                                  >
                                    Reset password
                                  </button>
                                  <button
                                    className={`${btnDangerCls} ml-1`}
                                    disabled={savingDashUsers}
                                    onClick={() =>
                                      void deleteDashboardUser(u.username)
                                    }
                                  >
                                    Delete
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  ) : (
                    <div className="mt-4">
                      <span className={labelCls}>Users</span>
                      <div className="text-[var(--color-foreground-muted)] text-xs">
                        Only admins can manage dashboard users.
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-[var(--color-foreground-muted)] text-xs mt-2">
                  Auth is disabled. Set AUTH_ENABLED=1 to secure the dashboard.
                </div>
              )}
            </div>
          ) : null}

          {/* MQTT tab */}
          {activeTab === "mqtt" ? (
            <div className={cardCls}>
              <span className={labelCls}>MQTT (events publishing)</span>
              <div className="text-[var(--color-foreground-muted)] text-xs">
                Publish camera events to an MQTT broker for SSE, JSON stream, and
                Home Assistant integration.
              </div>

              {(() => {
                const mqtt = settings.mqtt ?? {
                  enabled: false,
                  brokerUrl: "mqtt://localhost:1883",
                  username: "",
                  password: "",
                  clientId: "",
                  topicPrefix: "nodelink-js",
                  qos: 0 as 0 | 1 | 2,
                  reconnectPeriod: 5000,
                };

                return (
                  <>
                    <div className="flex items-center gap-2.5 flex-wrap mt-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={mqtt.enabled}
                          disabled={!canEditSettings}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              mqtt: { ...mqtt, enabled: e.target.checked },
                            })
                          }
                        />
                        <span>Enable MQTT</span>
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-3 mt-2.5">
                      <div style={{ gridColumn: "1 / -1" }}>
                        <span className={labelCls}>Broker URL</span>
                        <input
                          className={`${inputCls} ${monoCls}`}
                          placeholder="mqtt://localhost:1883"
                          value={mqtt.brokerUrl}
                          disabled={!canEditSettings}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              mqtt: { ...mqtt, brokerUrl: e.target.value },
                            })
                          }
                        />
                      </div>
                      <div>
                        <span className={labelCls}>Username</span>
                        <input
                          className={inputCls}
                          value={mqtt.username ?? ""}
                          disabled={!canEditSettings}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              mqtt: { ...mqtt, username: e.target.value || undefined },
                            })
                          }
                        />
                      </div>
                      <div>
                        <span className={labelCls}>Password</span>
                        <input
                          className={inputCls}
                          type="password"
                          value={mqtt.password ?? ""}
                          disabled={!canEditSettings}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              mqtt: { ...mqtt, password: e.target.value || undefined },
                            })
                          }
                        />
                      </div>
                      <div>
                        <span className={labelCls}>Client ID</span>
                        <input
                          className={`${inputCls} ${monoCls}`}
                          placeholder="auto"
                          value={mqtt.clientId ?? ""}
                          disabled={!canEditSettings}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              mqtt: { ...mqtt, clientId: e.target.value || undefined },
                            })
                          }
                        />
                      </div>
                      <div>
                        <span className={labelCls}>Topic prefix</span>
                        <input
                          className={`${inputCls} ${monoCls}`}
                          value={mqtt.topicPrefix}
                          disabled={!canEditSettings}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              mqtt: { ...mqtt, topicPrefix: e.target.value },
                            })
                          }
                        />
                      </div>
                      <div>
                        <span className={labelCls}>QoS</span>
                        <select
                          className={inputCls}
                          value={mqtt.qos}
                          disabled={!canEditSettings}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              mqtt: {
                                ...mqtt,
                                qos: Number(e.target.value) as 0 | 1 | 2,
                              },
                            })
                          }
                        >
                          <option value={0}>0</option>
                          <option value={1}>1</option>
                          <option value={2}>2</option>
                        </select>
                      </div>
                    </div>
                  </>
                );
              })()}

              <span className={`${labelCls} mt-4`}>Home Assistant</span>
              <div className="text-[var(--color-foreground-muted)] text-xs">
                Forward camera device state to Home Assistant via MQTT discovery.
              </div>

              {(() => {
                const ha = settings.homeassistant ?? {
                  enabled: false,
                  discoveryPrefix: "homeassistant",
                  pollIntervalSeconds: 60,
                  stateTopicPrefix: "nodelink-js",
                };

                return (
                  <>
                    <div className="flex items-center gap-2.5 flex-wrap mt-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={ha.enabled}
                          disabled={!canEditSettings}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              homeassistant: { ...ha, enabled: e.target.checked },
                            })
                          }
                        />
                        <span>Enable Home Assistant MQTT discovery</span>
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-3 mt-2.5">
                      <div>
                        <span className={labelCls}>Discovery prefix</span>
                        <input
                          className={`${inputCls} ${monoCls}`}
                          value={ha.discoveryPrefix}
                          disabled={!canEditSettings}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              homeassistant: {
                                ...ha,
                                discoveryPrefix: e.target.value,
                              },
                            })
                          }
                        />
                      </div>
                      <div>
                        <span className={labelCls}>Poll interval (seconds)</span>
                        <input
                          className={inputCls}
                          type="number"
                          min={10}
                          max={3600}
                          value={ha.pollIntervalSeconds}
                          disabled={!canEditSettings}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              homeassistant: {
                                ...ha,
                                pollIntervalSeconds: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </div>
                      <div>
                        <span className={labelCls}>State topic prefix</span>
                        <input
                          className={`${inputCls} ${monoCls}`}
                          value={ha.stateTopicPrefix}
                          disabled={!canEditSettings}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              homeassistant: {
                                ...ha,
                                stateTopicPrefix: e.target.value,
                              },
                            })
                          }
                        />
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          ) : null}

          {/* WebRTC tab */}
          {activeTab === "webrtc" ? (
            <div className={cardCls}>
              <span className={labelCls}>WebRTC (ICE)</span>
              <div className="text-[var(--color-foreground-muted)] text-xs">
                Useful in Docker bridge mode. Configure the ICE UDP port range and
                the additional host IPs/hostnames to advertise.
              </div>

              {(() => {
                const webrtc = settings.webrtc ?? {
                  icePortRange: "",
                  iceAdditionalHostAddresses: "",
                };

                return (
                  <div className="grid grid-cols-2 gap-3 mt-2.5">
                    <div>
                      <span className={labelCls}>ICE UDP port range</span>
                      <input
                        className={`${inputCls} ${monoCls}`}
                        placeholder="10000-10100"
                        value={webrtc.icePortRange}
                        disabled={!canEditSettings}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            webrtc: {
                              ...webrtc,
                              icePortRange: e.target.value,
                            },
                          })
                        }
                      />
                    </div>

                    <div>
                      <span className={labelCls}>Additional host addresses (CSV)</span>
                      <input
                        className={`${inputCls} ${monoCls}`}
                        placeholder="192.168.1.10, my-ddns.example.com"
                        value={webrtc.iceAdditionalHostAddresses}
                        disabled={!canEditSettings}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            webrtc: {
                              ...webrtc,
                              iceAdditionalHostAddresses: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                  </div>
                );
              })()}
            </div>
          ) : null}

          {/* Restreamer tab */}
          {activeTab === "go2rtc" ? (
            <Tabs
              value={settings.restreamer ?? "go2rtc"}
              onValueChange={(next) =>
                setSettings({ ...settings, restreamer: next as "go2rtc" | "local" })
              }
            >
            {/* Restreamer selection */}
            <div className={cardCls}>
              <span className={labelCls}>Restreamer backend</span>
              <div className="text-[var(--color-foreground-muted)] text-xs mb-2">
                Pick which streaming stack serves camera streams.
                <br />
                <strong>go2rtc</strong> (default) starts the go2rtc sidecar and exposes RTSP, WebRTC, HLS, MJPEG, MSE.
                <br />
                <strong>local</strong> uses the library&apos;s built-in RTSP server directly. Only RTSP is available — WebRTC / HLS / MJPEG previews are disabled. Snapshots (CGI) keep working.
              </div>
              <TabsList className="border-b border-[var(--color-border)] gap-3">
                <TabsTrigger value="go2rtc">go2rtc (default)</TabsTrigger>
                <TabsTrigger value="local">local (RTSP only)</TabsTrigger>
              </TabsList>
              <TabsContent value="local">
                <div className="mt-3">
                  <span className={labelCls} style={{ fontSize: 12 }}>Local RTSP port</span>
                  <input
                    type="number"
                    value={settings.localRtsp?.port ?? 8554}
                    min={1}
                    max={65535}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        localRtsp: {
                          ...(settings.localRtsp ?? { port: 8554, bindHost: "0.0.0.0" }),
                          port: Number(e.target.value),
                        },
                      })
                    }
                    className={inputCls}
                    style={{ width: 140 }}
                  />
                  <div className="text-[var(--color-foreground-muted)] text-xs mt-1">
                    Each stream binds an independent port starting from this value. Restart the server after changing this setting.
                  </div>
                </div>
                <div className="mt-3 text-xs text-[var(--color-foreground-muted)]">
                  <strong>Authentication:</strong> when <em>Require auth for RTSP connections</em>
                  {" "}is enabled (Auth tab), RTSP clients authenticate with the
                  same <strong>dashboard users</strong> — no separate user
                  list. Digest auth uses pre-computed HA1 stored at password
                  set time; the server never holds plaintext passwords.
                </div>
              </TabsContent>
            </div>

            <TabsContent value="go2rtc">
            <div className={cardCls}>
              <span className={labelCls}>go2rtc Restreamer</span>
              <div className="text-[var(--color-foreground-muted)] text-xs">
                When enabled, camera streams are fed as raw video to go2rtc via TCP
                instead of running individual RTSP servers. go2rtc then provides
                WebRTC, HLS, MJPEG, and RTSP output automatically.
              </div>

              {(() => {
                const go2rtc = settings.go2rtc ?? {
                  enabled: true,
                  binaryPath: "go2rtc",
                  apiPort: 11984,
                  rtspPort: 18554,
                  webrtcPort: 18555,
                  iceServers: [],
                };

                const refreshStatus = async () => {
                  try {
                    const s = await trpcQuery("go2rtc.status");
                    setGo2rtcStatus(s as any);
                  } catch {
                    setGo2rtcStatus(null);
                  }
                };

                // Auto-refresh status when tab is active
                if (!go2rtcStatus && !go2rtcLoading) {
                  refreshStatus();
                }

                return (
                  <>
                    {go2rtcStatus && (
                      <div
                        className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg"
                        style={{
                          background: go2rtcStatus.running
                            ? "rgba(34,197,94,0.1)"
                            : "rgba(239,68,68,0.1)",
                        }}
                      >
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{
                            background: go2rtcStatus.running ? "#22c55e" : "#ef4444",
                          }}
                        />
                        <span className="flex-1 text-sm">
                          {go2rtcStatus.running
                            ? `Running — API: ${go2rtcStatus.apiUrl}`
                            : "Not running (startup failed — check logs)"}
                        </span>
                        <button
                          className={btnCls}
                          style={{ padding: "4px 12px", fontSize: 12 }}
                          onClick={refreshStatus}
                        >
                          Refresh
                        </button>
                        {go2rtcStatus.running && go2rtcStatus.apiUrl && (() => {
                          try {
                            const p = new URL(go2rtcStatus.apiUrl as string).port;
                            const host = settings?.serviceIp || window.location.hostname;
                            const href = `${window.location.protocol}//${host}:${p}/`;
                            return (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={btnCls}
                                style={{ padding: "4px 12px", fontSize: 12, textDecoration: "none" }}
                              >
                                Dashboard
                              </a>
                            );
                          } catch {
                            return null;
                          }
                        })()}
                      </div>
                    )}

                    {go2rtcStatus?.running &&
                      Object.keys(go2rtcStatus.streams).length > 0 && (
                        <div className="mb-3">
                          <span className={labelCls} style={{ fontSize: 12 }}>
                            Registered streams
                          </span>
                          <div
                            className={monoCls}
                            style={{
                              fontSize: 12,
                              background: "var(--color-surface)",
                              padding: "8px 10px",
                              borderRadius: 6,
                              maxHeight: 150,
                              overflow: "auto",
                            }}
                          >
                            {Object.keys(go2rtcStatus.streams).map((name) => (
                              <div key={name}>{name}</div>
                            ))}
                          </div>
                        </div>
                      )}

                    <div className="mt-3 grid grid-cols-3 gap-3">
                      {(
                        [
                          { label: "API port", key: "apiPort", def: 11984 },
                          { label: "RTSP port", key: "rtspPort", def: 18554 },
                          { label: "WebRTC port", key: "webrtcPort", def: 18555 },
                        ] as const
                      ).map(({ label, key, def }) => (
                        <div key={key}>
                          <span className={labelCls} style={{ fontSize: 12 }}>{label}</span>
                          <input
                            type="number"
                            value={go2rtc[key] ?? def}
                            min={1}
                            max={65535}
                            disabled={!canEditSettings}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                go2rtc: { ...go2rtc, [key]: Number(e.target.value) },
                              })
                            }
                            className={inputCls}
                            style={{ width: "100%" }}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="text-[var(--color-foreground-muted)] text-xs mt-1">
                      Port changes take effect after saving and restarting the server.
                    </div>

                    <div className="mt-2.5">
                      <span className={labelCls}>ICE servers (one per line)</span>
                      <textarea
                        className={`${inputCls} ${monoCls}`}
                        rows={3}
                        placeholder={"stun:stun.l.google.com:19302"}
                        value={(go2rtc.iceServers ?? []).join("\n")}
                        disabled={!canEditSettings}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            go2rtc: {
                              ...go2rtc,
                              iceServers: e.target.value
                                .split("\n")
                                .map((s) => s.trim())
                                .filter(Boolean),
                            },
                          })
                        }
                        style={{ resize: "vertical" }}
                      />
                    </div>

                  </>
                );
              })()}
            </div>
            </TabsContent>
            </Tabs>
          ) : null}

          {/* Frigate tab */}
          {activeTab === "frigate" ? (
            <div className={cardCls}>
              <span className={labelCls}>Frigate Integration</span>
              <div className="text-[var(--color-foreground-muted)] text-xs mb-3">
                Connect to a Frigate instance to push camera configurations directly.
                Streams are auto-assigned to detect/record/audio based on resolution.
              </div>

              {(() => {
                const fg = settings.frigate ?? {
                  host: "",
                  username: "",
                  password: "",
                };

                // All cameras (not just connected — disconnected cameras can still
                // be configured in Frigate so they start recording once online).
                const allCameras = frigateCameraList;

                // Connection params from the form (not yet saved)
                const fgConn = {
                  host: fg.host,
                  username: fg.username,
                  password: fg.password,
                };

                const applyToFrigate = async (restart: boolean) => {
                  if (!frigateSelectedId || !frigatePreview?.cameras?.length) return;
                  setFrigateApplying(true);
                  setFrigateMessage(null);
                  try {
                    // Build camera blocks from the preview YAML (user-configured)
                    const cameras: Record<string, string> = {};
                    const go2rtcStreams: Record<string, string> = {};
                    for (const cam of frigatePreview.cameras as any[]) {
                      if (!cam.yaml || !cam.frigateName) continue;
                      cameras[cam.frigateName] = cam.yaml;
                      // If using Frigate go2rtc restream, include go2rtc stream defs
                      if (cam._useFrigateGo2rtc && cam.streamInfo) {
                        for (const s of cam.streamInfo as any[]) {
                          if (s.go2rtcName && s.rtspUrl) {
                            go2rtcStreams[s.go2rtcName] = s.rtspUrl;
                          }
                        }
                      }
                    }

                    // Collect old names to remove when a camera was renamed
                    const removeNames: string[] = [];
                    for (const cam of frigatePreview.cameras as any[]) {
                      if (cam._originalFrigateName && cam.frigateName !== cam._originalFrigateName) {
                        removeNames.push(cam._originalFrigateName);
                      }
                    }

                    console.log("[Frigate apply]", { cameras: Object.keys(cameras), removeNames, go2rtcStreams: Object.keys(go2rtcStreams) });
                    const res = await trpcMutation("frigate.apply", {
                      ...fgConn,
                      cameras,
                      go2rtcStreams,
                      removeNames,
                      restart,
                    });
                    if ((res as any).success) {
                      setFrigateMessage(
                        restart
                          ? "Config saved and Frigate restarting!"
                          : "Config saved to Frigate.",
                      );
                      // Refresh match data + existing cameras
                      const [cams, md] = await Promise.all([
                        trpcQuery<string[]>("frigate.getCameras", fgConn).catch(() => []),
                        trpcQuery<any>("frigate.match", fgConn).catch(() => null),
                      ]);
                      setFrigateExistingCameras(cams);
                      if (md) setFrigateMatchData(md);
                      setFrigatePreview(null);
                    } else {
                      setFrigateMessage(`Error: ${(res as any).error ?? "Unknown"}`);
                    }
                  } catch (e) {
                    setFrigateMessage(`Apply error: ${e}`);
                  } finally {
                    setFrigateApplying(false);
                  }
                };

                const loadPreviewForIds = async (ids: string[]) => {
                  if (ids.length === 0) {
                    setFrigatePreview(null);
                    return;
                  }
                  setFrigateLoading(true);
                  try {
                    const res = await trpcQuery<any>("frigate.preview", {
                      cameraIds: ids,
                    });
                    // Enrich with client-side data: alreadyInFrigate + auto-select hwaccel
                    if (res?.cameras) {
                      for (const cam of res.cameras as any[]) {
                        // Mark if already exists in Frigate (from cached data)
                        cam.alreadyInFrigate = frigateExistingCameras.includes(cam.frigateName);
                        // Track original name so we can remove the old entry on rename
                        cam._originalFrigateName = cam.frigateName;
                        // Auto-select hwaccel based on Frigate's system hwaccel family + stream codec
                        if (frigateSystemInfo?.hwaccelFamily && cam.streamInfo) {
                          for (const s of cam.streamInfo as any[]) {
                            if (s._hwaccelArgs) continue; // don't override user choice
                            const codec = (s.codec ?? "").toLowerCase().replace(/\./g, "");
                            const isH265 = codec.includes("h265") || codec.includes("hevc");
                            const family = frigateSystemInfo.hwaccelFamily;
                            s._hwaccelArgs = `preset-${family}-${isH265 ? "h265" : "h264"}`;
                          }
                        }
                      }

                      // Rebuild YAML with enriched data (hwaccel, inputArgs, defaults)
                      for (const cam of res.cameras as any[]) {
                        if (cam._manualEdit) continue;
                        const si = cam.streamInfo ?? [];
                        cam.yaml = buildFrigateYaml(si, cam.frigateName, {
                          useFrigateGo2rtc: cam._useFrigateGo2rtc === true,
                          recordEnabled: cam._recordEnabled !== false,
                          detectEnabled: cam._detectEnabled !== false,
                          snapshotsEnabled: cam._snapshotsEnabled !== false,
                          audioEnabled: cam._audioEnabled !== false,
                        });
                      }
                    }
                    setFrigatePreview(res);
                  } catch {
                    // ignore
                  } finally {
                    setFrigateLoading(false);
                  }
                };

                const selectCamera = (id: string) => {
                  setFrigateSelectedId(id);
                  // Clear previous preview immediately to avoid mixing
                  setFrigatePreview(null);
                  if (id) {
                    void loadPreviewForIds([id]);
                  }
                };

                return (
                  <>
                    {/* Connection settings */}
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <div style={{ gridColumn: "1 / -1" }}>
                        <span className={labelCls}>Frigate URL</span>
                        <input
                          className={`${inputCls} ${monoCls}`}
                          placeholder="http://192.168.1.100:5000"
                          value={fg.host}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              frigate: { ...fg, host: e.target.value },
                            })
                          }
                        />
                      </div>
                      <div>
                        <span className={labelCls}>Username (optional)</span>
                        <input
                          className={inputCls}
                          placeholder="admin"
                          value={fg.username}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              frigate: { ...fg, username: e.target.value },
                            })
                          }
                        />
                      </div>
                      <div>
                        <span className={labelCls}>Password (optional)</span>
                        <input
                          className={inputCls}
                          type="password"
                          value={fg.password}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              frigate: { ...fg, password: e.target.value },
                            })
                          }
                        />
                      </div>
                    </div>

                    {/* Connection status + refresh */}
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      {frigateConnected && (
                        <span
                          className="text-xs"
                          style={{ color: frigateConnected.ok ? "#22c55e" : "#ef4444" }}
                        >
                          {frigateConnected.ok
                            ? `Connected (Frigate ${frigateConnected.version})${frigateSystemInfo?.hwaccelFamily ? ` · hwaccel: ${frigateSystemInfo.hwaccelFamily}` : ""}`
                            : `Error: ${frigateConnected.error}`}
                        </span>
                      )}
                      {frigateLoading && !frigateConnected && (
                        <span className="text-xs text-[var(--color-foreground-muted)]">Connecting...</span>
                      )}
                      {frigateConnected?.ok && (
                        <button
                          className={btnCls}
                          style={{ padding: "2px 8px", fontSize: 10, marginLeft: "auto" }}
                          disabled={frigateLoading}
                          onClick={() => {
                            setFrigateConnected(null);
                            void connectToFrigate();
                          }}
                        >
                          {frigateLoading ? "Refreshing..." : "Refresh"}
                        </button>
                      )}
                    </div>

                    {/* Existing Frigate cameras — split into managed (matched) and other */}
                    {frigateMatchData?.cameras?.length > 0 && (() => {
                      const allFc = frigateMatchData.cameras as any[];
                      const managed = allFc.filter((fc: any) => fc.matchedNodelinkCamera);
                      const other = allFc.filter((fc: any) => !fc.matchedNodelinkCamera);

                      const renderRow = (fc: any) => (
                        <div
                          key={fc.frigateName}
                          className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-[var(--color-border)] text-xs"
                          style={{
                            background: frigateRemoveNames.has(fc.frigateName)
                              ? "rgba(239,68,68,0.06)"
                              : "transparent",
                          }}
                        >
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{
                              background: fc.frigateEnabled ? "#22c55e" : "#6b7280",
                            }}
                          />
                          <strong className="min-w-[120px]">{fc.frigateName}</strong>
                          {fc.matchedNodelinkCamera ? (
                            <span className="text-[var(--color-foreground-muted)]" style={{ fontSize: 11 }}>
                              → {fc.matchedNodelinkCamera.name}
                            </span>
                          ) : (
                            <span className="text-[var(--color-foreground-muted)]" style={{ fontSize: 11 }}>
                              (unmanaged)
                            </span>
                          )}
                          <span className="ml-auto flex gap-1">
                            {fc.matchedNodelinkCamera && (
                              <button
                                className={btnCls}
                                style={{ padding: "2px 8px", fontSize: 10 }}
                                onClick={async () => {
                                  // Load the EXISTING Frigate config for this camera
                                  const camId = fc.matchedNodelinkCamera.id;
                                  // Clear current preview + dropdown to avoid mixing
                                  setFrigatePreview(null);
                                  setFrigateSelectedId(camId);
                                  setFrigateLoading(true);
                                  setFrigateMessage(null);
                                  try {
                                    const existing = await trpcQuery<{
                                      found: boolean;
                                      yaml: string;
                                      block: any;
                                    }>("frigate.getCameraYaml", {
                                      ...fgConn,
                                      cameraName: fc.frigateName,
                                    });
                                    if (existing.found) {
                                      // Load fresh preview from API for this camera
                                      // (gives us streamInfo with codec/resolution),
                                      // then overlay the existing YAML for manual editing
                                      let preview: any = null;
                                      try {
                                        preview = await trpcQuery<any>("frigate.preview", {
                                          cameraIds: [camId],
                                        });
                                      } catch { /* ignore */ }

                                      const baseCam = preview?.cameras?.[0] ?? {
                                        cameraId: camId,
                                        cameraName: fc.matchedNodelinkCamera.name,
                                        frigateName: fc.frigateName,
                                        streams: [],
                                        streamInfo: [],
                                        go2rtcStreams: {},
                                        go2rtcYaml: "",
                                      };

                                      setFrigatePreview({
                                        cameras: [{
                                          ...baseCam,
                                          frigateName: fc.frigateName,
                                          _originalFrigateName: fc.frigateName,
                                          alreadyInFrigate: true,
                                          yaml: existing.yaml,
                                          _manualEdit: true,
                                        }],
                                        presets: preview?.presets ?? {
                                          inputArgs: [
                                            "preset-rtsp-generic",
                                            "preset-rtsp-restream",
                                            "preset-rtsp-udp",
                                            "preset-rtsp-blue-iris",
                                          ],
                                          hwaccelArgs: [
                                            "",
                                            "preset-intel-qsv-h264",
                                            "preset-intel-qsv-h265",
                                            "preset-nvidia-h264",
                                            "preset-nvidia-h265",
                                            "preset-vaapi",
                                            "preset-rpi-64-h264",
                                            "preset-rpi-64-h265",
                                          ],
                                        },
                                      });
                                    } else {
                                      setFrigateMessage(`Camera ${fc.frigateName} not found in Frigate config`);
                                    }
                                  } catch (e) {
                                    setFrigateMessage(`Error loading camera: ${e}`);
                                  } finally {
                                    setFrigateLoading(false);
                                  }
                                }}
                              >
                                Edit
                              </button>
                            )}
                            <button
                              className={frigateRemoveNames.has(fc.frigateName) ? btnPrimaryCls : btnCls}
                              style={{ padding: "2px 8px", fontSize: 10 }}
                              onClick={() => {
                                setFrigateRemoveNames((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(fc.frigateName)) next.delete(fc.frigateName);
                                  else next.add(fc.frigateName);
                                  return next;
                                });
                              }}
                            >
                              {frigateRemoveNames.has(fc.frigateName) ? "Keep" : "Remove"}
                            </button>
                          </span>
                        </div>
                      );

                      return (
                        <div className="border-t border-[var(--color-border)] pt-3 mt-1 mb-3">
                          {managed.length > 0 && (
                            <div className="mb-3">
                              <span className={labelCls}>Managed cameras (imported from Nodelink)</span>
                              <div className="flex flex-col gap-1 mt-1.5">
                                {managed.map(renderRow)}
                              </div>
                            </div>
                          )}
                          {other.length > 0 && (
                            <div>
                              <span className={labelCls}>Other Frigate cameras</span>
                              <div className="flex flex-col gap-1 mt-1.5">
                                {other.map(renderRow)}
                              </div>
                            </div>
                          )}

                          {frigateRemoveNames.size > 0 && (
                            <div className="flex items-center gap-2 flex-wrap mt-2.5">
                              <button
                                className={btnCls}
                                style={{ fontSize: 11, color: "#ef4444" }}
                                disabled={frigateApplying}
                                onClick={async () => {
                                  setFrigateApplying(true);
                                  setFrigateMessage(null);
                                  try {
                                    const res = await trpcMutation("frigate.removeCameras", {
                                      ...fgConn,
                                      cameraNames: Array.from(frigateRemoveNames),
                                      restart: false,
                                    });
                                    if ((res as any).success) {
                                      setFrigateMessage(`Removed ${frigateRemoveNames.size} camera(s).`);
                                      setFrigateRemoveNames(new Set());
                                      const md = await trpcQuery<any>("frigate.match", fgConn).catch(() => null);
                                      if (md) setFrigateMatchData(md);
                                      const cams = await trpcQuery<string[]>("frigate.getCameras", fgConn).catch(() => []);
                                      setFrigateExistingCameras(cams);
                                    } else {
                                      setFrigateMessage(`Error: ${(res as any).error}`);
                                    }
                                  } catch (e) {
                                    setFrigateMessage(`Remove error: ${e}`);
                                  } finally {
                                    setFrigateApplying(false);
                                  }
                                }}
                              >
                                {frigateApplying ? "Removing..." : `Remove ${frigateRemoveNames.size} camera(s) + Save`}
                              </button>
                              <button
                                className={btnCls}
                                style={{ fontSize: 11, color: "#ef4444" }}
                                disabled={frigateApplying}
                                onClick={async () => {
                                  setFrigateApplying(true);
                                  setFrigateMessage(null);
                                  try {
                                    const res = await trpcMutation("frigate.removeCameras", {
                                      ...fgConn,
                                      cameraNames: Array.from(frigateRemoveNames),
                                      restart: true,
                                    });
                                    if ((res as any).success) {
                                      setFrigateMessage(`Removed ${frigateRemoveNames.size} camera(s), Frigate restarting.`);
                                      setFrigateRemoveNames(new Set());
                                    } else {
                                      setFrigateMessage(`Error: ${(res as any).error}`);
                                    }
                                  } catch (e) {
                                    setFrigateMessage(`Remove error: ${e}`);
                                  } finally {
                                    setFrigateApplying(false);
                                  }
                                }}
                              >
                                {frigateApplying ? "Removing..." : `Remove + Restart Frigate`}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Camera selection */}
                    {frigateConnected?.ok && (
                      <>
                        <div className="border-t border-[var(--color-border)] pt-3 mt-1">
                          <span className={labelCls}>Camera</span>
                          <div className="text-[var(--color-foreground-muted)] mb-1" style={{ fontSize: 11 }}>
                            Select a camera to configure and push to Frigate
                          </div>
                          <select
                            className={inputCls}
                            value={frigateSelectedId}
                            onChange={(e) => selectCamera(e.target.value)}
                          >
                            <option value="">— Select a camera —</option>
                            {allCameras.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}{c.status !== "connected" ? ` (${c.status})` : ""}
                              </option>
                            ))}
                          </select>
                        </div>

                        {frigatePreview?.cameras && (
                          <div className="mt-3">
                            {(frigatePreview.cameras as any[]).map((c: any, idx: number) => {
                              const isManualEdit = c._manualEdit === true;
                              const streamInfoList: any[] = c.streamInfo ?? c.streams ?? [];

                              const rebuildYaml = buildFrigateYaml;

                              const updateCam = (patch: any) => {
                                const updated = [...frigatePreview.cameras];
                                const merged = { ...c, ...patch };
                                // Auto-rebuild YAML when not in manual edit mode
                                if (!merged._manualEdit) {
                                  const si = merged.streamInfo ?? streamInfoList;
                                  merged.yaml = rebuildYaml(si, merged.frigateName, {
                                    useFrigateGo2rtc: merged._useFrigateGo2rtc === true,
                                    recordEnabled: merged._recordEnabled !== false,
                                    detectEnabled: merged._detectEnabled !== false,
                                    snapshotsEnabled: merged._snapshotsEnabled !== false,
                                    audioEnabled: merged._audioEnabled !== false,
                                  });
                                }
                                updated[idx] = merged;
                                setFrigatePreview({ ...frigatePreview, cameras: updated });
                              };

                              const updateStreamRole = (sIdx: number, role: string, checked: boolean) => {
                                const si = [...streamInfoList];
                                const cur = si[sIdx]!;
                                const roles = [...(cur.roles ?? [])];
                                if (checked && !roles.includes(role)) roles.push(role);
                                if (!checked) {
                                  const i = roles.indexOf(role);
                                  if (i >= 0) roles.splice(i, 1);
                                }
                                si[sIdx] = { ...cur, roles };
                                updateCam({ streamInfo: si });
                              };

                              const updateStreamPreset = (sIdx: number, key: string, val: string) => {
                                const si = [...streamInfoList];
                                si[sIdx] = { ...si[sIdx]!, [key]: val };
                                updateCam({ streamInfo: si });
                              };

                              return (
                                <div
                                  key={c.cameraId}
                                  className="mb-4 border border-[var(--color-border)] rounded-lg overflow-hidden"
                                >
                                  {/* Header */}
                                  <div
                                    className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)]"
                                    style={{ background: "var(--color-surface)" }}
                                  >
                                    <strong style={{ fontSize: 13 }}>{c.cameraName}</strong>
                                    <span className="text-[var(--color-foreground-muted)] text-xs">→</span>
                                    <input
                                      className={inputCls}
                                      value={c.frigateName}
                                      onChange={(e) => {
                                        const raw = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_{2,}/g, "_");
                                        updateCam({ frigateName: raw });
                                      }}
                                      style={{ fontSize: 12, padding: "2px 6px", width: 160 }}
                                    />
                                    {c.alreadyInFrigate && (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}>
                                        update
                                      </span>
                                    )}
                                    <label className="ml-auto flex items-center gap-1 cursor-pointer" style={{ fontSize: 11 }}>
                                      <input
                                        type="checkbox"
                                        checked={isManualEdit}
                                        onChange={(e) => updateCam({ _manualEdit: e.target.checked })}
                                      />
                                      Manual edit
                                    </label>
                                  </div>

                                  {isManualEdit ? (
                                    /* Manual YAML editor — full control */
                                    <textarea
                                      className={`${inputCls} ${monoCls}`}
                                      value={c.yaml}
                                      onChange={(e) => updateCam({ yaml: e.target.value })}
                                      rows={Math.max(8, c.yaml.split("\n").length)}
                                      style={{
                                        width: "100%", border: "none", borderRadius: 0, resize: "vertical",
                                        fontSize: 11, lineHeight: 1.5,
                                        whiteSpace: "pre", tabSize: 2, padding: "8px 12px", background: "var(--color-background)",
                                      }}
                                      spellCheck={false}
                                    />
                                  ) : (
                                    <>
                                      {/* Stream table with role assignment */}
                                      <div className="px-3 py-2">
                                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                                          <thead>
                                            <tr className="text-[var(--color-foreground-muted)] text-left">
                                              <th style={{ padding: "3px 6px" }}>Profile</th>
                                              <th style={{ padding: "3px 6px" }}>Codec</th>
                                              <th style={{ padding: "3px 6px" }}>Resolution</th>
                                              <th style={{ padding: "3px 6px", textAlign: "center" }}>record</th>
                                              <th style={{ padding: "3px 6px", textAlign: "center" }}>detect</th>
                                              <th style={{ padding: "3px 6px", textAlign: "center" }}>audio</th>
                                              <th style={{ padding: "3px 6px" }}>input_args</th>
                                              <th style={{ padding: "3px 6px" }}>hwaccel_args</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {streamInfoList.map((s: any, sIdx: number) => (
                                              <tr key={s.go2rtcName || sIdx} className="border-t border-[var(--color-border)]">
                                                <td style={{ padding: "4px 6px", fontWeight: 600 }}>{s.profile}</td>
                                                <td style={{ padding: "4px 6px" }}>
                                                  {s.codec ? (
                                                    <span style={{
                                                      padding: "1px 4px", borderRadius: 3, fontSize: 10,
                                                      background: (s.codec ?? "").toLowerCase().includes("h265") || (s.codec ?? "").toLowerCase().includes("hevc")
                                                        ? "rgba(168,85,247,0.15)" : "rgba(59,130,246,0.15)",
                                                      color: (s.codec ?? "").toLowerCase().includes("h265") || (s.codec ?? "").toLowerCase().includes("hevc")
                                                        ? "#a855f7" : "#3b82f6",
                                                    }}>{s.codec}</span>
                                                  ) : <span className="text-[var(--color-foreground-muted)]">—</span>}
                                                </td>
                                                <td className={monoCls} style={{ padding: "4px 6px", fontSize: 10 }}>{s.resolution || "—"}</td>
                                                {["record", "detect", "audio"].map((role) => (
                                                  <td key={role} style={{ padding: "4px 6px", textAlign: "center" }}>
                                                    <input
                                                      type="checkbox"
                                                      checked={(s.roles ?? []).includes(role)}
                                                      onChange={(e) => updateStreamRole(sIdx, role, e.target.checked)}
                                                    />
                                                  </td>
                                                ))}
                                                <td style={{ padding: "4px 4px" }}>
                                                  <select
                                                    className={inputCls}
                                                    style={{ fontSize: 10, padding: "2px 4px", width: "100%" }}
                                                    value={s._inputArgs ?? "preset-rtsp-restream"}
                                                    onChange={(e) => updateStreamPreset(sIdx, "_inputArgs", e.target.value)}
                                                  >
                                                    {(frigatePreview.presets?.inputArgs ?? []).map((p: string) => (
                                                      <option key={p} value={p}>{p.replace("preset-", "")}</option>
                                                    ))}
                                                  </select>
                                                </td>
                                                <td style={{ padding: "4px 4px" }}>
                                                  <select
                                                    className={inputCls}
                                                    style={{ fontSize: 10, padding: "2px 4px", width: "100%" }}
                                                    value={s._hwaccelArgs ?? ""}
                                                    onChange={(e) => updateStreamPreset(sIdx, "_hwaccelArgs", e.target.value)}
                                                  >
                                                    {(frigatePreview.presets?.hwaccelArgs ?? []).map((p: string) => (
                                                      <option key={p} value={p}>{p ? p.replace("preset-", "") : "(none)"}</option>
                                                    ))}
                                                  </select>
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>

                                      {/* Feature toggles */}
                                      <div className="flex flex-wrap gap-3 px-3 py-2 border-t border-[var(--color-border)]">
                                        <label className="flex items-center gap-1 cursor-pointer" style={{ fontSize: 11 }}>
                                          <input
                                            type="checkbox"
                                            checked={c._recordEnabled !== false}
                                            onChange={(e) => updateCam({ _recordEnabled: e.target.checked })}
                                          />
                                          Record
                                        </label>
                                        <label className="flex items-center gap-1 cursor-pointer" style={{ fontSize: 11 }}>
                                          <input
                                            type="checkbox"
                                            checked={c._detectEnabled !== false}
                                            onChange={(e) => updateCam({ _detectEnabled: e.target.checked })}
                                          />
                                          Detect
                                        </label>
                                        <label className="flex items-center gap-1 cursor-pointer" style={{ fontSize: 11 }}>
                                          <input
                                            type="checkbox"
                                            checked={c._snapshotsEnabled !== false}
                                            onChange={(e) => updateCam({ _snapshotsEnabled: e.target.checked })}
                                          />
                                          Snapshots
                                        </label>
                                        <label className="flex items-center gap-1 cursor-pointer" style={{ fontSize: 11 }}>
                                          <input
                                            type="checkbox"
                                            checked={c._audioEnabled !== false}
                                            onChange={(e) => updateCam({ _audioEnabled: e.target.checked })}
                                          />
                                          Audio
                                        </label>
                                        <label className="flex items-center gap-1 cursor-pointer" style={{ fontSize: 11 }}>
                                          <input
                                            type="checkbox"
                                            checked={c._useFrigateGo2rtc === true}
                                            onChange={(e) => updateCam({ _useFrigateGo2rtc: e.target.checked })}
                                          />
                                          Frigate go2rtc restream
                                        </label>
                                      </div>

                                      {/* Readonly YAML preview */}
                                      <textarea
                                        className={`${inputCls} ${monoCls}`}
                                        value={c.yaml}
                                        readOnly
                                        rows={Math.max(4, c.yaml.split("\n").length)}
                                        style={{
                                          width: "100%", border: "none", borderRadius: 0, resize: "none",
                                          fontSize: 10, lineHeight: 1.4,
                                          whiteSpace: "pre", tabSize: 2, padding: "6px 12px",
                                          background: "var(--color-surface)", color: "var(--color-foreground-muted)",
                                        }}
                                        spellCheck={false}
                                      />
                                    </>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Action buttons */}
                        {frigatePreview?.cameras?.length > 0 && (
                          <div className="flex items-center gap-2 flex-wrap mt-3">
                            <button
                              className={btnPrimaryCls}
                              disabled={frigateApplying}
                              onClick={() => applyToFrigate(false)}
                            >
                              {frigateApplying ? "Saving..." : "Save to Frigate"}
                            </button>
                            <button
                              className={btnPrimaryCls}
                              disabled={frigateApplying}
                              onClick={() => applyToFrigate(true)}
                            >
                              {frigateApplying ? "Saving..." : "Save + Restart Frigate"}
                            </button>
                          </div>
                        )}

                        {/* Status message */}
                        {frigateMessage && (
                          <div
                            className="mt-2.5 px-3 py-2 rounded-md text-xs"
                            style={{
                              background: frigateMessage.startsWith("Error")
                                ? "rgba(239,68,68,0.1)"
                                : "rgba(34,197,94,0.1)",
                              color: frigateMessage.startsWith("Error")
                                ? "#ef4444"
                                : "#22c55e",
                            }}
                          >
                            {frigateMessage}
                          </div>
                        )}
                      </>
                    )}

                    {/* Config backups */}
                    {frigateConnected?.ok && frigateBackups.length > 0 && (
                      <div className="border-t border-[var(--color-border)] pt-3 mt-3">
                        <span
                          className={`${labelCls} cursor-pointer select-none`}
                          onClick={() => setFrigateBackupsOpen(!frigateBackupsOpen)}
                        >
                          Config Backups ({frigateBackups.length}) {frigateBackupsOpen ? "▾" : "▸"}
                        </span>
                        {frigateBackupsOpen && (
                          <div className="mt-1.5 flex flex-col gap-1">
                            {frigateBackups.map((b) => (
                              <div
                                key={b.id}
                                className="flex items-center gap-2 px-2 py-1 rounded-md border border-[var(--color-border)] text-xs"
                              >
                                <span className="text-[var(--color-foreground-muted)] min-w-[140px]">
                                  {new Date(b.timestamp).toLocaleString()}
                                </span>
                                <span className="flex-1">{b.summary}</span>
                                <button
                                  className={btnCls}
                                  style={{ padding: "1px 8px", fontSize: 10 }}
                                  disabled={frigateApplying}
                                  onClick={async () => {
                                    if (!confirm(`Rollback to backup from ${new Date(b.timestamp).toLocaleString()}?`)) return;
                                    setFrigateApplying(true);
                                    setFrigateMessage(null);
                                    try {
                                      const res = await trpcMutation("frigate.rollback", {
                                        ...fgConn,
                                        backupId: b.id,
                                        restart: true,
                                      });
                                      if ((res as any).success) {
                                        setFrigateMessage("Rollback applied and Frigate restarting.");
                                        // Refresh
                                        setFrigateConnected(null);
                                        void connectToFrigate();
                                      } else {
                                        setFrigateMessage(`Rollback error: ${(res as any).error ?? "Unknown"}`);
                                      }
                                    } catch (e) {
                                      setFrigateMessage(`Rollback error: ${e}`);
                                    } finally {
                                      setFrigateApplying(false);
                                    }
                                  }}
                                >
                                  Rollback
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          ) : null}

          {/* Proxy tab */}
          {activeTab === "proxy" ? (
            <div className={cardCls}>
              <span className={labelCls}>Trusted proxy (Authentik / NPM)</span>
              <div className="text-[var(--color-foreground-muted)] text-xs">
                Enable header-based authentication when running behind a trusted
                reverse proxy (e.g. Nginx Proxy Manager + Authentik).
              </div>

              {!isAuthEnabled ? (
                <div className="mt-2.5 text-[var(--color-foreground-muted)] text-sm">
                  Auth is disabled. Set{" "}
                  <span className={monoCls}>AUTH_ENABLED=1</span>
                  (and <span className={monoCls}>ADMIN_PASSWORD</span>) to secure the
                  dashboard.
                </div>
              ) : (
                (() => {
                  const tp = settings.auth?.trustedProxy ?? {
                    enabled: false,
                    allowedIps: ["127.0.0.1", "::1"],
                    usernameHeader: "x-authentik-username",
                    groupsHeader: "x-authentik-groups",
                    adminGroup: "admin",
                  };

                  return (
                    <>
                      <div className="flex items-center gap-2.5 flex-wrap mt-3">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={tp.enabled}
                            disabled={!canEditSettings}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                auth: {
                                  ...settings.auth,
                                  trustedProxy: {
                                    ...tp,
                                    enabled: e.target.checked,
                                  },
                                },
                              })
                            }
                          />
                          <span>Enable trusted proxy auth</span>
                        </label>
                      </div>

                      <div className="grid grid-cols-2 gap-3 mt-2.5">
                        <div style={{ gridColumn: "1 / -1" }}>
                          <span className={labelCls}>Allowed proxy IPs (CSV)</span>
                          <input
                            className={`${inputCls} ${monoCls}`}
                            placeholder="127.0.0.1, ::1"
                            value={tp.allowedIps.join(", ")}
                            disabled={!canEditSettings}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                auth: {
                                  ...settings.auth,
                                  trustedProxy: {
                                    ...tp,
                                    allowedIps: e.target.value
                                      .split(",")
                                      .map((s) => s.trim())
                                      .filter(Boolean),
                                  },
                                },
                              })
                            }
                          />
                          <div className="text-[var(--color-foreground-muted)] text-xs mt-1.5">
                            Must match the IP of your reverse proxy as seen by the
                            app (often the Docker bridge IP or the host).
                          </div>
                        </div>

                        <div>
                          <span className={labelCls}>Username header</span>
                          <input
                            className={`${inputCls} ${monoCls}`}
                            value={tp.usernameHeader}
                            disabled={!canEditSettings}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                auth: {
                                  ...settings.auth,
                                  trustedProxy: {
                                    ...tp,
                                    usernameHeader: e.target.value,
                                  },
                                },
                              })
                            }
                          />
                        </div>

                        <div>
                          <span className={labelCls}>Groups header</span>
                          <input
                            className={`${inputCls} ${monoCls}`}
                            value={tp.groupsHeader}
                            disabled={!canEditSettings}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                auth: {
                                  ...settings.auth,
                                  trustedProxy: {
                                    ...tp,
                                    groupsHeader: e.target.value,
                                  },
                                },
                              })
                            }
                          />
                        </div>

                        <div style={{ gridColumn: "1 / -1" }}>
                          <span className={labelCls}>Admin group name</span>
                          <input
                            className={inputCls}
                            value={tp.adminGroup}
                            disabled={!canEditSettings}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                auth: {
                                  ...settings.auth,
                                  trustedProxy: {
                                    ...tp,
                                    adminGroup: e.target.value,
                                  },
                                },
                              })
                            }
                          />
                        </div>
                      </div>
                    </>
                  );
                })()
              )}
            </div>
          ) : null}

          {/* Metrics tab */}
          {activeTab === "email-push" ? (
            <EmailPushSettingsSection />
          ) : null}

          {activeTab === "metrics" ? (
            <div className={cardCls}>
              <span className={labelCls}>Resource usage</span>
              {!canViewMetrics ? (
                <div className="text-[var(--color-foreground-muted)] text-xs">
                  Only admins can view metrics.
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2.5 flex-wrap mt-2.5">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={metricsAutoRefresh}
                        onChange={(e) => setMetricsAutoRefresh(e.target.checked)}
                      />
                      <span>Auto refresh</span>
                    </label>

                    <div className="flex-1" />

                    <button
                      className={btnCls}
                      disabled={metricsLoading}
                      onClick={() => void fetchMetricsOnce()}
                    >
                      {metricsLoading ? "Refreshing…" : "Refresh"}
                    </button>
                  </div>

                  {!metrics ? (
                    <div className="text-[var(--color-foreground-muted)] text-xs mt-2.5">
                      {metricsError ? `Error: ${metricsError}` : "No data yet."}
                    </div>
                  ) : null}

                  {metrics ? (
                    <div className="grid grid-cols-2 gap-3 mt-2.5">
                      <div>
                        <span className={labelCls}>Uptime</span>
                        <input
                          className={inputCls}
                          readOnly
                          value={formatSeconds(metrics.process.uptimeSeconds)}
                        />
                      </div>
                      <div>
                        <span className={labelCls}>CPU</span>
                        <input
                          className={inputCls}
                          readOnly
                          value={
                            metrics.process.cpu.percent === null
                              ? "(warming up…)"
                              : `${metrics.process.cpu.percent.toFixed(1)}%`
                          }
                        />
                      </div>

                      <div>
                        <span className={labelCls}>RSS</span>
                        <input
                          className={inputCls}
                          readOnly
                          value={formatBytes(metrics.process.memory.rss)}
                        />
                      </div>
                      <div>
                        <span className={labelCls}>Heap used</span>
                        <input
                          className={inputCls}
                          readOnly
                          value={`${formatBytes(metrics.process.memory.heapUsed)} / ${formatBytes(metrics.process.memory.heapTotal)}`}
                        />
                      </div>

                      <div>
                        <span className={labelCls}>Event loop utilization</span>
                        <input
                          className={inputCls}
                          readOnly
                          value={`${(metrics.process.eventLoop.utilization * 100).toFixed(1)}%`}
                        />
                      </div>
                      <div>
                        <span className={labelCls}>Host memory</span>
                        <input
                          className={inputCls}
                          readOnly
                          value={`${formatBytes(metrics.system.totalMem - metrics.system.freeMem)} / ${formatBytes(metrics.system.totalMem)}`}
                        />
                      </div>

                      <div>
                        <span className={labelCls}>Load avg</span>
                        <input
                          className={inputCls}
                          readOnly
                          value={metrics.system.loadAvg
                            .slice(0, 3)
                            .map((n) => n.toFixed(2))
                            .join(" ")}
                        />
                      </div>
                      <div>
                        <span className={labelCls}>Node</span>
                        <input
                          className={`${inputCls} ${monoCls}`}
                          readOnly
                          value={`${metrics.process.nodeVersion} (pid ${metrics.process.pid})`}
                        />
                      </div>

                      <div style={{ gridColumn: "1 / -1" }}>
                        <div className="text-[var(--color-foreground-muted)] text-xs">
                          Updated: {new Date(metrics.timestamp).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </>
      )}

      {/* Add dashboard user modal */}
      {addDashUserOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 p-4 grid place-items-center bg-black/[.66] backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setAddDashUserOpen(false);
          }}
        >
          <div
            className="border border-[var(--color-border)] bg-[var(--color-background-elevated)] text-[var(--color-foreground)] rounded-xl p-4 shadow-2xl"
            style={{ width: "min(720px, 100%)" }}
          >
            <div className="flex items-center justify-between gap-2.5">
              <div>
                <div className="font-extrabold">Add dashboard user</div>
                <div className="text-xs text-[var(--color-foreground-muted)] mt-0.5">
                  User/password used to access the web dashboard.
                  The same credentials authenticate RTSP clients when
                  Require RTSP auth is enabled — no separate user list.
                </div>
              </div>
              <button className={btnCls} onClick={() => setAddDashUserOpen(false)}>
                Close
              </button>
            </div>

            <div className="grid gap-3 mt-2.5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className={labelCls}>Username</span>
                  <input
                    className={inputCls}
                    value={dashUserDraft.username}
                    onChange={(e) =>
                      setDashUserDraft({
                        ...dashUserDraft,
                        username: e.target.value,
                      })
                    }
                  />
                </div>
                <div>
                  <span className={labelCls}>Password</span>
                  <input
                    className={inputCls}
                    type="password"
                    value={dashUserDraft.password}
                    onChange={(e) =>
                      setDashUserDraft({
                        ...dashUserDraft,
                        password: e.target.value,
                      })
                    }
                  />
                </div>
              </div>

              <div>
                <span className={labelCls}>Role</span>
                <select
                  className={inputCls}
                  value={dashUserDraft.role}
                  onChange={(e) =>
                    setDashUserDraft({
                      ...dashUserDraft,
                      role: e.target.value as DashboardUser["role"],
                    })
                  }
                >
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
              </div>

              <div className="flex items-center justify-end gap-2.5">
                <button
                  className={btnCls}
                  onClick={() => setAddDashUserOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className={btnPrimaryCls}
                  disabled={
                    savingDashUsers ||
                    !dashUserDraft.username ||
                    !dashUserDraft.password
                  }
                  onClick={() => void addDashboardUser()}
                >
                  {savingDashUsers ? "Working…" : "Add user"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Restart confirmation (fires when restreamer backend changed) */}
      {restartConfirmOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 p-4 grid place-items-center bg-black/[.66] backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setRestartConfirmOpen(false);
          }}
        >
          <div
            className="border border-[var(--color-border)] bg-[var(--color-background-elevated)] text-[var(--color-foreground)] rounded-xl p-4 shadow-2xl"
            style={{ width: "min(480px, 100%)" }}
          >
            <div className="font-extrabold mb-1">Restart required</div>
            <div className="text-sm text-[var(--color-foreground-muted)] mb-4">
              Changing the restreamer backend requires a server restart to
              take effect. Active RTSP clients will drop and reconnect when
              the server comes back up.
              <br />
              <br />
              Save and restart now?
            </div>
            <div className="flex justify-end gap-2">
              <button
                className={btnCls}
                onClick={() => setRestartConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                className={btnCls}
                style={{ background: "var(--color-brand)", color: "#fff" }}
                onClick={() => void saveAndRestart()}
              >
                Save &amp; restart
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Restarting overlay */}
      {restarting ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-50 p-4 grid place-items-center bg-black/[.75] backdrop-blur-sm"
        >
          <div
            className="border border-[var(--color-border)] bg-[var(--color-background-elevated)] text-[var(--color-foreground)] rounded-xl p-6 shadow-2xl text-center"
            style={{ width: "min(420px, 100%)" }}
          >
            <div className="font-extrabold mb-2">Restarting server…</div>
            <div className="text-sm text-[var(--color-foreground-muted)]">
              The page will reload automatically once the server is back up.
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
