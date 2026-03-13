import {
  AddCameraModal,
  CameraCard,
  EmptyState,
  PreviewModal,
  useCamerasPage,
  type CameraInfo,
} from "../components/cameras";

export default function CamerasPage() {
  const {
    cameras,
    loading,
    error,
    connectingByCamera,
    rtspServers,
    mjpegStatus,
    webrtcStatus,
    hlsStatus,
    rtspProxyStatus,
    savingProxy,
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
    toggleProxy,
  } = useCamerasPage();

  return (
    <>
      <div className="header">
        <h1 className="h1">Cameras</h1>
        <div className="row">
          <button
            className={`btn master ${
              rtspProxyStatus?.running ? "autostart on" : "autostart off"
            }`}
            disabled={
              savingProxy || loading || rtspProxyStatus?.enabled === false
            }
            onClick={() => void toggleProxy()}
            title={
              rtspProxyStatus?.enabled === false
                ? "RTSP Proxy disabled in settings"
                : rtspProxyStatus?.running
                  ? "Stop RTSP proxy"
                  : "Start RTSP proxy"
            }
          >
            {savingProxy ? (
              <>RTSP Proxy: working…</>
            ) : (
              <>
                RTSP Proxy: {rtspProxyStatus?.running ? "ON" : "OFF"}
                {rtspProxyStatus ? ` (${rtspProxyStatus.connections})` : ""}
              </>
            )}
          </button>

          <button className="btn primary" onClick={() => setAddOpen(true)}>
            + Add camera
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

      {previewModal.open && (
        <PreviewModal
          state={previewModal}
          onClose={() => setPreviewModal({ open: false })}
        />
      )}

      {!loading && cameras.length === 0 ? (
        <EmptyState onAddCamera={() => setAddOpen(true)} />
      ) : (
        <div className="grid">
          {cameras.map((c: CameraInfo) => (
            <CameraCard
              key={c.id}
              camera={c}
              streams={streamsByCamera[c.id] ?? []}
              streamsLoading={streamsLoadingByCamera[c.id] ?? false}
              streamsDiscoveryAttempts={
                streamsDiscoveryAttemptsByCamera[c.id] ?? 0
              }
              connecting={connectingByCamera[c.id] ?? false}
              savingAutoStart={savingAutoStart[c.id] ?? false}
              rtspProxyPort={rtspProxyStatus?.port}
              rtspServers={rtspServers}
              mjpegStatus={mjpegStatus}
              webrtcStatus={webrtcStatus}
              hlsStatus={hlsStatus}
              onConnect={() => void connect(c.id)}
              onDisconnect={() => void disconnect(c.id)}
              onSetDebug={() => void setCameraDebug(c.id, !c.debugLogs)}
              onSetAutoStart={() => {
                void setAutoStartForCamera(c, !(c.autoStart === true));
              }}
              onDelete={() => void deleteCamera(c.id)}
              onOpenPreview={setPreviewModal}
            />
          ))}
        </div>
      )}
    </>
  );
}
