import { useEffect, useMemo, useState } from "react";
import { trpcMutation, trpcQuery } from "../api";

type Settings = {
  serviceIp: string;
  logLevel: "error" | "warn" | "info" | "debug";
  logRetentionDays: number;
  rtspDefaultPort: number;
  rtspProxyEnabled: boolean;
  rtspRequireAuth: boolean;
};

type RtspCredential = {
  id: string;
  username: string;
  password: string;
  description?: string;
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [creds, setCreds] = useState<RtspCredential[]>([]);
  const [credDraft, setCredDraft] = useState<{
    username: string;
    password: string;
    description: string;
  }>({ username: "", password: "", description: "" });
  const [savingCred, setSavingCred] = useState(false);

  const dirty = useMemo(() => settings !== null, [settings]);

  useEffect(() => {
    (async () => {
      try {
        const s = await trpcQuery<Settings>("settings.get");
        setSettings(s);

        const list = await trpcQuery<RtspCredential[]>(
          "settings.listCredentials",
        );
        setCreds(list);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  async function refreshCreds() {
    const list = await trpcQuery<RtspCredential[]>("settings.listCredentials");
    setCreds(list);
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

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      await trpcMutation("settings.update", {
        serviceIp: settings.serviceIp,
        logLevel: settings.logLevel,
        logRetentionDays: settings.logRetentionDays,
        rtspDefaultPort: settings.rtspDefaultPort,
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
        <div className="grid cols2">
          <div className="card">
            <div className="label">
              Service IP/hostname (shown in RTSP/MJPEG/WebRTC URLs)
            </div>
            <input
              className="input"
              value={settings.serviceIp}
              onChange={(e) =>
                setSettings({ ...settings, serviceIp: e.target.value })
              }
            />
          </div>

          <div className="card">
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

            <div className="label" style={{ marginTop: 12 }}>
              Log retention days
            </div>
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

            <div className="label" style={{ marginTop: 12 }}>
              Default RTSP port
            </div>
            <input
              className="input"
              type="number"
              value={settings.rtspDefaultPort}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  rtspDefaultPort: Number(e.target.value),
                })
              }
            />

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
                  <button
                    className="btn"
                    disabled={savingCred}
                    onClick={() => void refreshCreds()}
                  >
                    Refresh users
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

                {creds.length === 0 ? (
                  <div style={{ color: "var(--muted)", fontSize: 13 }}>
                    No RTSP users configured.
                  </div>
                ) : (
                  <table className="table" style={{ marginTop: 6 }}>
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
            </div>
          </div>
        </div>
      )}
    </>
  );
}
