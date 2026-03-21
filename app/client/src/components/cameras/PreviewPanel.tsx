import { useRef, useState, useCallback, useEffect } from 'react';
import { X, Minimize2, Maximize2, GripHorizontal } from 'lucide-react';
import { WebRTCInlinePlayer } from './WebRTCInlinePlayer';
import type { PreviewModalState } from './types';

interface PreviewPanelProps {
  state: PreviewModalState & { open: true };
  onClose: () => void;
}

const MIN_W = 320;
const MIN_H = 200;
const DEFAULT_W = 480;
const DEFAULT_H = 310;

export function PreviewPanel({ state, onClose }: PreviewPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 80, y: 80 });
  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  const [minimized, setMinimized] = useState(false);
  const dragging = useRef(false);
  const resizing = useRef(false);
  const offset = useRef({ x: 0, y: 0 });

  // Drag handlers
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    offset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  }, [pos]);

  // Resize handlers
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = true;
    offset.current = { x: e.clientX, y: e.clientY };
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (dragging.current) {
        setPos({ x: e.clientX - offset.current.x, y: e.clientY - offset.current.y });
      }
      if (resizing.current) {
        const dx = e.clientX - offset.current.x;
        const dy = e.clientY - offset.current.y;
        offset.current = { x: e.clientX, y: e.clientY };
        setSize(prev => ({
          w: Math.max(MIN_W, prev.w + dx),
          h: Math.max(MIN_H, prev.h + dy),
        }));
      }
    };
    const onMouseUp = () => {
      dragging.current = false;
      resizing.current = false;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return (
    <div
      ref={panelRef}
      className="fixed z-50 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-elevated)] shadow-2xl flex flex-col overflow-hidden"
      style={{
        left: pos.x,
        top: pos.y,
        width: minimized ? 280 : size.w,
        height: minimized ? 'auto' : size.h,
      }}
    >
      {/* Title bar — draggable */}
      <div
        onMouseDown={onDragStart}
        className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--color-border)] cursor-move select-none shrink-0 bg-[var(--color-surface)]"
      >
        <div className="flex items-center gap-2 min-w-0">
          <GripHorizontal size={12} className="text-[var(--color-foreground-subtle)] shrink-0" />
          <span className="text-[11px] font-medium truncate">{state.title}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setMinimized(!minimized)}
            className="p-0.5 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)] transition-colors"
            title={minimized ? 'Restore' : 'Minimize'}
          >
            {minimized ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
          </button>
          <button
            onClick={onClose}
            className="p-0.5 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-foreground-muted)] hover:text-[var(--color-danger)] transition-colors"
            title="Close"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Player content */}
      {!minimized && (
        <div className="flex-1 min-h-0 bg-black relative">
          <WebRTCInlinePlayer
            streamName={state.streamName ?? `${state.cameraName}_${state.profile}`}
            go2rtcApiPort={state.go2rtcApiPort}
            serviceIp={state.serviceIp}
          />

          {/* Resize handle — bottom-right corner */}
          <div
            onMouseDown={onResizeStart}
            className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
            style={{
              background: 'linear-gradient(135deg, transparent 50%, var(--color-foreground-subtle) 50%)',
              opacity: 0.4,
            }}
          />
        </div>
      )}
    </div>
  );
}
