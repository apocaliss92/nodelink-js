import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

export default function LoginPage() {
  const navigate = useNavigate();
  const { state, login } = useAuth();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabled = state.enabled;
  const configHint = useMemo(() => {
    if (!state.config) return null;
    if (state.config.hasAdminPassword) {
      return `Admin user is '${state.config.adminUsername}'`;
    }
    return "You can sign in with a configured dashboard user.";
  }, [state.config]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 520, margin: "30px auto" }}>
      <div style={{ fontWeight: 800, fontSize: 18 }}>Sign in</div>
      <div className="subtitle" style={{ marginTop: 6 }}>
        {enabled
          ? "Authentication is enabled for this dashboard."
          : "Authentication appears disabled."}
      </div>

      {configHint ? (
        <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 8 }}>
          {configHint}
        </div>
      ) : null}

      {error ? (
        <div
          className="card"
          style={{ marginTop: 12, borderColor: "rgba(239,68,68,0.5)" }}
        >
          <div style={{ color: "#fecaca" }}>Error: {error}</div>
        </div>
      ) : null}

      <form onSubmit={onSubmit} style={{ marginTop: 12 }}>
        <div className="grid">
          <div>
            <div className="label">Username</div>
            <input
              className="input"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <div className="label">Password</div>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button
              className="btn primary"
              type="submit"
              disabled={submitting || !username || !password}
            >
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
