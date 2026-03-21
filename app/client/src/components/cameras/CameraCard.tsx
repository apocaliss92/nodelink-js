import { cn } from 'camstack-ui';
import type { CameraInfo, AvailableStream } from './types';

interface CameraCardProps {
  camera: CameraInfo;
  streams: AvailableStream[];
  selected: boolean;
  onClick: () => void;
}

export function CameraCard({ camera, streams, selected, onClick }: CameraCardProps) {
  const isOnline = camera.status === 'connected';

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border p-3 text-left transition-colors cursor-pointer',
        selected
          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]',
        !isOnline && !selected && 'opacity-50'
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium truncate">{camera.name || camera.host}</span>
        <span
          className={cn(
            'h-2 w-2 rounded-full shrink-0',
            isOnline ? 'bg-[var(--color-success)]' : 'bg-[var(--color-danger)]'
          )}
        />
      </div>
      <div className="text-[11px] text-[var(--color-foreground-muted)]">
        {camera.deviceInfo?.model && `${camera.deviceInfo.model} · `}{camera.host}
      </div>
      {streams.length > 0 && (
        <div className="flex gap-1 mt-2">
          {streams.map((s) => (
            <span
              key={s.profile}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px]',
                selected
                  ? 'bg-[var(--color-primary)]/20'
                  : 'bg-[var(--color-surface-hover)]'
              )}
            >
              {s.profile}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
