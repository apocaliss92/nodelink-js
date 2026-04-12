import { useEffect, useRef, useState } from 'react';
import type { ConnLogEntry } from './hooks/useConnectionLogs';

interface CameraLogsPanelProps {
  cameraName: string;
  logs: ConnLogEntry[];
  onClose: () => void;
  onClear: () => void;
}

const levelStyle: Record<ConnLogEntry['level'], string> = {
  error: 'bg-[var(--color-danger)]/20 text-[var(--color-danger)]',
  warn:  'bg-yellow-500/20 text-yellow-400',
  info:  'bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)]',
  debug: 'bg-[var(--color-surface-hover)] text-[var(--color-foreground-subtle)]',
};

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function CameraLogsPanel({ cameraName, logs, onClose, onClear }: CameraLogsPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = logs
      .map((e) => `${formatTs(e.ts)} [${e.level.toUpperCase()}] ${e.msg}`)
      .join('\n');
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // Auto-scroll to bottom on new log entries
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-3 mt-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
          Logs – {cameraName}
        </span>
        <div className="flex items-center gap-2">
          {logs.length > 0 && (
            <>
              <button
                onClick={handleCopy}
                className="text-[10px] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] transition-colors"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
              <button
                onClick={onClear}
                className="text-[10px] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] transition-colors"
              >
                Clear
              </button>
            </>
          )}
          <button
            onClick={onClose}
            className="text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] text-xs"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto flex flex-col gap-0.5 font-mono text-[10px]">
        {logs.length === 0 ? (
          <div className="text-[var(--color-foreground-muted)] py-2 text-center">
            No logs yet. Connect the camera to see activity.
          </div>
        ) : (
          logs.map((entry, i) => (
            <div
              key={`${entry.ts}-${i}`}
              className="flex items-start gap-1.5 rounded px-1.5 py-0.5 hover:bg-[var(--color-surface-hover)]"
            >
              <span className="shrink-0 text-[var(--color-foreground-subtle)] tabular-nums">
                {formatTs(entry.ts)}
              </span>
              <span
                className={`shrink-0 rounded px-1 py-0 uppercase text-[9px] font-semibold leading-tight mt-px ${levelStyle[entry.level]}`}
              >
                {entry.level}
              </span>
              <span className="break-all text-[var(--color-foreground)] leading-relaxed">
                {entry.msg}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
