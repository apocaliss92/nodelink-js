import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { trpcQuery } from '../../api';
import type { DeviceSession } from './types';
import { SessionsList } from './SessionsList';

type SessionsPayload = { sessions: DeviceSession[]; total: number };

export function SessionsFloatingContent({ cameraId }: { cameraId: string }) {
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const data = await trpcQuery<SessionsPayload>('cameras.getSessions', { id: cameraId });
      setSessions(data?.sessions ?? []);
      setTotal(data?.total ?? 0);
    } catch {
      setSessions([]);
      setTotal(0);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [cameraId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <div className="flex flex-col gap-2 p-1">
      <div className="flex justify-end">
        <button
          type="button"
          disabled={loading || refreshing}
          onClick={() => void load(true)}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[10px] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>
      <SessionsList sessions={sessions} total={total} loading={loading} />
    </div>
  );
}
