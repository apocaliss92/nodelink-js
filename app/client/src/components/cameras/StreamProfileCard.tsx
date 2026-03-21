import { useState } from 'react';
import { Play, Square, Eye, Activity } from 'lucide-react';
import { trpcMutation } from '../../api';
import type { AvailableStream } from './types';

interface StreamProfileCardProps {
  cameraId: string;
  stream: AvailableStream;
  rtspServer?: { status?: string; connections?: number };
  onStartStream: () => void;
  onStopStream: () => void;
  onPreview: () => void;
}

export function StreamProfileCard({ cameraId, stream, rtspServer, onStartStream, onStopStream, onPreview }: StreamProfileCardProps) {
  const isActive = rtspServer?.status === 'running';
  const [diagStatus, setDiagStatus] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');

  const startAnalysis = async () => {
    setDiagStatus('running');
    try {
      await trpcMutation('diagnostics.start', {
        cameraId,
        profile: stream.profile,
        channel: stream.channel,
        durationMinutes: 5,
      });
      setDiagStatus('complete');
    } catch {
      setDiagStatus('error');
    }
  };

  return (
    <div className="rounded-md border border-[var(--color-border)] p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium capitalize">{stream.profile} Stream</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${isActive ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]' : 'bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)]'}`}>
          {isActive ? 'active' : 'idle'}
        </span>
      </div>
      {stream.resolution && (
        <div className="text-[11px] text-[var(--color-foreground-muted)]">
          {stream.resolution}{stream.codec ? ` · ${stream.codec}` : ''}
        </div>
      )}
      <div className="flex flex-wrap gap-1 mt-1.5">
        {isActive ? (
          <>
            <button onClick={onPreview} className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface)] transition-colors">
              <Eye size={10} /> Preview
            </button>
            <button onClick={onStopStream} className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] bg-[var(--color-danger)]/15 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/25 transition-colors">
              <Square size={10} /> Stop
            </button>
          </>
        ) : (
          <button onClick={onStartStream} className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] bg-[var(--color-primary)]/15 text-[var(--color-primary)] hover:bg-[var(--color-primary)]/25 transition-colors">
            <Play size={10} /> Start
          </button>
        )}
        {diagStatus === 'idle' && (
          <button onClick={() => void startAnalysis()} className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface)] transition-colors">
            <Activity size={10} /> Analyze
          </button>
        )}
        {diagStatus === 'running' && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--color-warning)] px-2 py-0.5">
            <Activity size={10} /> Analyzing...
          </span>
        )}
        {diagStatus === 'complete' && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--color-success)] px-2 py-0.5">
            <Activity size={10} /> Done
          </span>
        )}
        {diagStatus === 'error' && (
          <button onClick={() => setDiagStatus('idle')} className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] bg-[var(--color-danger)]/15 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/25 transition-colors">
            <Activity size={10} /> Retry
          </button>
        )}
      </div>
    </div>
  );
}
