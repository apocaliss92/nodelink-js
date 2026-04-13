import { useEffect, useRef, useState } from 'react';
import { trpcMutation } from '../../api';
import { useConnectionLogs } from './hooks/useConnectionLogs';
import type { CameraInfo } from './types';

type ModeValue =
  | 'auto'
  | 'tcp'
  | 'udp:local-direct'
  | 'udp:local-broadcast'
  | 'udp:remote'
  | 'udp:relay'
  | 'udp:map';

const MODE_OPTIONS: { value: ModeValue; label: string }[] = [
  { value: 'auto',              label: 'Auto (TCP → UDP fallback)' },
  { value: 'tcp',               label: 'TCP' },
  { value: 'udp:local-direct',  label: 'UDP — local-direct' },
  { value: 'udp:local-broadcast', label: 'UDP — local-broadcast' },
  { value: 'udp:remote',        label: 'UDP — remote' },
  { value: 'udp:relay',         label: 'UDP — relay' },
  { value: 'udp:map',           label: 'UDP — map' },
];

function toModeValue(
  transport?: string,
  udpDiscoveryMethod?: string,
): ModeValue {
  if (transport === 'tcp') return 'tcp';
  if (transport === 'udp') {
    const method = udpDiscoveryMethod ?? 'local-direct';
    return `udp:${method}` as ModeValue;
  }
  return 'auto';
}

function fromModeValue(mode: ModeValue): {
  transport: 'auto' | 'tcp' | 'udp';
  udpDiscoveryMethod?: string;
} {
  if (mode === 'auto') return { transport: 'auto' };
  if (mode === 'tcp') return { transport: 'tcp' };
  const method = mode.replace('udp:', '');
  return { transport: 'udp', udpDiscoveryMethod: method };
}

const levelStyle: Record<string, string> = {
  error: 'bg-[var(--color-danger)]/20 text-[var(--color-danger)]',
  warn:  'bg-yellow-500/20 text-yellow-400',
  info:  'bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)]',
  debug: 'bg-[var(--color-surface-hover)] text-[var(--color-foreground-subtle)]',
};

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

interface ConnectionPanelProps {
  camera: CameraInfo;
  onClose: () => void;
}

export function ConnectionPanel({ camera, onClose }: ConnectionPanelProps) {
  const savedMode = toModeValue(camera.transport, camera.udpDiscoveryMethod);

  const [mode, setMode] = useState<ModeValue>(savedMode);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeActive, setProbeActive] = useState(false);
  const [saved, setSaved] = useState(false);

  const logs = useConnectionLogs(probeActive ? camera.id : null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const dirty = mode !== savedMode;

  useEffect(() => {
    // Refresh saved label when camera prop updates (after retryDetect saves new transport)
    setMode(toModeValue(camera.transport, camera.udpDiscoveryMethod));
  }, [camera.transport, camera.udpDiscoveryMethod]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  // Auto-stop spinner after probe completes (last log + small delay)
  useEffect(() => {
    if (!probing) return;
    const t = setTimeout(() => setProbing(false), 12000);
    return () => clearTimeout(t);
  }, [probing, logs.length]);

  const saveMode = async (target: ModeValue) => {
    setSaving(true);
    setSaved(false);
    try {
      const { transport, udpDiscoveryMethod } = fromModeValue(target);
      await trpcMutation('cameras.setTransport', {
        id: camera.id,
        transport,
        ...(udpDiscoveryMethod ? { udpDiscoveryMethod } : {}),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => void saveMode(mode);

  const handleProbe = async () => {
    if (dirty) await saveMode(mode);
    setProbeActive(true);
    setProbing(true);
    try {
      await trpcMutation('cameras.retryDetect', { id: camera.id });
    } finally {
      // Logs keep streaming; spinner auto-clears
    }
  };

  const savedLabel =
    MODE_OPTIONS.find((o) => o.value === savedMode)?.label ?? savedMode;

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-3 mt-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
          Connection Mode
        </span>
        <button
          onClick={onClose}
          className="text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] text-xs"
        >
          ✕
        </button>
      </div>

      {/* Saved mode */}
      <div className="flex items-center gap-2 mb-3 text-xs">
        <span className="text-[var(--color-foreground-muted)]">Saved:</span>
        <span className="font-medium text-[var(--color-foreground)]">{savedLabel}</span>
      </div>

      {/* Mode selector */}
      <div className="mb-3">
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as ModeValue)}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-2 py-1.5 text-xs text-[var(--color-foreground)] focus:outline-none"
        >
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Action buttons */}
      <div className="flex gap-1.5">
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-2 py-1.5 text-[11px] transition-colors disabled:opacity-40 hover:bg-[var(--color-surface-hover)]"
        >
          {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
        </button>
        <button
          onClick={() => void handleProbe()}
          disabled={probing}
          className="flex-1 rounded-md border border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10 px-2 py-1.5 text-[11px] text-[var(--color-primary)] transition-colors disabled:opacity-40 hover:bg-[var(--color-primary)]/20"
        >
          {probing ? 'Probing…' : dirty ? 'Save & Re-probe' : 'Re-probe'}
        </button>
      </div>

      {/* Inline log output during probe */}
      {probeActive && logs.length > 0 && (
        <div className="mt-3 max-h-52 overflow-y-auto flex flex-col gap-0.5 font-mono text-[10px]">
          {logs.map((entry, i) => (
            <div
              key={`${entry.ts}-${i}`}
              className="flex items-start gap-1.5 rounded px-1.5 py-0.5 hover:bg-[var(--color-surface-hover)]"
            >
              <span className="shrink-0 text-[var(--color-foreground-subtle)] tabular-nums">
                {formatTs(entry.ts)}
              </span>
              <span
                className={`shrink-0 rounded px-1 py-0 uppercase text-[9px] font-semibold leading-tight mt-px ${levelStyle[entry.level] ?? ''}`}
              >
                {entry.level}
              </span>
              <span className="break-all text-[var(--color-foreground)] leading-relaxed">
                {entry.msg}
              </span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
