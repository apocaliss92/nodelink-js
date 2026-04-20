import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DeviceInfoSection } from './DeviceInfoSection';
import { StreamProfileCard } from './StreamProfileCard';
import { ActionsGrid } from './ActionsGrid';
import { PtzPanel } from './PtzPanel';
import { EventsPanel } from './EventsPanel';
import { SessionsPanel } from './SessionsPanel';
import { SessionsDialog } from './SessionsDialog';
import { CameraLogsPanel } from './CameraLogsPanel';
import { ConnectionPanel } from './ConnectionPanel';
import { useConnectionLogs } from './hooks/useConnectionLogs';
import { useCamerasContext } from './CamerasContext';
import { trpcQuery, trpcMutation } from '../../api';
import { withAuthTokenQuery, getCameraDisplayName, getStreamName, getWebrtcStreamName } from './utils';
import type { ControlsState, CameraEvent, DeviceSession } from './types';

type SessionsPayload = { sessions: DeviceSession[]; total: number };

export function CameraDetailPage() {
  const { cameraName } = useParams<{ cameraName: string }>();
  const navigate = useNavigate();
  const {
    cameras,
    rtspServers,
    streamsByCamera,
    connectingByCamera,
    connect,
    disconnect,
    setCameraDebug,
    setPreviewModal,
    savingAutoStart,
    setAutoStartForCamera,
    go2rtcApiPort,
    go2rtcRtspPort,
    serviceIp,
    restreamer,
  } = useCamerasContext();

  const [showPtz, setShowPtz] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showConnection, setShowConnection] = useState(false);
  const [sessionsDialogOpen, setSessionsDialogOpen] = useState(false);
  const [controlsState, setControlsState] = useState<ControlsState>(null);
  const [events, setEvents] = useState<CameraEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [deviceSessions, setDeviceSessions] = useState<DeviceSession[]>([]);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [dumping, setDumping] = useState(false);

  const camera = cameras.find((c) => (c.name || c.host) === cameraName);
  const isConnected = camera?.status === 'connected';

  const connLogs = useConnectionLogs(showLogs ? (camera?.id ?? null) : null);
  const [localLogs, setLocalLogs] = useState(connLogs);
  useEffect(() => { setLocalLogs(connLogs); }, [connLogs]);

  // Fetch controls state when camera connects.
  // sleepStatus intentionally excluded: server returns isSleeping=true with cached
  // capabilities when the camera is idle-disconnected, so polling on sleep transitions
  // would create a reconnect loop. The state refreshes on the next connect event.
  useEffect(() => {
    if (!camera || !isConnected) return;
    trpcQuery<ControlsState>('cameras.getControlsState', { id: camera.id })
      .then((st) => setControlsState(st ?? null))
      .catch(() => setControlsState(null));
  }, [camera?.id, isConnected]);

  // Fetch events when events panel opens
  useEffect(() => {
    if (!camera || !showEvents || !isConnected) return;
    setEventsLoading(true);
    trpcQuery<CameraEvent[]>('events.getRecent', { cameraId: camera.id })
      .then((list) => setEvents(list ?? []))
      .catch(() => setEvents([]))
      .finally(() => setEventsLoading(false));
  }, [showEvents, camera?.id, isConnected]);

  // SSE for real-time events
  useEffect(() => {
    if (!camera || !showEvents || !isConnected) return;
    const cameraId = camera.id;
    const sseUrl = withAuthTokenQuery(`${window.location.origin}/api/events/sse`);
    const es = new EventSource(sseUrl);
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data as string) as CameraEvent;
        if (payload.cameraId === cameraId) {
          setEvents((prev) => [payload, ...prev].slice(0, 50));
        }
      } catch {
        // ignore malformed events
      }
    };
    return () => es.close();
  }, [showEvents, camera?.id, isConnected]);

  const loadSessions = useCallback(() => {
    if (!camera || !isConnected) return;
    setSessionsLoading(true);
    trpcQuery<SessionsPayload>('cameras.getSessions', { id: camera.id })
      .then((data) => {
        setDeviceSessions(data?.sessions ?? []);
        setSessionsTotal(data?.total ?? 0);
      })
      .catch(() => {
        setDeviceSessions([]);
        setSessionsTotal(0);
      })
      .finally(() => setSessionsLoading(false));
  }, [camera, isConnected]);

  useEffect(() => {
    if (!camera || (!showSessions && !sessionsDialogOpen) || !isConnected) return;
    loadSessions();
  }, [camera, showSessions, sessionsDialogOpen, isConnected, loadSessions]);

  const handlePtzStart = useCallback(
    (cmd: string) => {
      if (!camera) return;
      void trpcMutation('cameras.ptzStart', { id: camera.id, command: cmd });
    },
    [camera?.id],
  );

  const handlePtzStop = useCallback(
    (cmd: string) => {
      if (!camera) return;
      void trpcMutation('cameras.ptzStop', { id: camera.id, command: cmd });
    },
    [camera?.id],
  );

  const handleGotoPreset = useCallback(
    (presetId: number) => () => {
      if (!camera) return;
      void trpcMutation('cameras.gotoPreset', { id: camera.id, presetId });
    },
    [camera?.id],
  );

  const handleDump = useCallback(async () => {
    if (!camera) return;
    setDumping(true);
    try {
      const result = await trpcMutation<{ token: string; filename: string }>(
        "cameras.dump",
        { cameraId: camera.id },
      );
      const link = document.createElement("a");
      link.href = `/api/dump/${result.token}`;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (e) {
      console.error("Dump failed:", e);
    } finally {
      setDumping(false);
    }
  }, [camera?.id]);

  if (!camera) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-foreground-muted)]">
        Camera not found
      </div>
    );
  }

  const streams = streamsByCamera[camera.id] ?? [];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-4 border-b border-[var(--color-border)]">
        <button
          onClick={() => navigate('/')}
          className="text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-base font-semibold">{camera.name || camera.host}</h1>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        <DeviceInfoSection camera={camera} />

        <div className="rounded-lg bg-[var(--color-surface)] p-3">
          <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
            Stream Profiles
          </div>
          <div className="flex flex-col gap-2">
            {streams.map((stream) => {
              const server = rtspServers.find(
                (s) => s.cameraId === camera.id && s.profile === stream.profile,
              );
              const name = getStreamName(camera, stream.profile, server);
              const webrtcName = getWebrtcStreamName(camera, stream.profile, server);
              return (
                <StreamProfileCard
                  key={stream.profile}
                  cameraId={camera.id}
                  stream={stream}
                  rtspServer={server}
                  onPreview={() => {
                    setPreviewModal({
                      open: true,
                      kind: 'webrtc' as const,
                      title: `${camera.name || camera.host} - ${stream.profile}`,
                      cameraName: getCameraDisplayName(camera),
                      profile: stream.profile,
                      streamName: webrtcName,
                      go2rtcApiPort,
                      serviceIp,
                    });
                  }}
                  streamName={name}
                  go2rtcApiPort={go2rtcApiPort}
                  go2rtcRtspPort={go2rtcRtspPort}
                  serviceIp={serviceIp}
                  isBattery={camera.isBattery}
                  restreamer={restreamer}
                />
              );
            })}
          </div>
        </div>

        <ActionsGrid
          onPtz={() => setShowPtz((v) => !v)}
          onEvents={() => setShowEvents((v) => !v)}
          onSessions={() => setShowSessions((v) => !v)}
          onLogs={() => setShowLogs((v) => !v)}
          onConnection={() => setShowConnection((v) => !v)}
          onConnect={isConnected ? () => disconnect(camera.id) : () => connect(camera.id)}
          onDebug={() => setCameraDebug(camera.id, !camera.debugLogs)}
          onDump={handleDump}
          dumping={dumping}
          isConnected={isConnected}
          connecting={connectingByCamera[camera.id] ?? false}
          autoStart={camera.autoStart}
          savingAutoStart={savingAutoStart[camera.id] ?? false}
          onToggleAutoStart={() => void setAutoStartForCamera(camera, !camera.autoStart)}
        />

        {showPtz && (
          <PtzPanel
            cameraName={camera.name || camera.host}
            controlsState={controlsState}
            onPtzStart={handlePtzStart}
            onPtzStop={handlePtzStop}
            onGotoPreset={handleGotoPreset}
            onClose={() => setShowPtz(false)}
          />
        )}

        {showEvents && (
          <EventsPanel
            cameraName={camera.name || camera.host}
            events={events}
            loading={eventsLoading}
            onClose={() => setShowEvents(false)}
          />
        )}

        {showLogs && (
          <CameraLogsPanel
            cameraName={camera.name || camera.host}
            logs={localLogs}
            onClose={() => setShowLogs(false)}
            onClear={() => setLocalLogs([])}
          />
        )}

        {showConnection && (
          <ConnectionPanel
            camera={camera}
            onClose={() => setShowConnection(false)}
          />
        )}

        {showSessions && (
          <SessionsPanel
            cameraName={camera.name || camera.host}
            sessions={deviceSessions}
            total={sessionsTotal}
            loading={sessionsLoading && deviceSessions.length === 0}
            fetching={sessionsLoading}
            onClose={() => setShowSessions(false)}
            onRefresh={isConnected ? loadSessions : undefined}
            onOpenDialog={() => setSessionsDialogOpen(true)}
          />
        )}

        <SessionsDialog
          open={sessionsDialogOpen}
          onOpenChange={setSessionsDialogOpen}
          cameraName={camera.name || camera.host}
          sessions={deviceSessions}
          total={sessionsTotal}
          loading={sessionsLoading && deviceSessions.length === 0}
          fetching={sessionsLoading}
          onRefresh={isConnected ? loadSessions : undefined}
        />
      </div>
    </div>
  );
}
