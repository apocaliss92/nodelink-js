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
import CapturePage from "./pages/CapturePage";
import LoginPage from "./pages/LoginPage";
import { fetchUpdates, trpcQuery, type UpdateInfo } from "./api";
import { AppLayout } from "./components/layout";

function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (!state.enabled) return <>{children}</>;
  if (!state.checked) return <div className="flex items-center justify-center p-8 text-muted-foreground">Loading…</div>;
  if (!state.user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

function AppInner() {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  // Capture is local-only; default to visible until the runtime says otherwise
  // (the server hides it under Docker).
  const [captureAvailable, setCaptureAvailable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const runtime = await trpcQuery<{
          appVersion?: string | null;
          captureAvailable?: boolean;
        }>("settings.getRuntime");
        if (!cancelled) {
          setAppVersion(runtime?.appVersion ?? null);
          setCaptureAvailable(runtime?.captureAvailable ?? true);
        }
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

      {/* Layout routes — all wrapped in RequireAuth + AppLayout */}
      <Route
        element={
          <RequireAuth>
            <AppLayout
              version={version}
              updateAvailable={updateAvailable}
              captureAvailable={captureAvailable}
            />
          </RequireAuth>
        }
      >
        <Route
          index
          element={<CamerasPage />}
        />
        <Route path="/cameras/:cameraName" element={<CameraDetailPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        {/* Capture is local-only; under Docker the route is omitted and any
            direct hit falls through to the catch-all redirect below. */}
        {captureAvailable && (
          <Route path="/capture" element={<CapturePage />} />
        )}
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
