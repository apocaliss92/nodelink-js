import { useState } from 'react';
import { Plus, Camera } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { CameraGrid } from './CameraGrid';
import { CameraDetailPanel } from './CameraDetailPanel';
import { CamerasProvider } from './CamerasContext';
import { AddCameraDialog } from './AddCameraDialog';
import { AddNvrDialog } from './AddNvrDialog';
import { PreviewPanel } from './PreviewPanel';
import { FloatingPanel } from './FloatingPanel';
import { PtzFloatingContent } from './PtzFloatingContent';
import { EventsFloatingContent } from './EventsFloatingContent';
import { SessionsFloatingContent } from './SessionsFloatingContent';
import { DeviceControlsContent } from './DeviceControlsContent';
import { WebRTCInlinePlayer } from './WebRTCInlinePlayer';
import { getStreamName, getWebrtcStreamName } from './utils';
import { useCameras } from './hooks/useCameras';
import { useSelectedCamera } from './hooks/useSelectedCamera';
import type { CameraInfo, AvailableStream } from './types';

type FloatingPanelEntry =
  | { id: string; type: 'ptz'; camera: CameraInfo }
  | { id: string; type: 'events'; camera: CameraInfo }
  | { id: string; type: 'sessions'; camera: CameraInfo }
  | { id: string; type: 'controls'; camera: CameraInfo }
  | { id: string; type: 'stream'; camera: CameraInfo; stream: AvailableStream };

export function CamerasPage() {
  const camerasHook = useCameras();
  const { cameras, connectingByCamera, rtspServers, streamsByCamera, savingAutoStart, setAutoStartForCamera } = camerasHook;
  const { selectedCamera, selectCamera } = useSelectedCamera(cameras);
  const navigate = useNavigate();

  const [floatingPanels, setFloatingPanels] = useState<FloatingPanelEntry[]>([]);

  const onlineCount = cameras.filter((c) => c.status === 'connected').length;

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
      {cameras.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <Camera size={48} className="mx-auto mb-4 text-[var(--color-foreground-subtle)]" />
            <h2 className="text-lg font-semibold mb-2">No cameras configured</h2>
            <p className="text-sm text-[var(--color-foreground-muted)] mb-4">Add your first Reolink camera to get started</p>
            <button
              onClick={() => camerasHook.setAddOpen(true)}
              className="inline-flex items-center gap-1 rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm text-white"
            >
              <Plus size={14} /> Add Camera
            </button>
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

          {/* Grid + Detail Panel */}
          <div className="flex flex-1 min-h-0">
            <CameraGrid
              cameras={cameras}
              streamsByCamera={streamsByCamera}
              rtspServers={rtspServers}
              connectingByCamera={connectingByCamera}
              selectedCamera={selectedCamera}
              restreamer={camerasHook.restreamer}
              onSelectCamera={handleSelectCamera}
              onConnect={(cam) => camerasHook.connect(cam.id)}
              onOpenPtz={handleOpenPtz}
              onOpenEvents={handleOpenEvents}
              onOpenSessions={handleOpenSessions}
              onOpenDeviceControls={handleOpenDeviceControls}
              onOpenStream={handleOpenStream}
            />
            {selectedCamera && (
              <CameraDetailPanel
                camera={selectedCamera}
                streams={streamsByCamera[selectedCamera.id] ?? []}
                rtspServers={rtspServers}
                connecting={connectingByCamera[selectedCamera.id] ?? false}
                onConnect={() => camerasHook.connect(selectedCamera.id)}
                onDisconnect={() => camerasHook.disconnect(selectedCamera.id)}
                onDelete={() => { void camerasHook.deleteCamera(selectedCamera.id); selectCamera(null); }}
                onSetDebug={() => camerasHook.setCameraDebug(selectedCamera.id, !selectedCamera.debugLogs)}
                onOpenPreview={(state) => camerasHook.setPreviewModal(state)}
                savingAutoStart={savingAutoStart[selectedCamera.id] ?? false}
                onToggleAutoStart={() => void setAutoStartForCamera(selectedCamera, !selectedCamera.autoStart)}
                go2rtcApiPort={camerasHook.go2rtcApiPort}
                go2rtcRtspPort={camerasHook.go2rtcRtspPort}
                serviceIp={camerasHook.serviceIp}
                restreamer={camerasHook.restreamer}
                localRtspPort={camerasHook.localRtspPort}
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
          const server = rtspServers.find(
            (s) => s.cameraId === panel.camera.id && s.profile === panel.stream.profile,
          );
          return (
            <FloatingPanel
              key={panel.id}
              title={`${panel.camera.name || panel.camera.host} — ${panel.stream.profile}`}
              onClose={() => closeFloatingPanel(panel.id)}
              offsetIndex={i}
              defaultWidth={480}
              defaultHeight={310}
              minWidth={320}
              minHeight={200}
            >
              <div className="h-full bg-black">
                <WebRTCInlinePlayer
                  streamName={getWebrtcStreamName(panel.camera, panel.stream.profile, server)}
                  go2rtcApiPort={camerasHook.go2rtcApiPort}
                  serviceIp={camerasHook.serviceIp}
                />
              </div>
            </FloatingPanel>
          );
        }

        return null;
      })}
    </CamerasProvider>
  );
}
