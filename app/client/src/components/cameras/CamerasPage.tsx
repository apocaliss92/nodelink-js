import { Plus, Camera } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { CameraGrid } from './CameraGrid';
import { CameraDetailPanel } from './CameraDetailPanel';
import { CamerasProvider } from './CamerasContext';
import { AddCameraDialog } from './AddCameraDialog';
import { AddNvrDialog } from './AddNvrDialog';
import { PreviewPanel } from './PreviewPanel';
import { useCameras } from './hooks/useCameras';
import { useSelectedCamera } from './hooks/useSelectedCamera';
import type { CameraInfo } from './types';

export function CamerasPage() {
  const camerasHook = useCameras();
  const { cameras, connectingByCamera, rtspServers, streamsByCamera, savingAutoStart, setAutoStartForCamera } = camerasHook;
  const { selectedCamera, selectCamera } = useSelectedCamera(cameras);
  const navigate = useNavigate();

  const onlineCount = cameras.filter((c) => c.status === 'connected').length;

  const handleSelectCamera = (camera: CameraInfo) => {
    if (window.innerWidth < 768) {
      navigate(`/cameras/${encodeURIComponent(camera.name || camera.host)}`);
    } else {
      selectCamera(camera);
    }
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
              {/* Restreamer controls */}
              <button
                onClick={() => void camerasHook.toggleGo2rtc()}
                disabled={camerasHook.go2rtcToggling || camerasHook.loading}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  camerasHook.go2rtcRunning
                    ? 'bg-[var(--color-success)]/15 text-[var(--color-success)] border border-[var(--color-success)]/30'
                    : 'bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)]'
                }`}
              >
                {camerasHook.go2rtcToggling ? 'Restreamer: working...' : `Restreamer: ${camerasHook.go2rtcRunning ? 'ON' : 'OFF'}`}
              </button>

              <select
                value={camerasHook.rtspSource}
                disabled={camerasHook.rtspSourceSaving}
                onChange={(e) => void camerasHook.setRtspSource(e.target.value as 'go2rtc' | 'local')}
                title="RTSP source: go2rtc (passthrough) or local (direct)"
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs cursor-pointer"
              >
                <option value="go2rtc">RTSP: go2rtc</option>
                <option value="local">RTSP: local</option>
              </select>

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
              selectedCamera={selectedCamera}
              onSelectCamera={handleSelectCamera}
            />
            {selectedCamera && (
              <CameraDetailPanel
                camera={selectedCamera}
                streams={streamsByCamera[selectedCamera.id] ?? []}
                rtspServers={rtspServers}
                connecting={connectingByCamera[selectedCamera.id] ?? false}
                onConnect={() => camerasHook.connect(selectedCamera.id)}
                onDisconnect={() => camerasHook.disconnect(selectedCamera.id)}
                onSetDebug={() => camerasHook.setCameraDebug(selectedCamera.id, !selectedCamera.debugLogs)}
                onStartStream={(_profile) => { /* tRPC start stream - wire later */ }}
                onStopStream={(_profile) => { /* tRPC stop stream - wire later */ }}
                onOpenPreview={(state) => camerasHook.setPreviewModal(state)}
                savingAutoStart={savingAutoStart[selectedCamera.id] ?? false}
                onToggleAutoStart={() => void setAutoStartForCamera(selectedCamera, !selectedCamera.autoStart)}
                go2rtcApiPort={camerasHook.go2rtcApiPort}
                serviceIp={camerasHook.serviceIp}
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
    </CamerasProvider>
  );
}
