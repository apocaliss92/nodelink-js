import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchUpdates, trpcMutation, trpcQuery, type UpdateInfo } from "../api";
import { useAuth } from "../auth";
import { getStoredAuthToken, setStoredAuthToken } from "../authToken";

type Settings = {
  logLevel: "error" | "warn" | "info" | "debug";
  logRetentionDays: number;
  rtspProxyEnabled: boolean;
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
    streamMode: "nodelink" | "frigate";
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

export default function SettingsPage() {
  const { state: authState, refresh: refreshAuth } = useAuth();

  const [settings, setSettings] = useState<Settings | null>(null);
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
  const [frigateSelectedIds, setFrigateSelectedIds] = useState<Set<string>>(new Set());
  const [frigatePreview, setFrigatePreview] = useState<any>(null);
  const [frigateApplying, setFrigateApplying] = useState(false);
  const [frigateMessage, setFrigateMessage] = useState<string | null>(null);
  const [frigateMatchData, setFrigateMatchData] = useState<any>(null);
  const [frigateRemoveNames, setFrigateRemoveNames] = useState<Set<string>>(new Set());
  const [frigateCameraList, setFrigateCameraList] = useState<
    Array<{ id: string; name: string; status: string }>
  >([]);

  type TabId =
    | "general"
    | "go2rtc"
    | "frigate"
    | "auth"
    | "mqtt"
    | "webrtc"
    | "proxy"
    | "metrics";
  const [activeTab, setActiveTab] = useState<TabId>("general");

  const dirty = useMemo(() => settings !== null, [settings]);

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
        frigate: settings.frigate,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
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
    <>
      <div className="header">
        <h1 className="h1">Settings</h1>
        <button
          className="btn primary"
          disabled={!dirty || saving || !canEditSettings}
          onClick={save}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {error ? (
        <div className="card" style={{ borderColor: "rgba(239,68,68,0.5)" }}>
          <div style={{ color: "#fecaca" }}>Error: {error}</div>
        </div>
      ) : null}

      {!settings ? (
        <div className="card">Loading…</div>
      ) : (
        <>
          <div
            className="row"
            style={{
              gap: 4,
              marginBottom: 12,
              borderBottom: "1px solid var(--border)",
              paddingBottom: 8,
            }}
          >
            {(
              [
                ["general", "General"],
                ["go2rtc", "go2rtc"],
                ["frigate", "Frigate"],
                ["auth", "Auth"],
                ["mqtt", "MQTT"],
                ["webrtc", "WebRTC"],
                ["proxy", "Proxy"],
                ["metrics", "Metrics"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={`btn ${activeTab === id ? "primary" : ""}`}
                onClick={() => setActiveTab(id)}
                style={{ padding: "8px 14px" }}
              >
                {label}
              </button>
            ))}
          </div>

          {activeTab === "general" ? (
            <div className="card">
            <div className="label">Runtime (read-only)</div>
            <div className="grid cols2" style={{ marginTop: 10 }}>
              <div>
                <div className="label">HTTP port</div>
                <input
                  className="input"
                  readOnly
                  value={runtime ? String(runtime.httpPort) : ""}
                />
              </div>
              <div>
                <div className="label">RTSP port</div>
                <input
                  className="input"
                  readOnly
                  value={runtime ? String(runtime.rtspPort) : ""}
                />
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div className="label">App version</div>
              <input
                className="input"
                readOnly
                value={runtime?.appVersion ? String(runtime.appVersion) : ""}
              />
              <div
                style={{ color: "var(--muted)", fontSize: 12, marginTop: 6 }}
              >
                {updateInfo?.updateAvailable && updateInfo.latestVersion ? (
                  <>
                    Update available:{" "}
                    <a
                      href={updateInfo.releaseUrl ?? "#"}
                      target={updateInfo.releaseUrl ? "_blank" : undefined}
                      rel={updateInfo.releaseUrl ? "noreferrer" : undefined}
                      style={{ textDecoration: "underline" }}
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

            <div style={{ marginTop: 12 }}>
              <div className="label">Data folder</div>
              <input
                className="input"
                readOnly
                value={runtime ? runtime.dataPath : ""}
              />
            </div>

            <div style={{ marginTop: 12 }}>
              <div className="label">Service IP (for RTSP/MJPEG URLs)</div>
              <input
                className="input"
                value={settings.serviceIp ?? "localhost"}
                disabled={!canEditSettings}
                onChange={(e) =>
                  setSettings({ ...settings, serviceIp: e.target.value })
                }
              />
            </div>

            <div className="label" style={{ marginTop: 18 }}>Logging</div>
            <div className="grid cols2" style={{ marginTop: 10 }}>
              <div>
                <div className="label">Log level</div>
                <select
                  className="input"
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
                <div className="label">Log retention days</div>
                <input
                  className="input"
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
              <div className="row" style={{ marginTop: 12 }}>
                <label className="row" style={{ cursor: "pointer" }}>
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

          {activeTab === "auth" ? (
            <div className="card">
            <div className="label">Dashboard authentication</div>
            {authState.enabled && authState.user ? (
              <>
                <div style={{ marginTop: 12 }}>
                  <div className="label">Personal token</div>
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>
                    Generate a long-lived token for streaming endpoints (MJPEG/HLS
                    via <span className="mono">?token=</span>, WebRTC via
                    <span className="mono"> Authorization: Bearer</span>). This
                    token does not expire.
                  </div>

                  <div
                    className="row"
                    style={{ marginTop: 10, justifyContent: "flex-end" }}
                  >
                    <button
                      className="btn primary"
                      disabled={creatingPersonalToken}
                      onClick={() => void createPersonalToken()}
                    >
                      Generate personal token
                    </button>
                  </div>

                  {personalToken ? (
                    <div style={{ marginTop: 10 }}>
                      <div className="row" style={{ marginTop: 8 }}>
                        <input
                          className="input mono"
                          readOnly
                          value={personalToken}
                          style={{ flex: 1, minWidth: 0 }}
                        />
                        <button
                          className="btn"
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
                  <div style={{ marginTop: 18 }}>
                    <div className="label">Users</div>
                    <div style={{ color: "var(--muted)", fontSize: 12 }}>
                      Users that can access this web dashboard and authenticate to
                      the RTSP proxy (Digest).
                    </div>

                    <div
                      className="row"
                      style={{ marginTop: 10, justifyContent: "flex-end" }}
                    >
                      <button
                        className="btn"
                        disabled={savingDashUsers}
                        onClick={() => void refreshDashboardUsers()}
                      >
                        Refresh users
                      </button>
                      <button
                        className="btn primary"
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
                      <div
                        style={{
                          color: "var(--muted)",
                          fontSize: 13,
                          marginTop: 10,
                        }}
                      >
                        No dashboard users configured.
                      </div>
                    ) : (
                      <table className="table" style={{ marginTop: 10 }}>
                        <thead>
                          <tr>
                            <th style={{ width: 220 }}>Username</th>
                            <th style={{ width: 110 }}>Role</th>
                            <th />
                            <th style={{ width: 220 }} />
                          </tr>
                        </thead>
                        <tbody>
                          {dashUsers.map((u) => (
                            <tr key={u.username}>
                              <td className="mono">{u.username}</td>
                              <td>{u.role}</td>
                              <td />
                              <td style={{ textAlign: "right" }}>
                                <button
                                  className="btn"
                                  disabled={savingDashUsers}
                                  onClick={() =>
                                    void resetDashboardUserPassword(u.username)
                                  }
                                >
                                  Reset password
                                </button>
                                <button
                                  className="btn danger"
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
                  <div style={{ marginTop: 18 }}>
                    <div className="label">Users</div>
                    <div style={{ color: "var(--muted)", fontSize: 12 }}>
                      Only admins can manage dashboard users.
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={{ color: "var(--muted)", fontSize: 12 }}>
                Auth is disabled. Set AUTH_ENABLED=1 to secure the dashboard.
              </div>
            )}
          </div>
          ) : null}

          {activeTab === "mqtt" ? (
            <div className="card">
            <div className="label">MQTT (events publishing)</div>
            <div style={{ color: "var(--muted)", fontSize: 12 }}>
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
                  <div className="row" style={{ marginTop: 12 }}>
                    <label className="row" style={{ cursor: "pointer" }}>
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

                  <div className="grid cols2" style={{ marginTop: 10 }}>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <div className="label">Broker URL</div>
                      <input
                        className="input mono"
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
                      <div className="label">Username</div>
                      <input
                        className="input"
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
                      <div className="label">Password</div>
                      <input
                        className="input"
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
                      <div className="label">Client ID</div>
                      <input
                        className="input mono"
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
                      <div className="label">Topic prefix</div>
                      <input
                        className="input mono"
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
                      <div className="label">QoS</div>
                      <select
                        className="input"
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

            <div className="label" style={{ marginTop: 18 }}>Home Assistant</div>
            <div style={{ color: "var(--muted)", fontSize: 12 }}>
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
                  <div className="row" style={{ marginTop: 12 }}>
                    <label className="row" style={{ cursor: "pointer" }}>
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

                  <div className="grid cols2" style={{ marginTop: 10 }}>
                    <div>
                      <div className="label">Discovery prefix</div>
                      <input
                        className="input mono"
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
                      <div className="label">Poll interval (seconds)</div>
                      <input
                        className="input"
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
                      <div className="label">State topic prefix</div>
                      <input
                        className="input mono"
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

          {activeTab === "webrtc" ? (
            <div className="card">
            <div className="label">WebRTC (ICE)</div>
            <div style={{ color: "var(--muted)", fontSize: 12 }}>
              Useful in Docker bridge mode. Configure the ICE UDP port range and
              the additional host IPs/hostnames to advertise.
            </div>

            {(() => {
              const webrtc = settings.webrtc ?? {
                icePortRange: "",
                iceAdditionalHostAddresses: "",
              };

              return (
                <div className="grid cols2" style={{ marginTop: 10 }}>
                  <div>
                    <div className="label">ICE UDP port range</div>
                    <input
                      className="input mono"
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
                    <div className="label">Additional host addresses (CSV)</div>
                    <input
                      className="input mono"
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

          {activeTab === "go2rtc" ? (
            <div className="card">
              <div className="label">go2rtc Restreamer</div>
              <div style={{ color: "var(--muted)", fontSize: 12 }}>
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

                const handleStartStop = async () => {
                  setGo2rtcLoading(true);
                  try {
                    if (go2rtcStatus?.running) {
                      await trpcMutation("go2rtc.stop");
                    } else {
                      await trpcMutation("go2rtc.start");
                    }
                    await refreshStatus();
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setGo2rtcLoading(false);
                  }
                };

                // Auto-refresh status when tab is active
                if (!go2rtcStatus && !go2rtcLoading) {
                  refreshStatus();
                }

                return (
                  <>
                    <div style={{ marginTop: 12, marginBottom: 12 }}>
                      <label className="row" style={{ cursor: "pointer", gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={go2rtc.enabled}
                          disabled={!canEditSettings}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              go2rtc: { ...go2rtc, enabled: e.target.checked },
                            })
                          }
                        />
                        <span>Enable go2rtc restreamer</span>
                      </label>
                    </div>

                    {go2rtcStatus && (
                      <div
                        className="row"
                        style={{
                          gap: 8,
                          marginBottom: 12,
                          padding: "8px 12px",
                          borderRadius: 8,
                          background: go2rtcStatus.running
                            ? "rgba(34,197,94,0.1)"
                            : "rgba(239,68,68,0.1)",
                        }}
                      >
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: go2rtcStatus.running ? "#22c55e" : "#ef4444",
                          }}
                        />
                        <span style={{ flex: 1, fontSize: 13 }}>
                          {go2rtcStatus.running
                            ? `Running — API: ${go2rtcStatus.apiUrl}`
                            : "Stopped"}
                        </span>
                        <button
                          className={`btn ${go2rtcStatus.running ? "" : "primary"}`}
                          style={{ padding: "4px 12px", fontSize: 12 }}
                          disabled={go2rtcLoading}
                          onClick={handleStartStop}
                        >
                          {go2rtcLoading
                            ? "..."
                            : go2rtcStatus.running
                              ? "Stop"
                              : "Start"}
                        </button>
                        <button
                          className="btn"
                          style={{ padding: "4px 12px", fontSize: 12 }}
                          onClick={refreshStatus}
                        >
                          Refresh
                        </button>
                        {go2rtcStatus.running && go2rtcStatus.apiUrl && (() => {
                          try {
                            const p = new URL(go2rtcStatus.apiUrl as string).port;
                            const href = `${window.location.protocol}//${window.location.hostname}:${p}/`;
                            return (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="btn"
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
                        <div style={{ marginBottom: 12 }}>
                          <div className="label" style={{ fontSize: 12, marginBottom: 4 }}>
                            Registered streams
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              fontFamily: "monospace",
                              background: "var(--bg-secondary)",
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

                    {/* Ports are configured via environment variables, shown read-only */}
                    {go2rtcStatus?.running && go2rtcStatus.apiUrl && (
                      <div
                        style={{
                          marginTop: 8,
                          padding: "8px 12px",
                          borderRadius: 6,
                          background: "var(--bg-secondary)",
                          fontSize: 12,
                          fontFamily: "monospace",
                        }}
                      >
                        <div style={{ color: "var(--muted)", fontSize: 10, marginBottom: 4 }}>
                          Ports (configured via environment variables)
                        </div>
                        <div>API: {go2rtcStatus.apiUrl}</div>
                      </div>
                    )}

                    <div style={{ marginTop: 10 }}>
                      <div className="label">ICE servers (one per line)</div>
                      <textarea
                        className="input mono"
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
                        style={{ width: "100%", resize: "vertical" }}
                      />
                    </div>

                  </>
                );
              })()}
            </div>
          ) : null}

          {activeTab === "frigate" ? (
            <div className="card">
              <div className="label">Frigate Integration</div>
              <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 12 }}>
                Connect to a Frigate instance to push camera configurations directly.
                Streams are auto-assigned to detect/record/audio based on resolution.
              </div>

              {(() => {
                const fg = settings.frigate ?? {
                  host: "",
                  username: "",
                  password: "",
                  streamMode: "nodelink" as const,
                };

                const connectedCameras = frigateCameraList.filter(
                  (c) => c.status === "connected",
                );

                // Connection params from the form (not yet saved)
                const fgConn = {
                  host: fg.host,
                  username: fg.username,
                  password: fg.password,
                };

                const testConnection = async () => {
                  setFrigateLoading(true);
                  setFrigateMessage(null);
                  try {
                    // Load nodelink cameras for selection
                    const camList = await trpcQuery<
                      Array<{ id: string; name: string; status: string }>
                    >("cameras.list");
                    setFrigateCameraList(camList);

                    const res = await trpcQuery<{
                      ok: boolean;
                      version?: string;
                      error?: string;
                    }>("frigate.ping", fgConn);
                    setFrigateConnected(res);
                    if (res.ok) {
                      const cams = await trpcQuery<string[]>(
                        "frigate.getCameras",
                        fgConn,
                      );
                      setFrigateExistingCameras(cams);
                      // Load match data
                      const matchData = await trpcQuery<any>("frigate.match", fgConn);
                      setFrigateMatchData(matchData);
                      setFrigateRemoveNames(new Set());
                    }
                  } catch (e) {
                    setFrigateConnected({ ok: false, error: String(e) });
                  } finally {
                    setFrigateLoading(false);
                  }
                };

                const applyToFrigate = async (restart: boolean) => {
                  setFrigateApplying(true);
                  setFrigateMessage(null);
                  try {
                    const ids = Array.from(frigateSelectedIds);
                    // Names to remove: existing Frigate cameras that match our naming
                    // but are no longer selected
                    const allManagedNames = connectedCameras.map((c) =>
                      c.name
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, "_")
                        .replace(/^_+|_+$/g, ""),
                    );
                    const selectedNames = connectedCameras
                      .filter((c) => frigateSelectedIds.has(c.id))
                      .map((c) =>
                        c.name
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, "_")
                          .replace(/^_+|_+$/g, ""),
                      );
                    const removeNames = frigateExistingCameras.filter(
                      (n) => allManagedNames.includes(n) && !selectedNames.includes(n),
                    );

                    const res = await trpcMutation("frigate.apply", {
                      ...fgConn,
                      cameraIds: ids,
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
                      ...fgConn,
                      cameraIds: ids,
                    });
                    setFrigatePreview(res);
                  } catch {
                    // ignore
                  } finally {
                    setFrigateLoading(false);
                  }
                };

                const toggleCamera = (id: string) => {
                  setFrigateSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    void loadPreviewForIds(Array.from(next));
                    return next;
                  });
                };

                const selectAll = () => {
                  const allIds = connectedCameras.map((c) => c.id);
                  setFrigateSelectedIds(new Set(allIds));
                  void loadPreviewForIds(allIds);
                };

                const selectNone = () => {
                  setFrigateSelectedIds(new Set());
                  setFrigatePreview(null);
                };

                return (
                  <>
                    {/* Connection settings */}
                    <div className="grid cols2" style={{ marginBottom: 12 }}>
                      <div style={{ gridColumn: "1 / -1" }}>
                        <div className="label">Frigate URL</div>
                        <input
                          className="input mono"
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
                        <div className="label">Username (optional)</div>
                        <input
                          className="input"
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
                        <div className="label">Password (optional)</div>
                        <input
                          className="input"
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

                    {/* Stream mode */}
                    <div style={{ marginBottom: 12 }}>
                      <div className="label">Stream source</div>
                      <div style={{ color: "var(--muted)", fontSize: 11, marginBottom: 4 }}>
                        How Frigate receives video from your cameras
                      </div>
                      <select
                        className="input"
                        value={fg.streamMode}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            frigate: {
                              ...fg,
                              streamMode: e.target.value as "nodelink" | "frigate",
                            },
                          })
                        }
                      >
                        <option value="nodelink">
                          Nodelink go2rtc RTSP (recommended)
                        </option>
                        <option value="frigate">
                          Frigate go2rtc restream (adds streams to Frigate's go2rtc)
                        </option>
                      </select>
                    </div>

                    {/* Test connection */}
                    <div className="row" style={{ gap: 8, marginBottom: 12 }}>
                      <button
                        className="btn primary"
                        disabled={!fg.host || frigateLoading}
                        onClick={testConnection}
                      >
                        {frigateLoading ? "Testing..." : "Test Connection"}
                      </button>
                      {frigateConnected && (
                        <span
                          style={{
                            fontSize: 12,
                            color: frigateConnected.ok ? "#22c55e" : "#ef4444",
                          }}
                        >
                          {frigateConnected.ok
                            ? `Connected (Frigate ${frigateConnected.version})`
                            : `Error: ${frigateConnected.error}`}
                        </span>
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
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 10px",
                            borderRadius: 6,
                            border: "1px solid var(--border)",
                            fontSize: 12,
                            background: frigateRemoveNames.has(fc.frigateName)
                              ? "rgba(239,68,68,0.06)"
                              : "transparent",
                          }}
                        >
                          <span
                            style={{
                              width: 8, height: 8, borderRadius: "50%",
                              background: fc.frigateEnabled ? "#22c55e" : "#6b7280",
                              flexShrink: 0,
                            }}
                          />
                          <strong style={{ minWidth: 120 }}>{fc.frigateName}</strong>
                          {fc.matchedNodelinkCamera ? (
                            <span style={{ color: "var(--muted)", fontSize: 11 }}>
                              → {fc.matchedNodelinkCamera.name}
                            </span>
                          ) : (
                            <span style={{ color: "var(--muted)", fontSize: 11 }}>
                              {fc.frigateIps.length > 0 ? fc.frigateIps.join(", ") : ""}
                            </span>
                          )}
                          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                            {fc.matchedNodelinkCamera && (
                              <button
                                className="btn"
                                style={{ padding: "2px 8px", fontSize: 10 }}
                                onClick={async () => {
                                  // Load the EXISTING Frigate config for this camera
                                  const camId = fc.matchedNodelinkCamera.id;
                                  setFrigateSelectedIds(new Set([camId]));
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
                                      // Show the existing block as editable preview
                                      setFrigatePreview({
                                        cameras: [{
                                          cameraId: camId,
                                          cameraName: fc.matchedNodelinkCamera.name,
                                          frigateName: fc.frigateName,
                                          alreadyInFrigate: true,
                                          yaml: existing.yaml,
                                          block: existing.block,
                                          streams: fc.frigateInputs?.map((i: any) => ({
                                            go2rtcName: i.path?.split("/").pop() ?? "",
                                            profile: i.roles?.includes("record") ? "main" : "sub",
                                            roles: i.roles ?? [],
                                          })) ?? [],
                                          go2rtcStreams: {},
                                          go2rtcYaml: "",
                                        }],
                                        presets: {
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
                              className={`btn ${frigateRemoveNames.has(fc.frigateName) ? "primary" : ""}`}
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
                        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4, marginBottom: 12 }}>
                          {managed.length > 0 && (
                            <div style={{ marginBottom: 12 }}>
                              <div className="label">Managed cameras (imported from Nodelink)</div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                                {managed.map(renderRow)}
                              </div>
                            </div>
                          )}
                          {other.length > 0 && (
                            <div>
                              <div className="label">Other Frigate cameras</div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                                {other.map(renderRow)}
                              </div>
                            </div>
                          )}

                          {frigateRemoveNames.size > 0 && (
                            <div className="row" style={{ gap: 8, marginTop: 10 }}>
                              <button
                                className="btn"
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
                                className="btn"
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
                        <div
                          style={{
                            borderTop: "1px solid var(--border)",
                            paddingTop: 12,
                            marginTop: 4,
                          }}
                        >
                          <div className="label">Add/update cameras in Frigate</div>
                          <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                            <button
                              className="btn"
                              style={{ padding: "2px 8px", fontSize: 11 }}
                              onClick={selectAll}
                            >
                              Select all
                            </button>
                            <button
                              className="btn"
                              style={{ padding: "2px 8px", fontSize: 11 }}
                              onClick={selectNone}
                            >
                              Select none
                            </button>
                          </div>

                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                              gap: 6,
                            }}
                          >
                            {connectedCameras.map((c) => (
                              <label
                                key={c.id}
                                className="row"
                                style={{
                                  gap: 6,
                                  cursor: "pointer",
                                  padding: "6px 8px",
                                  borderRadius: 6,
                                  background: frigateSelectedIds.has(c.id)
                                    ? "rgba(59,130,246,0.1)"
                                    : "transparent",
                                  border: "1px solid var(--border)",
                                  fontSize: 13,
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={frigateSelectedIds.has(c.id)}
                                  onChange={() => toggleCamera(c.id)}
                                />
                                <span>{c.name}</span>
                              </label>
                            ))}
                          </div>
                        </div>

                        {frigatePreview?.cameras && (
                          <div style={{ marginTop: 12 }}>
                            {(frigatePreview.cameras as any[]).map((c: any, idx: number) => {
                              const isManualEdit = c._manualEdit === true;
                              const allRoles = ["record", "detect", "audio"];
                              const streamInfoList: any[] = c.streamInfo ?? c.streams ?? [];

                              /** Rebuild YAML from current streamInfo + options */
                              const rebuildYaml = (
                                streams: any[],
                                frigateName: string,
                                useFrigateGo2rtc: boolean,
                              ): string => {
                                const inputs: any[] = [];
                                const go2rtcStreamsBlock: string[] = [];
                                for (const s of streams) {
                                  if (!s.roles?.length) continue;
                                  const streamPath = useFrigateGo2rtc
                                    ? `rtsp://127.0.0.1:8554/${s.go2rtcName}`
                                    : (s.rtspUrl || `rtsp://127.0.0.1:8554/${s.go2rtcName}`);
                                  const inp: any = { path: streamPath, roles: s.roles };
                                  const inputArgs = s._inputArgs ?? "preset-rtsp-restream";
                                  if (inputArgs) inp.input_args = inputArgs;
                                  const hwaccel = s._hwaccelArgs ?? "";
                                  if (hwaccel) inp.hwaccel_args = hwaccel;
                                  inputs.push(inp);
                                  if (useFrigateGo2rtc) {
                                    go2rtcStreamsBlock.push(`    ${s.go2rtcName}: "${s.rtspUrl}"`);
                                  }
                                }
                                const detectStream = streams.find((s: any) => s.roles?.includes("detect"));
                                const res = detectStream?.resolution?.match(/(\d+)x(\d+)/);
                                const cam: any = { enabled: true, ffmpeg: { inputs } };
                                if (res) {
                                  cam.detect = { enabled: true, width: Number(res[1]), height: Number(res[2]), fps: Number(res[2]) <= 480 ? 5 : 10 };
                                }
                                cam.record = { enabled: true, alerts: { retain: { days: 30, mode: "motion" } }, detections: { retain: { days: 30, mode: "motion" } }, motion: { days: 7 } };
                                cam.snapshots = { enabled: true };
                                cam.audio = { enabled: streams.some((s: any) => s.roles?.includes("audio")) };
                                // Simple YAML serializer for the camera block
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
                                // go2rtc streams section if using Frigate restream
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
                              };

                              const updateCam = (patch: any) => {
                                const updated = [...frigatePreview.cameras];
                                const merged = { ...c, ...patch };
                                // Auto-rebuild YAML when not in manual edit mode
                                if (!merged._manualEdit) {
                                  const si = merged.streamInfo ?? streamInfoList;
                                  merged.yaml = rebuildYaml(si, merged.frigateName, merged._useFrigateGo2rtc === true);
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
                                  style={{
                                    marginBottom: 16,
                                    border: "1px solid var(--border)",
                                    borderRadius: 8,
                                    overflow: "hidden",
                                  }}
                                >
                                  {/* Header */}
                                  <div
                                    style={{
                                      padding: "8px 12px",
                                      background: "var(--bg-secondary)",
                                      borderBottom: "1px solid var(--border)",
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 8,
                                    }}
                                  >
                                    <strong style={{ fontSize: 13 }}>{c.cameraName}</strong>
                                    <span style={{ color: "var(--muted)", fontSize: 12 }}>→ {c.frigateName}</span>
                                    {c.alreadyInFrigate && (
                                      <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}>
                                        update
                                      </span>
                                    )}
                                    <label style={{ marginLeft: "auto", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
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
                                      className="input mono"
                                      value={c.yaml}
                                      onChange={(e) => updateCam({ yaml: e.target.value })}
                                      rows={Math.max(8, c.yaml.split("\n").length)}
                                      style={{
                                        width: "100%", border: "none", borderRadius: 0, resize: "vertical",
                                        fontSize: 11, lineHeight: 1.5, fontFamily: "monospace",
                                        whiteSpace: "pre", tabSize: 2, padding: "8px 12px", background: "var(--bg)",
                                      }}
                                      spellCheck={false}
                                    />
                                  ) : (
                                    <>
                                      {/* Stream table with role checkboxes and per-stream presets */}
                                      <div style={{ padding: "8px 12px" }}>
                                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                                          <thead>
                                            <tr style={{ color: "var(--muted)", textAlign: "left" }}>
                                              <th style={{ padding: "3px 6px" }}>Profile</th>
                                              <th style={{ padding: "3px 6px" }}>Codec</th>
                                              <th style={{ padding: "3px 6px" }}>Resolution</th>
                                              {allRoles.map((r) => (
                                                <th key={r} style={{ padding: "3px 6px", textAlign: "center" }}>{r}</th>
                                              ))}
                                              <th style={{ padding: "3px 6px" }}>input_args</th>
                                              <th style={{ padding: "3px 6px" }}>hwaccel_args</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {streamInfoList.map((s: any, sIdx: number) => (
                                              <tr key={s.go2rtcName || sIdx} style={{ borderTop: "1px solid var(--border)" }}>
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
                                                  ) : <span style={{ color: "var(--muted)" }}>—</span>}
                                                </td>
                                                <td style={{ padding: "4px 6px", fontFamily: "monospace", fontSize: 10 }}>{s.resolution || "—"}</td>
                                                {allRoles.map((role) => (
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
                                                    className="input"
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
                                                    className="input"
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

                                      {/* Use Frigate go2rtc restream checkbox */}
                                      <div style={{ padding: "4px 12px 8px", borderTop: "1px solid var(--border)" }}>
                                        <label style={{ fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                                          <input
                                            type="checkbox"
                                            checked={c._useFrigateGo2rtc === true}
                                            onChange={(e) => updateCam({ _useFrigateGo2rtc: e.target.checked })}
                                          />
                                          Add streams to Frigate go2rtc (restream via Frigate instead of direct RTSP)
                                        </label>
                                      </div>

                                      {/* Readonly YAML preview */}
                                      <textarea
                                        className="input mono"
                                        value={c.yaml}
                                        readOnly
                                        rows={Math.max(4, c.yaml.split("\n").length)}
                                        style={{
                                          width: "100%", border: "none", borderRadius: 0, resize: "none",
                                          fontSize: 10, lineHeight: 1.4, fontFamily: "monospace",
                                          whiteSpace: "pre", tabSize: 2, padding: "6px 12px",
                                          background: "var(--bg-secondary)", color: "var(--muted)",
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
                          <div className="row" style={{ gap: 8, marginTop: 12 }}>
                            <button
                              className="btn primary"
                              disabled={frigateApplying}
                              onClick={() => applyToFrigate(false)}
                            >
                              {frigateApplying ? "Saving..." : "Save to Frigate"}
                            </button>
                            <button
                              className="btn primary"
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
                            style={{
                              marginTop: 10,
                              padding: "8px 12px",
                              borderRadius: 6,
                              fontSize: 12,
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
                  </>
                );
              })()}
            </div>
          ) : null}

          {activeTab === "proxy" ? (
            <div className="card">
            <div className="label">Trusted proxy (Authentik / NPM)</div>
            <div style={{ color: "var(--muted)", fontSize: 12 }}>
              Enable header-based authentication when running behind a trusted
              reverse proxy (e.g. Nginx Proxy Manager + Authentik).
            </div>

            {!isAuthEnabled ? (
              <div
                style={{ marginTop: 10, color: "var(--muted)", fontSize: 13 }}
              >
                Auth is disabled. Set{" "}
                <span className="mono">AUTH_ENABLED=1</span>
                (and <span className="mono">ADMIN_PASSWORD</span>) to secure the
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
                    <div className="row" style={{ marginTop: 12 }}>
                      <label className="row" style={{ cursor: "pointer" }}>
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

                    <div className="grid cols2" style={{ marginTop: 10 }}>
                      <div style={{ gridColumn: "1 / -1" }}>
                        <div className="label">Allowed proxy IPs (CSV)</div>
                        <input
                          className="input mono"
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
                        <div
                          style={{
                            color: "var(--muted)",
                            fontSize: 12,
                            marginTop: 6,
                          }}
                        >
                          Must match the IP of your reverse proxy as seen by the
                          app (often the Docker bridge IP or the host).
                        </div>
                      </div>

                      <div>
                        <div className="label">Username header</div>
                        <input
                          className="input mono"
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
                        <div className="label">Groups header</div>
                        <input
                          className="input mono"
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
                        <div className="label">Admin group name</div>
                        <input
                          className="input"
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

          {activeTab === "metrics" ? (
            <div className="card">
            <div className="label">Resource usage</div>
            {!canViewMetrics ? (
              <div style={{ color: "var(--muted)", fontSize: 12 }}>
                Only admins can view metrics.
              </div>
            ) : (
              <>
                <div className="row" style={{ marginTop: 10 }}>
                  <label className="row" style={{ cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={metricsAutoRefresh}
                      onChange={(e) => setMetricsAutoRefresh(e.target.checked)}
                    />
                    <span>Auto refresh</span>
                  </label>

                  <div style={{ flex: 1 }} />

                  <button
                    className="btn"
                    disabled={metricsLoading}
                    onClick={() => void fetchMetricsOnce()}
                  >
                    {metricsLoading ? "Refreshing…" : "Refresh"}
                  </button>
                </div>

                {!metrics ? (
                  <div
                    style={{
                      color: "var(--muted)",
                      fontSize: 12,
                      marginTop: 10,
                    }}
                  >
                    {metricsError ? `Error: ${metricsError}` : "No data yet."}
                  </div>
                ) : null}

                {metrics ? (
                  <div className="grid cols2" style={{ marginTop: 10 }}>
                    <div>
                      <div className="label">Uptime</div>
                      <input
                        className="input"
                        readOnly
                        value={formatSeconds(metrics.process.uptimeSeconds)}
                      />
                    </div>
                    <div>
                      <div className="label">CPU</div>
                      <input
                        className="input"
                        readOnly
                        value={
                          metrics.process.cpu.percent === null
                            ? "(warming up…)"
                            : `${metrics.process.cpu.percent.toFixed(1)}%`
                        }
                      />
                    </div>

                    <div>
                      <div className="label">RSS</div>
                      <input
                        className="input"
                        readOnly
                        value={formatBytes(metrics.process.memory.rss)}
                      />
                    </div>
                    <div>
                      <div className="label">Heap used</div>
                      <input
                        className="input"
                        readOnly
                        value={`${formatBytes(metrics.process.memory.heapUsed)} / ${formatBytes(metrics.process.memory.heapTotal)}`}
                      />
                    </div>

                    <div>
                      <div className="label">Event loop utilization</div>
                      <input
                        className="input"
                        readOnly
                        value={`${(metrics.process.eventLoop.utilization * 100).toFixed(1)}%`}
                      />
                    </div>
                    <div>
                      <div className="label">Host memory</div>
                      <input
                        className="input"
                        readOnly
                        value={`${formatBytes(metrics.system.totalMem - metrics.system.freeMem)} / ${formatBytes(metrics.system.totalMem)}`}
                      />
                    </div>

                    <div>
                      <div className="label">Load avg</div>
                      <input
                        className="input"
                        readOnly
                        value={metrics.system.loadAvg
                          .slice(0, 3)
                          .map((n) => n.toFixed(2))
                          .join(" ")}
                      />
                    </div>
                    <div>
                      <div className="label">Node</div>
                      <input
                        className="input mono"
                        readOnly
                        value={`${metrics.process.nodeVersion} (pid ${metrics.process.pid})`}
                      />
                    </div>

                    <div style={{ gridColumn: "1 / -1" }}>
                      <div style={{ color: "var(--muted)", fontSize: 12 }}>
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

      {addDashUserOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          className="modalOverlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setAddDashUserOpen(false);
          }}
        >
          <div className="modalPanel" style={{ width: "min(720px, 100%)" }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 800 }}>Add dashboard user</div>
                <div className="subtitle">
                  User/password used to access the web dashboard.
                </div>
              </div>
              <button className="btn" onClick={() => setAddDashUserOpen(false)}>
                Close
              </button>
            </div>

            <div className="grid" style={{ marginTop: 10 }}>
              <div className="grid cols2">
                <div>
                  <div className="label">Username</div>
                  <input
                    className="input"
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
                  <div className="label">Password</div>
                  <input
                    className="input"
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
                <div className="label">Role</div>
                <select
                  className="input"
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

              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button
                  className="btn"
                  onClick={() => setAddDashUserOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="btn primary"
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
    </>
  );
}
