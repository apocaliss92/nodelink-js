import { DeviceInfoSection } from './DeviceInfoSection';
import { StreamProfileCard } from './StreamProfileCard';
import { ActionsGrid } from './ActionsGrid';
import type { CameraInfo, AvailableStream, StreamProfile, PreviewModalState } from './types';

interface CameraDetailPanelProps {
  camera: CameraInfo;
  streams: AvailableStream[];
  rtspServers: Array<{ cameraId: string; profile: StreamProfile; channel: number; status?: string; connections?: number }>;
  connecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onSetDebug: () => void;
  onOpenPtz: () => void;
  onOpenEvents: () => void;
  onStartStream: (profile: string) => void;
  onStopStream: (profile: string) => void;
  onOpenPreview: (state: PreviewModalState) => void;
  savingAutoStart: boolean;
  onToggleAutoStart: () => void;
}

export function CameraDetailPanel({
  camera,
  streams,
  rtspServers,
  connecting,
  onConnect,
  onDisconnect,
  onSetDebug,
  onOpenPtz,
  onOpenEvents,
  onStartStream,
  onStopStream,
  onOpenPreview,
  savingAutoStart,
  onToggleAutoStart,
}: CameraDetailPanelProps) {
  const isConnected = camera.status === 'connected';

  return (
    <div className="w-[340px] min-w-[340px] border-l border-[var(--color-border)] bg-[var(--color-background)]/50 overflow-y-auto p-4 hidden md:block">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[15px] font-semibold truncate">{camera.name || camera.host}</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] ${
            isConnected
              ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
              : 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]'
          }`}
        >
          {isConnected ? 'Online' : 'Offline'}
        </span>
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
              return (
                <StreamProfileCard
                  key={stream.profile}
                  cameraId={camera.id}
                  stream={stream}
                  rtspServer={server}
                  onStartStream={() => onStartStream(stream.profile)}
                  onStopStream={() => onStopStream(stream.profile)}
                  onPreview={() =>
                    onOpenPreview({
                      open: true,
                      kind: 'webrtc',
                      title: `${camera.name || camera.host} - ${stream.profile}`,
                      cameraName: camera.name || camera.host,
                      profile: stream.profile,
                    })
                  }
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
        onPtz={onOpenPtz}
        onEvents={onOpenEvents}
        onConnect={isConnected ? onDisconnect : onConnect}
        onDebug={onSetDebug}
        isConnected={isConnected}
        connecting={connecting}
        autoStart={camera.autoStart}
        savingAutoStart={savingAutoStart}
        onToggleAutoStart={onToggleAutoStart}
      />
    </div>
  );
}
