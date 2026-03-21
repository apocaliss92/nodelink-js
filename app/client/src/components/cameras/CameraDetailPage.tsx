import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DeviceInfoSection } from './DeviceInfoSection';
import { StreamProfileCard } from './StreamProfileCard';
import { ActionsGrid } from './ActionsGrid';
import { useCamerasContext } from './CamerasContext';
import { trpcMutation } from '../../api';

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
  } = useCamerasContext();

  const camera = cameras.find((c) => (c.name || c.host) === cameraName);

  if (!camera) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-foreground-muted)]">
        Camera not found
      </div>
    );
  }

  const streams = streamsByCamera[camera.id] ?? [];
  const isConnected = camera.status === 'connected';

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
                  onPreview={() =>
                    setPreviewModal({
                      open: true,
                      kind: 'webrtc' as const,
                      title: `${camera.name || camera.host} - ${stream.profile}`,
                      cameraName: camera.name || camera.host,
                      profile: stream.profile,
                    })
                  }
                />
              );
            })}
          </div>
        </div>

        <ActionsGrid
          onPtz={() => {}}
          onEvents={() => {}}
          onConnect={isConnected ? () => disconnect(camera.id) : () => connect(camera.id)}
          onDebug={() => setCameraDebug(camera.id, !camera.debugLogs)}
          isConnected={isConnected}
          connecting={connectingByCamera[camera.id] ?? false}
          autoStart={camera.autoStart}
          savingAutoStart={savingAutoStart[camera.id] ?? false}
          onToggleAutoStart={() => void setAutoStartForCamera(camera, !camera.autoStart)}
        />
      </div>
    </div>
  );
}
