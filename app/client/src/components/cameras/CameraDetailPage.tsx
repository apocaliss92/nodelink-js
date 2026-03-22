import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DeviceInfoSection } from './DeviceInfoSection';
import { StreamProfileCard } from './StreamProfileCard';
import { ActionsGrid } from './ActionsGrid';
import { PtzPanel } from './PtzPanel';
import { EventsPanel } from './EventsPanel';
import { useCamerasContext } from './CamerasContext';
import { trpcQuery, trpcMutation } from '../../api';
import { withAuthTokenQuery } from './utils';
import type { ControlsState, CameraEvent } from './types';

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
    serviceIp,
  } = useCamerasContext();

  const [showPtz, setShowPtz] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [controlsState, setControlsState] = useState<ControlsState>(null);
  const [events, setEvents] = useState<CameraEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  const camera = cameras.find((c) => (c.name || c.host) === cameraName);
  const isConnected = camera?.status === 'connected';

  // Fetch controls state when camera is connected and awake
  useEffect(() => {
    if (!camera || !isConnected || camera.sleepStatus === 'sleeping') return;
    trpcQuery<ControlsState>('cameras.getControlsState', { id: camera.id })
      .then((st) => setControlsState(st ?? null))
      .catch(() => setControlsState(null));
  }, [camera?.id, isConnected, camera?.sleepStatus]);

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
              return (
                <StreamProfileCard
                  key={stream.profile}
                  cameraId={camera.id}
                  stream={stream}
                  rtspServer={server}
                  onStartStream={() => void trpcMutation('rtsp.start', { cameraId: camera.id, profile: stream.profile, channel: stream.channel })}
                  onStopStream={() => void trpcMutation('rtsp.stop', { cameraId: camera.id, profile: stream.profile, channel: stream.channel })}
                  onPreview={() => {
                    setPreviewModal({
                      open: true,
                      kind: 'webrtc' as const,
                      title: `${camera.name || camera.host} - ${stream.profile}`,
                      cameraName: camera.sanitizedName ?? camera.name ?? camera.host,
                      profile: stream.profile,
                      streamName: server?.go2rtcStreamName ?? `${camera.sanitizedName ?? camera.name ?? camera.host}_${stream.profile}`,
                      go2rtcApiPort,
                      serviceIp,
                    });
                  }}
                  cameraName={camera.sanitizedName ?? camera.name ?? camera.host}
                  go2rtcApiPort={go2rtcApiPort}
                  serviceIp={serviceIp}
                />
              );
            })}
          </div>
        </div>

        <ActionsGrid
          onPtz={() => setShowPtz((v) => !v)}
          onEvents={() => setShowEvents((v) => !v)}
          onConnect={isConnected ? () => disconnect(camera.id) : () => connect(camera.id)}
          onDebug={() => setCameraDebug(camera.id, !camera.debugLogs)}
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
      </div>
    </div>
  );
}
