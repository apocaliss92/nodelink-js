import { useState } from 'react';
import { Move, Bell, Users, Plug, Bug, Download, Power, Trash2, ScrollText } from 'lucide-react';

interface ActionsGridProps {
  onPtz: () => void;
  onEvents: () => void;
  onSessions: () => void;
  onLogs: () => void;
  onConnect: () => void;
  onDebug: () => void;
  onDump: () => void;
  onDelete: () => void;
  dumping: boolean;
  isConnected: boolean;
  connecting: boolean;
  autoStart: boolean;
  savingAutoStart: boolean;
  onToggleAutoStart: () => void;
}

export function ActionsGrid({
  onPtz,
  onEvents,
  onSessions,
  onLogs,
  onConnect,
  onDebug,
  onDump,
  onDelete,
  dumping,
  isConnected,
  connecting,
  autoStart,
  savingAutoStart,
  onToggleAutoStart,
}: ActionsGridProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const btnClass = "flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[11px] hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-50";

  return (
    <div className="rounded-lg bg-[var(--color-surface)] p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
        Actions
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button className={btnClass} onClick={onPtz}><Move size={13} /> PTZ</button>
        <button className={btnClass} onClick={onEvents}><Bell size={13} /> Events</button>
        <button className={btnClass} onClick={onSessions}><Users size={13} /> Sessions</button>
        <button className={btnClass} onClick={onLogs}><ScrollText size={13} /> Logs</button>
        <button className={btnClass} onClick={onConnect} disabled={connecting}>
          <Plug size={13} /> {isConnected ? 'Disconnect' : 'Connect'}
        </button>
        <button className={btnClass} onClick={onDebug}><Bug size={13} /> Debug</button>
        <button className={btnClass} onClick={onDump} disabled={dumping || !isConnected}>
          <Download size={13} /> {dumping ? 'Dumping...' : 'Dump'}
        </button>
        <button className={`${btnClass} col-span-2`} onClick={onToggleAutoStart} disabled={savingAutoStart || !isConnected}>
          <Power size={13} /> Auto-start: {autoStart ? 'ON' : 'OFF'}
        </button>
        {confirmDelete ? (
          <div className="col-span-2 flex gap-1.5">
            <button
              className={`${btnClass} flex-1 border-[var(--color-danger)]/50 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`}
              onClick={() => { setConfirmDelete(false); onDelete(); }}
            >
              <Trash2 size={13} /> Confirm delete
            </button>
            <button className={`${btnClass} flex-1`} onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            className={`${btnClass} col-span-2 border-[var(--color-danger)]/30 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={13} /> Delete camera
          </button>
        )}
      </div>
    </div>
  );
}
