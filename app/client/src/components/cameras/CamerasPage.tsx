import { useCallback, useMemo, useState } from 'react';
import { Plus, Camera } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { trpcMutation } from '../../api';
import { CameraGrid } from './CameraGrid';
import { CameraDetailPanel } from './CameraDetailPanel';
import { CamerasProvider } from './CamerasContext';
import { AddCameraDialog } from './AddCameraDialog';
import { AddNvrDialog } from './AddNvrDialog';
import { NvrCard } from './NvrCard';
import { NvrSettingsModal } from './NvrSettingsModal';
import { buildGridItems, type SortMode } from './groupAndSort';
import { PreviewPanel } from './PreviewPanel';
import { FloatingPanel } from './FloatingPanel';
import { PtzFloatingContent } from './PtzFloatingContent';
import { EventsFloatingContent } from './EventsFloatingContent';
import { SessionsFloatingContent } from './SessionsFloatingContent';
import { DeviceControlsContent } from './DeviceControlsContent';
import { StreamFloatingPanel } from './StreamFloatingPanel';
import { useCameras } from './hooks/useCameras';
import { useSelectedCamera } from './hooks/useSelectedCamera';
import { useAuth } from '../../auth';
import type { CameraInfo, AvailableStream, NvrInfo } from './types';

type FloatingPanelEntry =
  | { id: string; type: 'ptz'; camera: CameraInfo }
  | { id: string; type: 'events'; camera: CameraInfo }
  | { id: string; type: 'sessions'; camera: CameraInfo }
  | { id: string; type: 'controls'; camera: CameraInfo }
  | { id: string; type: 'stream'; camera: CameraInfo; stream: AvailableStream };

export function CamerasPage() {
  const camerasHook = useCameras();
  const { cameras, connectingByCamera, rtspServers, streamsByCamera, savingAutoStart, setAutoStartForCamera, nvrs } = camerasHook;
  const { selectedCamera, selectCamera } = useSelectedCamera(cameras);
  const navigate = useNavigate();
  const { state: authState } = useAuth();
  // Only admins (or anyone when auth is disabled) can delete cameras. Backend
  // enforces this; the UI mirrors it so the delete button doesn't show as a
  // dead no-op for non-admin users.
  const canDeleteCamera =
    authState.enabled === false || authState.user?.role === 'admin';

  const [floatingPanels, setFloatingPanels] = useState<FloatingPanelEntry[]>([]);
  // The NVR whose device-level settings modal is currently open (null = none).
  const [openNvrSettings, setOpenNvrSettings] = useState<NvrInfo | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('group');

  const onlineCount = cameras.filter((c) => c.status === 'connected').length;

  const gridItems = useMemo(
    () => buildGridItems(cameras, nvrs, sortMode),
    [cameras, nvrs, sortMode],
  );

  const handleReorder = useCallback(
    async (orderedCameraIds: string[]) => {
      try {
        await trpcMutation('cameras.reorder', { orderedCameraIds });
        await camerasHook.refresh();
      } catch (err) {
        // Swallow — the grid will revert to its previous order on refresh.
        // A toast/log hook is the next polish step.
        console.error('cameras.reorder failed', err);
      }
    },
    [camerasHook],
  );

  const handleSelectCamera = (camera: CameraInfo) => {
    if (window.innerWidth < 768) {
      navigate(`/cameras/${encodeURIComponent(camera.name || camera.host)}`);
    } else if (selectedCamera?.id === camera.id) {
      selectCamera(null);
    } else {
      selectCamera(camera);
    }
  };

  const openFloatingPanel = (entry: FloatingPanelEntry) => {
    setFloatingPanels((prev) => {
      // Same exact panel already open — skip
      if (prev.some((p) => p.id === entry.id)) return prev;
      // Replace existing panel of same type (only one PTZ, one events, one sessions, one controls, one stream at a time)
      const filtered = prev.filter((p) => p.type !== entry.type);
      return [...filtered, entry];
    });
  };

  const closeFloatingPanel = (id: string) => {
    setFloatingPanels((prev) => prev.filter((p) => p.id !== id));
  };

  const handleOpenPtz = (camera: CameraInfo) => {
    openFloatingPanel({ id: `${camera.id}-ptz`, type: 'ptz', camera });
  };

  const handleOpenEvents = (camera: CameraInfo) => {
    openFloatingPanel({ id: `${camera.id}-events`, type: 'events', camera });
  };

  const handleOpenSessions = (camera: CameraInfo) => {
    openFloatingPanel({ id: `${camera.id}-sessions`, type: 'sessions', camera });
  };

  const handleOpenDeviceControls = (camera: CameraInfo) => {
    openFloatingPanel({ id: `${camera.id}-controls`, type: 'controls', camera });
  };

  const handleOpenStream = (camera: CameraInfo, stream: AvailableStream) => {
    const id = `${camera.id}-stream-${stream.profile}`;
    openFloatingPanel({ id, type: 'stream', camera, stream });
  };

  return (
    <CamerasProvider value={camerasHook}>
      {cameras.length === 0 && nvrs.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <Camera size={48} className="mx-auto mb-4 text-[var(--color-foreground-subtle)]" />
            <h2 className="text-lg font-semibold mb-2">No cameras configured</h2>
            <p className="text-sm text-[var(--color-foreground-muted)] mb-4">Add your first Reolink camera or NVR to get started</p>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => camerasHook.setAddOpen(true)}
                className="inline-flex items-center gap-1 rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm text-white"
              >
                <Plus size={14} /> Add Camera
              </button>
              <button
                onClick={() => camerasHook.setAddNvrOpen(true)}
                className="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface-hover)] px-4 py-2 text-sm"
              >
                <Plus size={14} /> Add NVR
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col h-full">
          {/* Page Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
            <div>
              <h1 className="text-base font-semibold">Cameras</h1>
              <p className="text-[11px] text-[var(--color-foreground-muted)] mt-0.5">{cameras.length} cameras · {onlineCount} online</p>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-[11px] text-[var(--color-foreground-muted)]">
                <span>Sort:</span>
                <select
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as SortMode)}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] text-[11px] px-2 py-1"
                >
                  <option value="group">Group by parent</option>
                  <option value="name">Name (A–Z)</option>
                  <option value="status">Status (online first)</option>
                  <option value="custom">Custom (drag to reorder)</option>
                </select>
              </label>
              <button
                onClick={() => camerasHook.setAddOpen(true)}
                className="inline-flex items-center gap-1 rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs text-white"
              >
                <Plus size={12} /> Add Camera
              </button>
              <button
                onClick={() => camerasHook.setAddNvrOpen(true)}
                className="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface-hover)] px-3 py-1.5 text-xs"
              >
                <Plus size={12} /> Add NVR
              </button>
            </div>
          </div>

          {/* NVR access bar — shown only when the grid is NOT grouping by
              parent (in "group" mode the headers inside the grid already
              expose the NVR settings button, so the bar would be redundant). */}
          {nvrs.length > 0 && sortMode !== 'group' && (
            <div className="px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col gap-2">
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
                NVRs / Hubs
              </div>
              {nvrs.map((nvr) => (
                <NvrCard
                  key={nvr.id}
                  nvr={nvr}
                  childCameras={cameras.filter((c) => c.nvrId === nvr.id)}
                  onOpenSettings={(n) => setOpenNvrSettings(n)}
                />
              ))}
            </div>
          )}

          {/* Grid + Detail Panel */}
          <div className="flex flex-1 min-h-0">
            <CameraGrid
              items={gridItems}
              streamsByCamera={streamsByCamera}
              rtspServers={rtspServers}
              connectingByCamera={connectingByCamera}
              selectedCamera={selectedCamera}
              onSelectCamera={handleSelectCamera}
              onConnect={(cam) => camerasHook.connect(cam.id)}
              onOpenPtz={handleOpenPtz}
              onOpenEvents={handleOpenEvents}
              onOpenSessions={handleOpenSessions}
              onOpenDeviceControls={handleOpenDeviceControls}
              onOpenStream={handleOpenStream}
              onOpenNvrSettings={(n) => setOpenNvrSettings(n)}
              onReorder={sortMode === 'custom' ? handleReorder : undefined}
            />
            {selectedCamera && (
              <CameraDetailPanel
                camera={selectedCamera}
                streams={streamsByCamera[selectedCamera.id] ?? []}
                rtspServers={rtspServers}
                connecting={connectingByCamera[selectedCamera.id] ?? false}
                onConnect={() => camerasHook.connect(selectedCamera.id)}
                onDisconnect={() => camerasHook.disconnect(selectedCamera.id)}
                onDelete={canDeleteCamera ? () => { void camerasHook.deleteCamera(selectedCamera.id); selectCamera(null); } : undefined}
                onSetDebug={() => camerasHook.setCameraDebug(selectedCamera.id, !selectedCamera.debugLogs)}
                onOpenPreview={(state) => camerasHook.setPreviewModal(state)}
                savingAutoStart={savingAutoStart[selectedCamera.id] ?? false}
                onToggleAutoStart={() => void setAutoStartForCamera(selectedCamera, !selectedCamera.autoStart)}
                serviceIp={camerasHook.serviceIp}
                rtspPort={camerasHook.rtspPort}
                onClose={() => selectCamera(null)}
              />
            )}
          </div>
        </div>
      )}

      {/* Dialogs */}
      <AddCameraDialog
        open={camerasHook.addOpen}
        onOpenChange={camerasHook.setAddOpen}
        adding={camerasHook.adding}
        setAdding={camerasHook.setAdding}
        onAdd={camerasHook.addCamera}
        connectedCameraId={camerasHook.addedCameraId}
        onRefresh={() => void camerasHook.refresh()}
      />
      <AddNvrDialog
        open={camerasHook.addNvrOpen}
        onOpenChange={camerasHook.setAddNvrOpen}
        onDone={() => {
          camerasHook.setAddNvrOpen(false);
          void camerasHook.refresh();
        }}
      />
      {camerasHook.previewModal.open && (
        <PreviewPanel
          state={camerasHook.previewModal}
          onClose={() => camerasHook.setPreviewModal({ open: false })}
        />
      )}

      {/* NVR-level settings modal (device-global ops) */}
      {openNvrSettings && (
        <NvrSettingsModal
          open
          nvrId={openNvrSettings.id}
          nvrName={openNvrSettings.name}
          existingChildren={cameras
            .filter((c) => c.nvrId === openNvrSettings.id)
            .map((c) => ({ id: c.id, channel: c.rtspChannel ?? 0 }))}
          onChannelAdded={() => void camerasHook.refresh()}
          onClose={() => setOpenNvrSettings(null)}
        />
      )}

      {/* Floating panels */}
      {floatingPanels.map((panel, i) => {
        if (panel.type === 'ptz') {
          return (
            <FloatingPanel
              key={panel.id}
              title={`PTZ — ${panel.camera.name || panel.camera.host}`}
              onClose={() => closeFloatingPanel(panel.id)}
              offsetIndex={i}
              defaultWidth={280}
              defaultHeight={300}
            >
              <PtzFloatingContent cameraId={panel.camera.id} />
            </FloatingPanel>
          );
        }

        if (panel.type === 'events') {
          return (
            <FloatingPanel
              key={panel.id}
              title={`Events — ${panel.camera.name || panel.camera.host}`}
              onClose={() => closeFloatingPanel(panel.id)}
              offsetIndex={i}
              defaultWidth={360}
              defaultHeight={320}
            >
              <EventsFloatingContent cameraId={panel.camera.id} />
            </FloatingPanel>
          );
        }

        if (panel.type === 'sessions') {
          return (
            <FloatingPanel
              key={panel.id}
              title={`Sessions — ${panel.camera.name || panel.camera.host}`}
              onClose={() => closeFloatingPanel(panel.id)}
              offsetIndex={i}
              defaultWidth={340}
              defaultHeight={300}
            >
              <SessionsFloatingContent cameraId={panel.camera.id} />
            </FloatingPanel>
          );
        }

        if (panel.type === 'controls') {
          return (
            <FloatingPanel
              key={panel.id}
              title={`Controls — ${panel.camera.name || panel.camera.host}`}
              onClose={() => closeFloatingPanel(panel.id)}
              offsetIndex={i}
              defaultWidth={300}
              defaultHeight={250}
            >
              <DeviceControlsContent cameraId={panel.camera.id} />
            </FloatingPanel>
          );
        }

        if (panel.type === 'stream') {
          return (
            <StreamFloatingPanel
              key={panel.id}
              panelId={panel.id}
              camera={panel.camera}
              stream={panel.stream}
              offsetIndex={i}
              onClose={() => closeFloatingPanel(panel.id)} />
          );
        }

        return null;
      })}
    </CamerasProvider>
  );
}
