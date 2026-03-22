import { cn } from '@apocaliss92/camstack-ui';
import { Move, Bell, Lightbulb, Play } from 'lucide-react';
import type { CameraInfo, AvailableStream } from './types';

interface CameraCardProps {
  camera: CameraInfo;
  streams: AvailableStream[];
  selected: boolean;
  onClick: () => void;
  onOpenPtz?: () => void;
  onOpenEvents?: () => void;
  onOpenDeviceControls?: () => void;
  onOpenStream?: (stream: AvailableStream) => void;
}

export function CameraCard({
  camera,
  streams,
  selected,
  onClick,
  onOpenPtz,
  onOpenEvents,
  onOpenDeviceControls,
  onOpenStream,
}: CameraCardProps) {
  const isOnline = camera.status === 'connected';

  const iconBtnClass =
    'p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-foreground-subtle)] hover:text-[var(--color-foreground)] transition-colors';

  return (
    <div
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border p-3 text-left transition-colors cursor-pointer',
        selected
          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]',
        !isOnline && !selected && 'opacity-50',
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium truncate">{camera.name || camera.host}</span>
        <span
          className={cn(
            'h-2 w-2 rounded-full shrink-0',
            isOnline ? 'bg-[var(--color-success)]' : 'bg-[var(--color-danger)]',
          )}
        />
      </div>
      <div className="text-[11px] text-[var(--color-foreground-muted)]">
        {camera.deviceInfo?.model && `${camera.deviceInfo.model} · `}
        {camera.host}
      </div>

      {/* Stream badges — clickable to open a stream floating panel */}
      {streams.length > 0 && (
        <div className="flex gap-1 mt-2">
          {streams.map((s) => (
            <button
              key={s.profile}
              onClick={(e) => {
                e.stopPropagation();
                onOpenStream?.(s);
              }}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] hover:opacity-80 transition-opacity flex items-center gap-0.5',
                selected ? 'bg-[var(--color-primary)]/20' : 'bg-[var(--color-surface-hover)]',
              )}
              title={`Open ${s.profile} stream`}
            >
              <Play size={8} />
              {s.profile}
            </button>
          ))}
        </div>
      )}

      {/* Quick action icons — only shown for online cameras */}
      {isOnline && (onOpenPtz || onOpenDeviceControls || onOpenEvents) && (
        <div className="flex items-center gap-0.5 mt-2 -mb-1">
          {onOpenPtz && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenPtz();
              }}
              className={iconBtnClass}
              title="PTZ Controls"
            >
              <Move size={12} />
            </button>
          )}
          {onOpenDeviceControls && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenDeviceControls();
              }}
              className={iconBtnClass}
              title="Device Controls"
            >
              <Lightbulb size={12} />
            </button>
          )}
          {onOpenEvents && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenEvents();
              }}
              className={iconBtnClass}
              title="Events"
            >
              <Bell size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
