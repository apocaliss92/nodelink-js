import { CameraCard } from './CameraCard';
import type { CameraInfo, AvailableStream, StreamProfile } from './types';

interface CameraGridProps {
  cameras: CameraInfo[];
  streamsByCamera: Record<string, AvailableStream[]>;
  rtspServers: Array<{ cameraId: string; profile: StreamProfile; status?: string; connections?: number }>;
  connectingByCamera: Record<string, boolean>;
  selectedCamera: CameraInfo | null;
  onSelectCamera: (camera: CameraInfo) => void;
  onConnect?: (camera: CameraInfo) => void;
  onOpenPtz?: (camera: CameraInfo) => void;
  onOpenEvents?: (camera: CameraInfo) => void;
  onOpenSessions?: (camera: CameraInfo) => void;
  onOpenDeviceControls?: (camera: CameraInfo) => void;
  onOpenStream?: (camera: CameraInfo, stream: AvailableStream) => void;
}

export function CameraGrid({
  cameras,
  streamsByCamera,
  rtspServers,
  connectingByCamera,
  selectedCamera,
  onSelectCamera,
  onConnect,
  onOpenPtz,
  onOpenEvents,
  onOpenSessions,
  onOpenDeviceControls,
  onOpenStream,
}: CameraGridProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-4 overflow-y-auto flex-1 content-start">
      {cameras.map((camera) => (
        <CameraCard
          key={camera.id}
          camera={camera}
          streams={streamsByCamera[camera.id] ?? []}
          rtspServers={rtspServers}
          selected={selectedCamera?.id === camera.id}
          connecting={connectingByCamera[camera.id] ?? false}
          onClick={() => onSelectCamera(camera)}
          onConnect={onConnect ? () => onConnect(camera) : undefined}
          onOpenPtz={onOpenPtz ? () => onOpenPtz(camera) : undefined}
          onOpenEvents={onOpenEvents ? () => onOpenEvents(camera) : undefined}
          onOpenSessions={onOpenSessions ? () => onOpenSessions(camera) : undefined}
          onOpenDeviceControls={onOpenDeviceControls ? () => onOpenDeviceControls(camera) : undefined}
          onOpenStream={onOpenStream ? (stream) => onOpenStream(camera, stream) : undefined}
        />
      ))}
    </div>
  );
}
