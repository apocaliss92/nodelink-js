import { Maximize2, RefreshCw } from 'lucide-react';
import type { DeviceSession } from './types';
import { SessionsList } from './SessionsList';

interface SessionsPanelProps {
  cameraName: string;
  sessions: DeviceSession[];
  total: number;
  /** True while list is empty and first load in progress */
  loading: boolean;
  /** True while any request in flight (refresh spin) */
  fetching?: boolean;
  onClose: () => void;
  onRefresh?: () => void;
  /** Optional: open full dialog (same data). */
  onOpenDialog?: () => void;
}

export function SessionsPanel({
  cameraName,
  sessions,
  total,
  loading,
  fetching = false,
  onClose,
  onRefresh,
  onOpenDialog,
}: SessionsPanelProps) {
  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-3 mt-3 max-h-72 overflow-y-auto">
      <div className="flex items-center justify-between mb-2 gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
          Device sessions – {cameraName}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={fetching}
              className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw size={12} className={fetching ? 'animate-spin' : ''} />
            </button>
          )}
          {onOpenDialog && (
            <button
              type="button"
              onClick={onOpenDialog}
              className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]"
              title="Open in dialog"
            >
              <Maximize2 size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] text-xs"
          >
            ✕
          </button>
        </div>
      </div>
      <SessionsList sessions={sessions} total={total} loading={loading} />
    </div>
  );
}
