import { useState, useEffect } from 'react';
import { trpcQuery } from '../../api';
import { withAuthTokenQuery, eventBadgeColor } from './utils';
import type { CameraEvent } from './types';

interface EventsFloatingContentProps {
  cameraId: string;
}

export function EventsFloatingContent({ cameraId }: EventsFloatingContentProps) {
  const [events, setEvents] = useState<CameraEvent[]>([]);
  const [loading, setLoading] = useState(true);

  // Initial fetch
  useEffect(() => {
    setLoading(true);
    trpcQuery<CameraEvent[]>('events.getRecent', { cameraId })
      .then((list) => setEvents(list ?? []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [cameraId]);

  // SSE for real-time events
  useEffect(() => {
    const sseUrl = withAuthTokenQuery(`${window.location.origin}/api/events/sse`);
    const es = new EventSource(sseUrl);
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data as string) as CameraEvent;
        if (payload.cameraId === cameraId) {
          setEvents((prev) => [payload, ...prev].slice(0, 50));
        }
      } catch {
        // ignore malformed events
      }
    };
    return () => es.close();
  }, [cameraId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-[var(--color-foreground-muted)]">
        <span className="spinner" aria-hidden="true" />
        <span>Loading...</span>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="p-3 text-xs text-[var(--color-foreground-muted)]">
        No events. Events will appear with motion, doorbell, AI, etc.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 p-3">
      {events.map((ev, i) => (
        <div
          key={`${ev.timestamp}-${i}`}
          className="flex items-center justify-between rounded-lg px-2.5 py-2"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid var(--border)',
          }}
        >
          <span
            className="text-xs font-semibold capitalize rounded-md px-2 py-1"
            style={{
              minWidth: 80,
              background: eventBadgeColor(ev.type),
              color: 'var(--text)',
            }}
          >
            {ev.type === 'stream_clients' &&
            ev.streamType &&
            ev.profile != null &&
            ev.clientCount != null
              ? `${ev.streamType}/${ev.profile}: ${ev.clientCount}`
              : ev.type.replace(/_/g, ' ')}
          </span>
          <span className="text-xs opacity-90">
            {ev.timestampIso ? new Date(ev.timestampIso).toLocaleString() : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}
