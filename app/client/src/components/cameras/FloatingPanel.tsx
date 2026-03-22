// TODO: Replace with `export { FloatingPanel } from '@apocaliss92/camstack-ui'`
// when camstack-ui is published with the new FloatingPanel component.
// For now, this is a local copy.

import { useRef, useState, useCallback, useEffect, type ReactNode } from 'react';
import { X, Minimize2, Maximize2, GripHorizontal } from 'lucide-react';

export interface FloatingPanelProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  defaultWidth?: number;
  defaultHeight?: number;
  minWidth?: number;
  minHeight?: number;
  offsetIndex?: number;
  className?: string;
}

export function FloatingPanel({
  title,
  onClose,
  children,
  defaultWidth = 360,
  defaultHeight = 280,
  minWidth = 280,
  minHeight = 160,
  offsetIndex = 0,
  className,
}: FloatingPanelProps) {
  const [pos, setPos] = useState({ x: 80 + offsetIndex * 30, y: 80 + offsetIndex * 30 });
  const [size, setSize] = useState({ w: defaultWidth, h: defaultHeight });
  const [minimized, setMinimized] = useState(false);
  const dragging = useRef(false);
  const resizing = useRef(false);
  const offset = useRef({ x: 0, y: 0 });

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    offset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  }, [pos]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = true;
    offset.current = { x: e.clientX, y: e.clientY };
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (dragging.current) setPos({ x: e.clientX - offset.current.x, y: e.clientY - offset.current.y });
      if (resizing.current) {
        const dx = e.clientX - offset.current.x;
        const dy = e.clientY - offset.current.y;
        offset.current = { x: e.clientX, y: e.clientY };
        setSize(prev => ({ w: Math.max(minWidth, prev.w + dx), h: Math.max(minHeight, prev.h + dy) }));
      }
    };
    const onMouseUp = () => { dragging.current = false; resizing.current = false; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
  }, [minWidth, minHeight]);

  return (
    <div
      className={[
        'fixed z-50 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-elevated)] shadow-2xl flex flex-col overflow-hidden',
        className,
      ].filter(Boolean).join(' ')}
      style={{ left: pos.x, top: pos.y, width: minimized ? 280 : size.w, height: minimized ? 'auto' : size.h }}
    >
      <div
        onMouseDown={onDragStart}
        className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--color-border)] cursor-move select-none shrink-0 bg-[var(--color-surface)]"
      >
        <div className="flex items-center gap-2 min-w-0">
          <GripHorizontal size={12} className="text-[var(--color-foreground-subtle)] shrink-0" />
          <span className="text-[11px] font-medium truncate">{title}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => setMinimized(!minimized)} className="p-0.5 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)] transition-colors" title={minimized ? 'Restore' : 'Minimize'}>
            {minimized ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
          </button>
          <button onClick={onClose} className="p-0.5 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-foreground-muted)] hover:text-[var(--color-danger)] transition-colors" title="Close">
            <X size={12} />
          </button>
        </div>
      </div>
      {!minimized && (
        <div className="flex-1 min-h-0 overflow-y-auto relative">
          {children}
          <div
            onMouseDown={onResizeStart}
            className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
            style={{ background: 'linear-gradient(135deg, transparent 50%, var(--color-foreground-subtle) 50%)', opacity: 0.4 }}
          />
        </div>
      )}
    </div>
  );
}
