import { useState } from "react";
import {
  AddCameraModal,
  AddNvrModal,
  CameraCard,
  EmptyState,
  PreviewModal,
  useCamerasPage,
  type CameraInfo,
  type NvrInfo,
} from "../components/cameras";

export default function CamerasPage() {
  const [manageNvr, setManageNvr] = useState<NvrInfo | null>(null);
  const {
    cameras,
    loading,
    error,
    connectingByCamera,
    rtspServers,
    rtspProxyStatus,
    go2rtcApiPort,
    go2rtcRunning,
    go2rtcToggling,
    streamsByCamera,
    streamsLoadingByCamera,
    streamsDiscoveryAttemptsByCamera,
    previewModal,
    addOpen,
    adding,
    savingAutoStart,
    setAdding,
    setAddOpen,
    setPreviewModal,
    connect,
    disconnect,
    setCameraDebug,
    setAutoStartForCamera,
    addCamera,
    deleteCamera,
    nvrs,
    addNvrOpen,
    setAddNvrOpen,
    deleteNvr,
    toggleGo2rtc,
    refresh,
  } = useCamerasPage();

  const standaloneCameras = cameras.filter((c) => !c.nvrId);
  const camerasByNvr = (nvrId: string) =>
    cameras.filter((c) => c.nvrId === nvrId);

  const renderCameraCard = (c: CameraInfo) => (
    <CameraCard
      key={c.id}
      camera={c}
      streams={streamsByCamera[c.id] ?? []}
      streamsLoading={streamsLoadingByCamera[c.id] ?? false}
      streamsDiscoveryAttempts={streamsDiscoveryAttemptsByCamera[c.id] ?? 0}
      connecting={connectingByCamera[c.id] ?? false}
      savingAutoStart={savingAutoStart[c.id] ?? false}
      rtspProxyPort={rtspProxyStatus?.port}
      go2rtcApiPort={go2rtcApiPort}
      rtspServers={rtspServers}
      onConnect={() => void connect(c.id)}
      onDisconnect={() => void disconnect(c.id)}
      onSetDebug={() => void setCameraDebug(c.id, !c.debugLogs)}
      onSetAutoStart={() => {
        void setAutoStartForCamera(c, !(c.autoStart === true));
      }}
      onDelete={() => void deleteCamera(c.id)}
      onOpenPreview={setPreviewModal}
    />
  );

  const renderNvrBlock = (nvr: NvrInfo) => {
    const nvrCameras = camerasByNvr(nvr.id);
    return (
      <div
        key={nvr.id}
        className="card"
        style={{
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 14,
          marginBottom: 16,
        }}
      >
        <div
          className="row"
          style={{
            justifyContent: "space-between",
            marginBottom: nvrCameras.length > 0 ? 12 : 0,
          }}
        >
          <div className="row" style={{ gap: 8 }}>
            <span className="badge mono" style={{ fontSize: 11 }}>
              NVR
            </span>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{nvr.name}</span>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>
              {nvr.host}:{nvr.port}
            </span>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>
              {nvrCameras.length} camera{nvrCameras.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button
              className="btn primary"
              style={{ fontSize: 11, padding: "2px 8px" }}
              onClick={() => setManageNvr(nvr)}
            >
              + Add Cameras
            </button>
            <button
              className="btn"
              style={{ fontSize: 11, padding: "2px 8px" }}
              onClick={() => void deleteNvr(nvr.id)}
            >
              Delete NVR
            </button>
          </div>
        </div>

        {nvrCameras.length > 0 && (
          <div className="grid">{nvrCameras.map(renderCameraCard)}</div>
        )}
      </div>
    );
  };

  const hasAnything = cameras.length > 0 || nvrs.length > 0;

  return (
    <>
      <div className="header">
        <h1 className="h1">Cameras</h1>
        <div className="row">
          <button
            className={`btn master ${
              go2rtcRunning ? "autostart on" : "autostart off"
            }`}
            disabled={go2rtcToggling || loading}
            onClick={() => void toggleGo2rtc()}
            title={go2rtcRunning ? "Stop go2rtc restreamer" : "Start go2rtc restreamer"}
          >
            {go2rtcToggling ? (
              <>Restreamer: working…</>
            ) : (
              <>Restreamer: {go2rtcRunning ? "ON" : "OFF"}</>
            )}
          </button>

          <button className="btn primary" onClick={() => setAddOpen(true)}>
            + Add Camera
          </button>
          <button className="btn primary" onClick={() => setAddNvrOpen(true)}>
            + Add NVR
          </button>
        </div>
      </div>

      {error ? (
        <div
          className="card"
          style={{ borderColor: "rgba(239,68,68,0.5)", marginBottom: 12 }}
        >
          <div style={{ color: "#fecaca" }}>Error: {error}</div>
        </div>
      ) : null}

      {addOpen && (
        <AddCameraModal
          adding={adding}
          setAdding={setAdding}
          onAdd={addCamera}
          onClose={() => setAddOpen(false)}
        />
      )}

      {addNvrOpen && (
        <AddNvrModal
          onClose={() => setAddNvrOpen(false)}
          onDone={() => {
            setAddNvrOpen(false);
            void refresh();
          }}
        />
      )}

      {manageNvr && (
        <AddNvrModal
          existingNvr={manageNvr}
          existingCameraChannels={camerasByNvr(manageNvr.id).map(
            (c) => c.rtspChannel,
          )}
          onClose={() => setManageNvr(null)}
          onDone={() => {
            setManageNvr(null);
            void refresh();
          }}
        />
      )}

      {previewModal.open && (
        <PreviewModal
          state={previewModal}
          onClose={() => setPreviewModal({ open: false })}
        />
      )}

      {!loading && !hasAnything ? (
        <EmptyState onAddCamera={() => setAddOpen(true)} />
      ) : (
        <>
          {nvrs.map(renderNvrBlock)}

          {standaloneCameras.length > 0 && (
            <div className="grid">
              {standaloneCameras.map(renderCameraCard)}
            </div>
          )}
        </>
      )}
    </>
  );
}
