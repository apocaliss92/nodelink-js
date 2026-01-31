import { type ReactNode, useEffect, useState } from "react";
import {
  NavLink,
  Route,
  Routes,
  Navigate,
  useLocation,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import CamerasPage from "./pages/CamerasPage";
import LogsPage from "./pages/LogsPage";
import SettingsPage from "./pages/SettingsPage";
import DocsPage from "./pages/DocsPage";
import WebRTCPreviewPage from "./pages/WebRTCPreviewPage";
import LoginPage from "./pages/LoginPage";
import { fetchUpdates, trpcQuery, type UpdateInfo } from "./api";

// Simple SVG icons as components
const CameraIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

const LogsIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

const SettingsIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const DocsIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
);

function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (!state.enabled) return <>{children}</>;
  if (!state.checked) return <div className="card">Loading…</div>;
  if (!state.user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

function AppInner() {
  const baseUrl = import.meta.env.BASE_URL;
  const { state, logout } = useAuth();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const runtime = await trpcQuery<{ appVersion?: string | null }>(
          "settings.getRuntime",
        );
        if (!cancelled) setAppVersion(runtime?.appVersion ?? null);
      } catch {
        // ignore
      }

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
  }, []);

  // If auth is enabled and user is not signed in, show only login route.
  if (state.enabled && state.checked && !state.user) {
    return (
      <main className="main" style={{ padding: 20 }}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </main>
    );
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <img
            src={`${baseUrl}icon-72x72.png`}
            alt="NodeLink"
            className="brandIcon"
          />
          <span>nodelink.js</span>
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            <CameraIcon />
            <span>Cameras</span>
          </NavLink>
          <NavLink to="/logs">
            <LogsIcon />
            <span>Logs</span>
          </NavLink>
          <NavLink to="/settings">
            <SettingsIcon />
            <span>Settings</span>
          </NavLink>
          <NavLink to="/docs">
            <DocsIcon />
            <span>Docs</span>
          </NavLink>
        </nav>

        <div
          className="sidebarFooter"
          style={{ marginTop: "auto", paddingTop: 16 }}
        >
          {state.enabled && state.user ? (
            <>
              <div style={{ color: "var(--muted)", fontSize: 12 }}>
                Signed in as
              </div>
              <div className="mono" style={{ marginTop: 4 }}>
                {state.user.username}
              </div>
              <button
                className="btn"
                style={{ width: "100%", marginTop: 10 }}
                onClick={() => void logout()}
              >
                Sign out
              </button>
            </>
          ) : null}

          {appVersion ? (
            <div
              style={{
                color: "var(--muted)",
                fontSize: 12,
                marginTop: state.enabled && state.user ? 12 : 0,
              }}
            >
              Version: <span className="mono">v{appVersion}</span>
            </div>
          ) : null}

          {appVersion && updateInfo ? (
            <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 6 }}>
              {updateInfo.updateAvailable && updateInfo.latestVersion ? (
                <>
                  Update:{" "}
                  <a
                    href={updateInfo.releaseUrl ?? "#"}
                    target={updateInfo.releaseUrl ? "_blank" : undefined}
                    rel={updateInfo.releaseUrl ? "noreferrer" : undefined}
                    style={{ textDecoration: "underline" }}
                  >
                    v{updateInfo.latestVersion} available
                  </a>
                </>
              ) : updateInfo.error ? (
                <>Update: unavailable</>
              ) : (
                <>Update: up to date</>
              )}
            </div>
          ) : null}
        </div>
      </aside>

      <main className="main">
        {updateInfo?.updateAvailable && updateInfo.latestVersion ? (
          <div
            className="card"
            style={{
              borderColor: "rgba(245, 158, 11, 0.55)",
              background: "rgba(245, 158, 11, 0.08)",
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 800 }}>Update available</div>
            <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 6 }}>
              Current: <span className="mono">v{appVersion ?? "?"}</span> ·
              Latest: <span className="mono">v{updateInfo.latestVersion}</span>
              {updateInfo.releaseUrl ? (
                <>
                  {" "}
                  ·{" "}
                  <a
                    href={updateInfo.releaseUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: "underline" }}
                  >
                    View release
                  </a>
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        {state.enabled && state.user ? (
          <button
            className="mobileAvatar"
            type="button"
            aria-label="Sign out"
            title={`Sign out (${state.user.username})`}
            onClick={() => void logout()}
          >
            <span className="mobileAvatarInner">
              {String(state.user.username ?? "?")
                .trim()
                .slice(0, 1)
                .toUpperCase()}
            </span>
          </button>
        ) : null}
        <Routes>
          <Route
            path="/preview/webrtc/:cameraName/:profile"
            element={
              <RequireAuth>
                <WebRTCPreviewPage />
              </RequireAuth>
            }
          />
          <Route
            path="/"
            element={
              <RequireAuth>
                <CamerasPage />
              </RequireAuth>
            }
          />
          <Route
            path="/logs"
            element={
              <RequireAuth>
                <LogsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <SettingsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/docs"
            element={
              <RequireAuth>
                <DocsPage />
              </RequireAuth>
            }
          />
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}
