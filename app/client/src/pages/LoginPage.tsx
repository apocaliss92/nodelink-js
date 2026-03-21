import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { NodelinkIcon } from "../components/layout/NodelinkIcon";

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
    <div className="flex items-center justify-center min-h-screen bg-[var(--color-background)]">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-8 w-full max-w-sm shadow-lg">
        {/* Branding */}
        <div className="flex flex-col items-center gap-2 mb-6">
          <NodelinkIcon size={40} />
          <span className="text-base font-semibold text-[var(--color-foreground)]">Nodelink.js</span>
        </div>

        <div className="text-lg font-extrabold text-[var(--color-foreground)] mb-1">Sign in</div>
        <div className="text-xs text-[var(--color-foreground-muted)] mb-4">
          {enabled
            ? "Authentication is enabled for this dashboard."
            : "Authentication appears disabled."}
        </div>

        {configHint && (
          <div className="text-xs text-[var(--color-foreground-muted)] mb-3">{configHint}</div>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-3 mb-4">
            <div className="text-red-200 text-sm">Error: {error}</div>
          </div>
        )}

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div>
            <label className="block text-xs text-[var(--color-foreground-muted)] mb-1.5">
              Username
            </label>
            <input
              className="w-full bg-black/25 border border-[var(--color-border)] text-[var(--color-foreground)] px-3 py-2 rounded-[10px] text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--color-foreground-muted)] mb-1.5">
              Password
            </label>
            <input
              className="w-full bg-black/25 border border-[var(--color-border)] text-[var(--color-foreground)] px-3 py-2 rounded-[10px] text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="flex justify-end mt-1">
            <button
              className="bg-[var(--color-primary)] text-white px-4 py-2 rounded-[10px] text-sm font-semibold cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              type="submit"
              disabled={submitting || !username || !password}
            >
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
