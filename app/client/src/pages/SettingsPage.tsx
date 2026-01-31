import { useEffect, useMemo, useState } from "react";
import { trpcMutation, trpcQuery } from "../api";
import { useAuth } from "../auth";
import { getStoredAuthToken } from "../authToken";

type Settings = {
  logLevel: "error" | "warn" | "info" | "debug";
  logRetentionDays: number;
  rtspProxyEnabled: boolean;
  rtspRequireAuth: boolean;
};

type RuntimeInfo = {
  httpPort: number;
  rtspPort: number;
  dataPath: string;
};

type DashboardUser = {
  username: string;
  role: "admin" | "user";
  createdAt?: number;
  updatedAt?: number;
};

export default function SettingsPage() {
  const { state: authState } = useAuth();

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

  const dirty = useMemo(() => settings !== null, [settings]);

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
        logLevel: settings.logLevel,
        logRetentionDays: settings.logRetentionDays,
        rtspRequireAuth: settings.rtspRequireAuth,
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
      setPersonalToken(data.token);
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
          disabled={!dirty || saving}
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
        <div className="grid">
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
              <div className="label">Data folder</div>
              <input
                className="input"
                readOnly
                value={runtime ? runtime.dataPath : ""}
              />
            </div>
          </div>

          <div className="card">
            <div className="label">Logging</div>

            <div className="grid cols2" style={{ marginTop: 10 }}>
              <div>
                <div className="label">Log level</div>
                <select
                  className="input"
                  value={settings.logLevel}
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
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      logRetentionDays: Number(e.target.value),
                    })
                  }
                />
              </div>
            </div>

            <div className="row" style={{ marginTop: 12 }}>
              <label className="row" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={settings.rtspRequireAuth}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      rtspRequireAuth: e.target.checked,
                    })
                  }
                />
                <span>
                  Require auth for RTSP connections (uses the Users list below)
                </span>
              </label>
            </div>

            {authState.enabled && authState.user ? (
              <div style={{ marginTop: 18 }}>
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
                    <div style={{ color: "var(--muted)", fontSize: 12 }}>
                      Copy and store it now: it won’t be shown again.
                    </div>
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
            ) : null}

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
          </div>
        </div>
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
