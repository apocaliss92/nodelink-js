import { Move, Bell, Plug, Bug } from 'lucide-react';

interface ActionsGridProps {
  onPtz: () => void;
  onEvents: () => void;
  onConnect: () => void;
  onDebug: () => void;
  isConnected: boolean;
  connecting: boolean;
}

export function ActionsGrid({ onPtz, onEvents, onConnect, onDebug, isConnected, connecting }: ActionsGridProps) {
  const btnClass = "flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[11px] hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-50";

  return (
    <div className="rounded-lg bg-[var(--color-surface)] p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
        Actions
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button className={btnClass} onClick={onPtz}><Move size={13} /> PTZ</button>
        <button className={btnClass} onClick={onEvents}><Bell size={13} /> Events</button>
        <button className={btnClass} onClick={onConnect} disabled={connecting}>
          <Plug size={13} /> {isConnected ? 'Disconnect' : 'Connect'}
        </button>
        <button className={btnClass} onClick={onDebug}><Bug size={13} /> Debug</button>
      </div>
    </div>
  );
}
