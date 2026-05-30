import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Reolink-style target size overlay for AI detect cfg (cmd_343).
 *
 * Renders the camera snapshot with two draggable, resizable rectangles
 * superimposed — one for the minimum target size, one for the maximum.
 * The user drags the box body to move it around the frame (position is
 * for visualization only, not persisted) and drags the bottom-right
 * corner handle to resize. Only the width/height (as 0..1 fractions of
 * the snapshot) are reported back to the parent — those are what
 * `setAiDetectionFull` writes to `minTargetWidth/Height` and
 * `maxTargetWidth/Height`.
 */

interface Size01 {
  width: number;
  height: number;
}

interface TargetSizeOverlayProps {
  snapshotUrl: string;
  minSize: Size01;
  maxSize: Size01;
  onMinChange: (size: Size01) => void;
  onMaxChange: (size: Size01) => void;
  disabled?: boolean;
}

interface RectState {
  /** Top-left X, 0..1 (UI only). */
  x: number;
  /** Top-left Y, 0..1 (UI only). */
  y: number;
  /** Width, 0..1 (persisted). */
  width: number;
  /** Height, 0..1 (persisted). */
  height: number;
}

interface DragSnapshot {
  rectInitial: RectState;
  pointerStartX: number;
  pointerStartY: number;
  /** Total drag area dims at drag-start (snapshot displayed pixels). */
  containerWidth: number;
  containerHeight: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * One draggable + resizable rectangle. Free placement on the snapshot;
 * only the width and height are mirrored to the parent via onSizeChange.
 */
function DraggableTargetRect({
  initialRect,
  size,
  onSizeChange,
  color,
  label,
  disabled,
  zIndex,
}: {
  initialRect: { x: number; y: number };
  size: Size01;
  onSizeChange: (size: Size01) => void;
  color: string;
  label: string;
  disabled?: boolean;
  zIndex: number;
}) {
  // Position is fully local — the parent doesn't care where the rect sits.
  const [pos, setPos] = useState({ x: initialRect.x, y: initialRect.y });
  const [draftSize, setDraftSize] = useState<Size01>(size);

  // Keep draftSize in sync with the parent (e.g. when refresh reloads).
  useEffect(() => {
    setDraftSize(size);
  }, [size.width, size.height]);

  const dragRef = useRef<{
    mode: "move" | "resize";
    snapshot: DragSnapshot;
  } | null>(null);

  const startDrag = useCallback(
    (
      e: React.PointerEvent<Element>,
      mode: "move" | "resize",
    ) => {
      if (disabled) return;
      e.stopPropagation();
      e.preventDefault();
      const parent = (e.currentTarget as Element).closest(
        "[data-target-canvas]",
      ) as HTMLElement | null;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      dragRef.current = {
        mode,
        snapshot: {
          rectInitial: { ...pos, ...draftSize },
          pointerStartX: e.clientX,
          pointerStartY: e.clientY,
          containerWidth: rect.width,
          containerHeight: rect.height,
        },
      };
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    },
    [pos, draftSize, disabled],
  );

  const onMove = useCallback((e: React.PointerEvent<Element>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { snapshot, mode } = drag;
    const dxFrac = (e.clientX - snapshot.pointerStartX) / snapshot.containerWidth;
    const dyFrac = (e.clientY - snapshot.pointerStartY) / snapshot.containerHeight;
    if (mode === "move") {
      // Clamp so the rect can't be dragged outside the snapshot.
      const nx = clamp01(snapshot.rectInitial.x + dxFrac);
      const ny = clamp01(snapshot.rectInitial.y + dyFrac);
      const maxX = 1 - snapshot.rectInitial.width;
      const maxY = 1 - snapshot.rectInitial.height;
      setPos({
        x: Math.min(nx, Math.max(0, maxX)),
        y: Math.min(ny, Math.max(0, maxY)),
      });
    } else {
      // Resize from bottom-right corner; min 1% so handle stays grabbable.
      const nw = clamp01(snapshot.rectInitial.width + dxFrac);
      const nh = clamp01(snapshot.rectInitial.height + dyFrac);
      const w = Math.max(0.01, Math.min(nw, 1 - snapshot.rectInitial.x));
      const h = Math.max(0.01, Math.min(nh, 1 - snapshot.rectInitial.y));
      setDraftSize({ width: w, height: h });
    }
  }, []);

  const endDrag = useCallback(
    (e: React.PointerEvent<Element>) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
      if (drag.mode === "resize") {
        // Commit the resized size to the parent now (drag end = save).
        onSizeChange(draftSize);
      }
    },
    [draftSize, onSizeChange],
  );

  // The displayed rect uses `pos` for placement and `draftSize` for size —
  // both in 0..1 of the parent container.
  const styleRect = {
    left: `${(pos.x * 100).toFixed(3)}%`,
    top: `${(pos.y * 100).toFixed(3)}%`,
    width: `${(draftSize.width * 100).toFixed(3)}%`,
    height: `${(draftSize.height * 100).toFixed(3)}%`,
    borderColor: color,
    zIndex,
  };

  return (
    <div
      role="presentation"
      data-target-rect-label={label}
      onPointerDown={(e) => startDrag(e, "move")}
      onPointerMove={onMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="absolute border-2 cursor-move bg-transparent pointer-events-auto"
      style={styleRect}
      title={`${label}: ${(draftSize.width * 100).toFixed(1)}% × ${(draftSize.height * 100).toFixed(1)}%`}
    >
      {/* Label badge */}
      <div
        className="absolute -top-5 left-0 text-[10px] font-mono px-1 py-0.5 rounded-sm whitespace-nowrap"
        style={{ background: color, color: "#000" }}
      >
        {label} · {(draftSize.width * 100).toFixed(1)} × {(draftSize.height * 100).toFixed(1)}%
      </div>
      {/* Resize handle: bottom-right corner */}
      <div
        role="presentation"
        onPointerDown={(e) => startDrag(e, "resize")}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        className="absolute right-0 bottom-0 w-3 h-3 cursor-nwse-resize translate-x-1/2 translate-y-1/2"
        style={{ background: color }}
      />
    </div>
  );
}

export function TargetSizeOverlay({
  snapshotUrl,
  minSize,
  maxSize,
  onMinChange,
  onMaxChange,
  disabled,
}: TargetSizeOverlayProps) {
  return (
    <div className="rounded-md border border-[var(--color-border)] overflow-hidden">
      <div
        data-target-canvas
        className="relative w-full aspect-video bg-[var(--color-background)]"
      >
        <img
          src={snapshotUrl}
          alt="snapshot"
          className="w-full h-full object-contain select-none pointer-events-none"
          draggable={false}
        />
        {/* Max rectangle (rendered first → bottom z-index) */}
        <DraggableTargetRect
          initialRect={{ x: 0.05, y: 0.05 }}
          size={maxSize}
          onSizeChange={onMaxChange}
          color="rgba(34, 197, 94, 0.85)" /* green-500 */
          label="MAX"
          disabled={disabled}
          zIndex={1}
        />
        {/* Min rectangle (rendered second → drawn on top of max) */}
        <DraggableTargetRect
          initialRect={{ x: 0.5, y: 0.45 }}
          size={minSize}
          onSizeChange={onMinChange}
          color="rgba(234, 179, 8, 0.95)" /* yellow-500 */
          label="MIN"
          disabled={disabled}
          zIndex={2}
        />
      </div>
      <div className="bg-[var(--color-background)] border-t border-[var(--color-border)] px-3 py-2 text-[10px] text-[var(--color-foreground-muted)]">
        Drag the body to move, drag the corner to resize. Only the
        rectangle dimensions are saved (`minTargetWidth/Height` and
        `maxTargetWidth/Height` as fractions of the frame) — the position
        on the snapshot is just for visualization.
      </div>
    </div>
  );
}
