import { CameraCard } from './CameraCard';
import type { CameraInfo, AvailableStream } from './types';

interface CameraGridProps {
  cameras: CameraInfo[];
  streamsByCamera: Record<string, AvailableStream[]>;
  selectedCamera: CameraInfo | null;
  onSelectCamera: (camera: CameraInfo) => void;
}

export function CameraGrid({ cameras, streamsByCamera, selectedCamera, onSelectCamera }: CameraGridProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-4 overflow-y-auto flex-1 content-start">
      {cameras.map((camera) => (
        <CameraCard
          key={camera.id}
          camera={camera}
          streams={streamsByCamera[camera.id] ?? []}
          selected={selectedCamera?.id === camera.id}
          onClick={() => onSelectCamera(camera)}
        />
      ))}
    </div>
  );
}
