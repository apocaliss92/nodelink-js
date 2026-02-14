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

  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsAutoRefresh, setMetricsAutoRefresh] = useState(true);

  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  type TabId =
    | "general"
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
