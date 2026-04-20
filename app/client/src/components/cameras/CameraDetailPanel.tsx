import { useState, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
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
import { trpcQuery, trpcMutation } from '../../api';
import { withAuthTokenQuery, getCameraDisplayName, getStreamName, getWebrtcStreamName } from './utils';
import type {
  CameraInfo,
  AvailableStream,
  StreamProfile,
  PreviewModalState,
  ControlsState,
  CameraEvent,
  DeviceSession,
} from './types';

type SessionsPayload = { sessions: DeviceSession[]; total: number };

interface CameraDetailPanelProps {
  camera: CameraInfo;
  streams: AvailableStream[];
  rtspServers: Array<{
    cameraId: string;
    profile: StreamProfile;
    channel: number;
    status?: string;
    connections?: number;
    rtspUrl?: string;
    go2rtcStreamName?: string;
  }>;
  connecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onDelete: () => void;
  onSetDebug: () => void;
  onOpenPreview: (state: PreviewModalState) => void;
  savingAutoStart: boolean;
  onToggleAutoStart: () => void;
  go2rtcApiPort: number | null;
  go2rtcRtspPort: number | null;
  serviceIp: string;
  restreamer?: "go2rtc" | "local";
  localRtspPort?: number | null;
  onClose: () => void;
}

export function CameraDetailPanel({
  camera,
  streams,
  rtspServers,
  connecting,
  onConnect,
  onDisconnect,
  onDelete,
  onSetDebug,
  onOpenPreview,
  savingAutoStart,
  onToggleAutoStart,
  go2rtcApiPort,
  go2rtcRtspPort,
  serviceIp,
  restreamer,
  localRtspPort,
  onClose,
}: CameraDetailPanelProps) {
  const isConnected = camera.status === 'connected';
  const [showPtz, setShowPtz] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showConnection, setShowConnection] = useState(false);
  const [sessionsDialogOpen, setSessionsDialogOpen] = useState(false);

  const connLogs = useConnectionLogs(showLogs ? camera.id : null);
  const [localLogs, setLocalLogs] = useState(connLogs);
  // Sync incoming SSE logs into local state so Clear can wipe them client-side
  useEffect(() => { setLocalLogs(connLogs); }, [connLogs]);
  const [controlsState, setControlsState] = useState<ControlsState>(null);
  const [events, setEvents] = useState<CameraEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [deviceSessions, setDeviceSessions] = useState<DeviceSession[]>([]);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [dumping, setDumping] = useState(false);

  const handleDump = useCallback(async () => {
    setDumping(true);
    try {
      const result = await trpcMutation<{ token: string; filename: string }>(
        "cameras.dump",
        { cameraId: camera.id },
      );
      // Trigger browser download via the token endpoint
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
  }, [camera.id]);

  // Fetch controls state when camera connects or wakes up.
  // sleepStatus intentionally excluded: server returns isSleeping=true with cached
  // capabilities when the camera is idle-disconnected, so polling on sleep transitions
  // would create a reconnect loop. The state refreshes on the next connect event.
  useEffect(() => {
    if (!isConnected) return;
    trpcQuery<ControlsState>('cameras.getControlsState', { id: camera.id })
      .then((st) => setControlsState(st ?? null))
      .catch(() => setControlsState(null));
  }, [camera.id, isConnected]);

  // Fetch events when events panel opens
  useEffect(() => {
    if (!showEvents || !isConnected) return;
    setEventsLoading(true);
    trpcQuery<CameraEvent[]>('events.getRecent', { cameraId: camera.id })
      .then((list) => setEvents(list ?? []))
      .catch(() => setEvents([]))
      .finally(() => setEventsLoading(false));
  }, [showEvents, camera.id, isConnected]);

  // SSE for real-time events
  useEffect(() => {
    if (!showEvents || !isConnected) return;
    const sseUrl = withAuthTokenQuery(`${window.location.origin}/api/events/sse`);
    const es = new EventSource(sseUrl);
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data as string) as CameraEvent;
        if (payload.cameraId === camera.id) {
          setEvents((prev) => [payload, ...prev].slice(0, 50));
        }
      } catch {
        // ignore malformed events
      }
    };
    return () => es.close();
  }, [showEvents, camera.id, isConnected]);

  const loadSessions = useCallback(() => {
    if (!isConnected) return;
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
  }, [camera.id, isConnected]);

  useEffect(() => {
    if ((!showSessions && !sessionsDialogOpen) || !isConnected) return;
    loadSessions();
  }, [showSessions, sessionsDialogOpen, isConnected, loadSessions]);

  const handlePtzStart = useCallback(
    (cmd: string) => {
      void trpcMutation('cameras.ptzStart', { id: camera.id, command: cmd });
    },
    [camera.id],
  );

  const handlePtzStop = useCallback(
    (cmd: string) => {
      void trpcMutation('cameras.ptzStop', { id: camera.id, command: cmd });
    },
    [camera.id],
  );

  const handleGotoPreset = useCallback(
    (presetId: number) => () => {
      void trpcMutation('cameras.gotoPreset', { id: camera.id, presetId });
    },
    [camera.id],
  );

  return (
    <div className="w-[340px] min-w-[340px] border-l border-[var(--color-border)] bg-[var(--color-background)]/50 overflow-y-auto p-4 hidden md:block">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 gap-2">
        <h2 className="text-[15px] font-semibold truncate">{camera.name || camera.host}</h2>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              isConnected
                ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
                : 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]'
            }`}
          >
            {isConnected ? 'Online' : 'Offline'}
          </span>
          <button
            onClick={onClose}
            className="p-0.5 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] transition-colors"
            title="Close panel"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="mb-3">
        <DeviceInfoSection camera={camera} />
      </div>

      {/* Stream Profiles */}
      <div className="rounded-lg bg-[var(--color-surface)] p-3 mb-3">
        <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
          Stream Profiles
        </div>
        <div className="flex flex-col gap-2">
          {streams.length > 0 ? (
            streams.map((stream) => {
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
                    onOpenPreview({
                      open: true,
                      kind: 'webrtc',
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
                  localRtspPort={localRtspPort}
                />
              );
            })
          ) : (
            <div className="text-xs text-[var(--color-foreground-muted)] py-2">
              {isConnected ? 'Discovering streams...' : 'Connect to discover streams'}
            </div>
          )}
        </div>
      </div>

      <ActionsGrid
        onPtz={() => setShowPtz((v) => !v)}
        onEvents={() => setShowEvents((v) => !v)}
        onSessions={() => setShowSessions((v) => !v)}
        onLogs={() => setShowLogs((v) => !v)}
        onConnection={() => setShowConnection((v) => !v)}
        onConnect={isConnected ? onDisconnect : onConnect}
        onDebug={onSetDebug}
        onDump={handleDump}
        onDelete={onDelete}
        dumping={dumping}
        isConnected={isConnected}
        connecting={connecting}
        autoStart={camera.autoStart}
        savingAutoStart={savingAutoStart}
        onToggleAutoStart={onToggleAutoStart}
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
  );
}
