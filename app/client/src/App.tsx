import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import CamerasPage from "./pages/CamerasPage";
import LogsPage from "./pages/LogsPage";
import SettingsPage from "./pages/SettingsPage";
import DocsPage from "./pages/DocsPage";
import WebRTCPreviewPage from "./pages/WebRTCPreviewPage";

export default function App() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">Nodelink.js Manager</div>
        <nav className="nav">
          <NavLink to="/" end>
            Cameras
          </NavLink>
          <NavLink to="/logs">Logs</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          <NavLink to="/docs">API Docs</NavLink>
        </nav>
      </aside>

      <main className="main">
        <Routes>
          <Route
            path="/preview/webrtc/:cameraName/:profile"
            element={<WebRTCPreviewPage />}
          />
          <Route path="/" element={<CamerasPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
