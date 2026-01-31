import { useEffect, useMemo, useState } from "react";
import { trpcMutation, trpcQuery } from "../api";
import { useAuth } from "../auth";

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

type RtspCredential = {
  id: string;
  username: string;
  password: string;
  description?: string;
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

  const [creds, setCreds] = useState<RtspCredential[]>([]);
  const [credDraft, setCredDraft] = useState<{
    username: string;
    password: string;
    description: string;
  }>({ username: "", password: "", description: "" });
  const [savingCred, setSavingCred] = useState(false);
  const [addCredOpen, setAddCredOpen] = useState(false);

  const [dashUsers, setDashUsers] = useState<DashboardUser[]>([]);
  const [savingDashUsers, setSavingDashUsers] = useState(false);
  const [addDashUserOpen, setAddDashUserOpen] = useState(false);
  const [dashUserDraft, setDashUserDraft] = useState<{
    username: string;
    password: string;
    role: "admin" | "user";
  }>({ username: "", password: "", role: "user" });

  const dirty = useMemo(() => settings !== null, [settings]);

  useEffect(() => {
    (async () => {
      try {
        const s = await trpcQuery<Settings>("settings.get");
        setSettings(s);

        const r = await trpcQuery<RuntimeInfo>("settings.getRuntime");
        setRuntime(r);

        const list = await trpcQuery<RtspCredential[]>(
          "settings.listCredentials",
        );
        setCreds(list);

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

  async function refreshCreds() {
    const list = await trpcQuery<RtspCredential[]>("settings.listCredentials");
    setCreds(list);
  }

  async function refreshDashboardUsers() {
    const list = await trpcQuery<DashboardUser[]>(
      "settings.listDashboardUsers",
    );
    setDashUsers(list);
  }

  async function addCredential() {
    if (!credDraft.username || !credDraft.password) return;
    setSavingCred(true);
    try {
      await trpcMutation("settings.addCredential", {
        username: credDraft.username,
        password: credDraft.password,
        description: credDraft.description || undefined,
      });
      setCredDraft({ username: "", password: "", description: "" });
      await refreshCreds();
      setAddCredOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingCred(false);
    }
  }

  async function deleteCredential(id: string) {
    if (!confirm("Delete RTSP user?")) return;
    setSavingCred(true);
    try {
      await trpcMutation("settings.deleteCredential", { id });
      await refreshCreds();
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingCred(false);
    }
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
                <span>Require auth for RTSP connections</span>
              </label>
            </div>

            <div style={{ marginTop: 14 }}>
              <div className="label">RTSP users</div>
              <div style={{ color: "var(--muted)", fontSize: 12 }}>
                Digest auth users accepted by the RTSP proxy.
              </div>

              <div
                className="row"
                style={{ marginTop: 10, justifyContent: "flex-end" }}
              >
                <button
                  className="btn"
                  disabled={savingCred}
                  onClick={() => void refreshCreds()}
                >
                  Refresh users
                </button>
                <button
                  className="btn primary"
                  disabled={savingCred}
                  onClick={() => {
                    setCredDraft({
                      username: "",
                      password: "",
                      description: "",
                    });
                    setAddCredOpen(true);
                  }}
                >
                  Add user
                </button>
              </div>

              {creds.length === 0 ? (
                <div
                  style={{ color: "var(--muted)", fontSize: 13, marginTop: 10 }}
                >
                  No RTSP users configured.
                </div>
              ) : (
                <table className="table" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 220 }}>Username</th>
                      <th>Description</th>
                      <th style={{ width: 110 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {creds.map((c) => (
                      <tr key={c.id}>
                        <td className="mono">{c.username}</td>
                        <td>{c.description ?? ""}</td>
                        <td style={{ textAlign: "right" }}>
                          <button
                            className="btn danger"
                            disabled={savingCred}
                            onClick={() => void deleteCredential(c.id)}
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

            {authState.user?.role === "admin" ? (
              <div style={{ marginTop: 18 }}>
                <div className="label">Dashboard users</div>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>
                  Users that can access this web dashboard.
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
                <div className="label">Dashboard users</div>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>
                  Only admins can manage dashboard users.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {addCredOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          className="modalOverlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setAddCredOpen(false);
          }}
        >
          <div className="modalPanel" style={{ width: "min(720px, 100%)" }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 800 }}>Add RTSP user</div>
                <div className="subtitle">
                  Digest auth user for the RTSP proxy.
                </div>
              </div>
              <button className="btn" onClick={() => setAddCredOpen(false)}>
                Close
              </button>
            </div>

            <div className="grid" style={{ marginTop: 10 }}>
              <div className="grid cols2">
                <div>
                  <div className="label">Username</div>
                  <input
                    className="input"
                    value={credDraft.username}
                    onChange={(e) =>
                      setCredDraft({
                        ...credDraft,
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
                    value={credDraft.password}
                    onChange={(e) =>
                      setCredDraft({
                        ...credDraft,
                        password: e.target.value,
                      })
                    }
                  />
                </div>
              </div>

              <div>
                <div className="label">Description (optional)</div>
                <input
                  className="input"
                  value={credDraft.description}
                  onChange={(e) =>
                    setCredDraft({
                      ...credDraft,
                      description: e.target.value,
                    })
                  }
                />
              </div>

              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn" onClick={() => setAddCredOpen(false)}>
                  Cancel
                </button>
                <button
                  className="btn primary"
                  disabled={
                    savingCred || !credDraft.username || !credDraft.password
                  }
                  onClick={() => void addCredential()}
                >
                  {savingCred ? "Working…" : "Add user"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

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
