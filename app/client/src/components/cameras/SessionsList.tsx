import { groupDeviceSessionsByIp } from './groupDeviceSessionsByIp';
import type { DeviceSession } from './types';

export function SessionsList({
  sessions,
  total,
  loading,
}: {
  sessions: DeviceSession[];
  total: number;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[var(--color-foreground-muted)]">
        <span className="spinner" aria-hidden="true" />
        <span>Loading…</span>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="text-sm text-[var(--color-foreground-muted)]">
        No active sessions reported. Some firmware does not expose OnlineUserList over Baichuan, or no
        other clients are connected.
      </div>
    );
  }

  const byIp = groupDeviceSessionsByIp(sessions);

  return (
    <>
      <div className="text-[11px] text-[var(--color-foreground-muted)] mb-2">
        Device reports <span className="font-medium text-[var(--color-foreground)]">{total}</span>{' '}
        session(s) ·{' '}
        <span className="font-medium text-[var(--color-foreground)]">{byIp.length}</span> IP
        {byIp.length === 1 ? '' : 's'}
      </div>
      <div className="flex flex-col gap-2">
        {byIp.map((group) => (
          <div
            key={group.ip}
            className="rounded-lg overflow-hidden"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--border)',
            }}
          >
            <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-[var(--color-border)]/60 bg-[var(--color-surface)]/40">
              <span className="text-[11px] font-mono font-semibold text-[var(--color-foreground)]">
                {group.ip}
              </span>
              <span className="text-[10px] tabular-nums rounded px-1.5 py-0.5 bg-[var(--color-primary)]/15 text-[var(--color-primary)] shrink-0">
                {group.items.length} session{group.items.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="flex flex-col gap-1 px-2 py-1.5">
              {group.items.map((s, i) => (
                <div
                  key={`${group.ip}-${s.sessionId}-${s.userName}-${i}`}
                  className="flex flex-col gap-0.5 pl-1 border-l-2 border-[var(--color-border)]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium truncate">{s.userName}</span>
                    <span className="text-[10px] text-[var(--color-foreground-muted)] shrink-0">
                      level {s.level}
                    </span>
                  </div>
                  {s.sessionId > 0 && (
                    <div className="text-[10px] text-[var(--color-foreground-subtle)]">
                      session id {s.sessionId}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
