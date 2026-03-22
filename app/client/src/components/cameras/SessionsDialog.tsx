import { RefreshCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@apocaliss92/camstack-ui';
import type { DeviceSession } from './types';
import { SessionsList } from './SessionsList';

export function SessionsDialog({
  open,
  onOpenChange,
  cameraName,
  sessions,
  total,
  loading,
  fetching = false,
  onRefresh,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cameraName: string;
  sessions: DeviceSession[];
  total: number;
  loading: boolean;
  fetching?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        width="md"
        className="max-h-[80vh] overflow-y-auto bg-[var(--color-background-elevated)] text-[var(--color-foreground)] border-[var(--color-border)]"
      >
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 pr-8">
            <DialogTitle>Device sessions – {cameraName}</DialogTitle>
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                disabled={fetching}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[10px] hover:bg-[var(--color-surface-hover)] disabled:opacity-50 shrink-0"
              >
                <RefreshCw size={10} className={fetching ? 'animate-spin' : ''} />
                Refresh
              </button>
            )}
          </div>
        </DialogHeader>
        <SessionsList sessions={sessions} total={total} loading={loading} />
      </DialogContent>
    </Dialog>
  );
}
