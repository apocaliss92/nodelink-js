import { type ReactNode, useEffect, useState } from "react";
import {
  Route,
  Routes,
  Navigate,
  useLocation,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { CamerasPage } from "./components/cameras/CamerasPage";
import { CameraDetailPage } from "./components/cameras/CameraDetailPage";
import LogsPage from "./pages/LogsPage";
import SettingsPage from "./pages/SettingsPage";
import DocsPage from "./pages/DocsPage";
import ReportsPage from "./pages/ReportsPage";
import WebRTCPreviewPage from "./pages/WebRTCPreviewPage";
import LoginPage from "./pages/LoginPage";
import { fetchUpdates, trpcQuery, type UpdateInfo } from "./api";
import { AppLayout } from "./components/layout";

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

  const version = appVersion ?? undefined;
  const updateAvailable = updateInfo?.updateAvailable ?? false;

  return (
    <Routes>
      {/* Full-screen routes (no layout) */}
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/preview/webrtc/:cameraName/:profile"
        element={
          <RequireAuth>
            <WebRTCPreviewPage />
          </RequireAuth>
        }
      />

      {/* Layout routes — all wrapped in RequireAuth + AppLayout */}
      <Route
        element={
          <RequireAuth>
            <AppLayout version={version} updateAvailable={updateAvailable} />
          </RequireAuth>
        }
      >
        <Route
          index
          element={
            <div className="legacy">
              <CamerasPage />
            </div>
          }
        />
        <Route path="/cameras/:cameraName" element={<CameraDetailPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route
          path="/settings"
          element={
            <div className="legacy">
              <SettingsPage />
            </div>
          }
        />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}
