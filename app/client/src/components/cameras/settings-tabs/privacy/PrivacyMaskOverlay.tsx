import { useCallback, useRef } from "react";
import { X } from "lucide-react";

/**
 * Snapshot overlay with up to N persistable rectangles.
 *
 * Used by the Privacy Mask tab to edit `<shelterList>` (cmd_id 52/53).
 * Unlike the AI target-size rectangles (where only width/height matter
 * and the position is for visualization), each shelter rect carries an
 * x, y, width, height — all in 0..1 of the camera mask canvas (which the
 * lib decodes from the camera's wire-format `(pixel << 16) | canvas`
 * encoding via `extractCanvasFromShelterXml`).
 *
 * Each rect supports:
 *   - drag the body to move
 *   - drag the bottom-right corner to resize
 *   - click the close button to disable (and zero out)
 */

export interface MaskRect {
  /** Stable id (0..maxNum-1). */
  id: number;
  enable: boolean;
  /** 0..1 of the camera mask canvas. */
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PrivacyMaskOverlayProps {
  snapshotUrl: string;
  rects: MaskRect[];
  onChange: (next: MaskRect[]) => void;
  disabled?: boolean;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

interface DragSnapshot {
  rectInitial: MaskRect;
  pointerStartX: number;
  pointerStartY: number;
  containerWidth: number;
  containerHeight: number;
  mode: "move" | "resize";
}

/**
 * Single draggable + resizable shelter rectangle.
 */
function ShelterRectBox({
  rect,
  onUpdate,
  onRemove,
  disabled,
}: {
  rect: MaskRect;
  onUpdate: (next: MaskRect) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const dragRef = useRef<DragSnapshot | null>(null);
  // We mirror the rect into a draft to make dragging smooth (avoid
  // round-trips through the parent on every pointer move). Commit happens
  // on pointer up.
  const draftRef = useRef<MaskRect>(rect);
  draftRef.current = rect;

  const startDrag = useCallback(
    (e: React.PointerEvent<Element>, mode: "move" | "resize") => {
      if (disabled) return;
      e.stopPropagation();
      e.preventDefault();
      const parent = (e.currentTarget as Element).closest(
        "[data-mask-canvas]",
      ) as HTMLElement | null;
      if (!parent) return;
      const r = parent.getBoundingClientRect();
      dragRef.current = {
        rectInitial: { ...draftRef.current },
        pointerStartX: e.clientX,
        pointerStartY: e.clientY,
        containerWidth: r.width,
        containerHeight: r.height,
        mode,
      };
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    },
    [disabled],
  );

  const onMove = useCallback(
    (e: React.PointerEvent<Element>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dxFrac = (e.clientX - drag.pointerStartX) / drag.containerWidth;
      const dyFrac = (e.clientY - drag.pointerStartY) / drag.containerHeight;
      const init = drag.rectInitial;
      if (drag.mode === "move") {
        const nx = clamp01(init.x + dxFrac);
        const ny = clamp01(init.y + dyFrac);
        const maxX = 1 - init.width;
        const maxY = 1 - init.height;
        onUpdate({
          ...init,
          x: Math.min(nx, Math.max(0, maxX)),
          y: Math.min(ny, Math.max(0, maxY)),
        });
      } else {
        // Resize from bottom-right corner.
        const nw = clamp01(init.width + dxFrac);
        const nh = clamp01(init.height + dyFrac);
        onUpdate({
          ...init,
          width: Math.max(0.01, Math.min(nw, 1 - init.x)),
          height: Math.max(0.01, Math.min(nh, 1 - init.y)),
        });
      }
    },
    [onUpdate],
  );

  const endDrag = useCallback((e: React.PointerEvent<Element>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  }, []);

  if (!rect.enable) return null;

  const style = {
    left: `${(rect.x * 100).toFixed(3)}%`,
    top: `${(rect.y * 100).toFixed(3)}%`,
    width: `${(rect.width * 100).toFixed(3)}%`,
    height: `${(rect.height * 100).toFixed(3)}%`,
  };

  return (
    <div
      role="presentation"
      data-mask-rect-id={rect.id}
      onPointerDown={(e) => startDrag(e, "move")}
      onPointerMove={onMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="absolute border-2 border-red-500 bg-red-500/20 cursor-move pointer-events-auto"
      style={style}
      title={`Zone ${rect.id}: ${(rect.width * 100).toFixed(1)}% × ${(rect.height * 100).toFixed(1)}%`}
    >
      <div
        className="absolute -top-5 left-0 text-[10px] font-mono bg-red-500 text-white px-1 py-0.5 rounded-sm whitespace-nowrap"
      >
        Zone {rect.id}
      </div>
      {!disabled && (
        <button
          type="button"
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center pointer-events-auto cursor-pointer hover:bg-red-600"
          title="Remove this zone"
        >
          <X size={10} />
        </button>
      )}
      {/* Resize handle: bottom-right corner */}
      <div
        role="presentation"
        onPointerDown={(e) => startDrag(e, "resize")}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        className="absolute right-0 bottom-0 w-3 h-3 bg-red-500 cursor-nwse-resize translate-x-1/2 translate-y-1/2"
      />
    </div>
  );
}

export function PrivacyMaskOverlay({
  snapshotUrl,
  rects,
  onChange,
  disabled,
}: PrivacyMaskOverlayProps) {
  const updateRect = useCallback(
    (idx: number, next: MaskRect) => {
      onChange(rects.map((r, i) => (i === idx ? next : r)));
    },
    [rects, onChange],
  );

  const removeRect = useCallback(
    (idx: number) => {
      onChange(
        rects.map((r, i) =>
          i === idx
            ? { id: r.id, enable: false, x: 0, y: 0, width: 0, height: 0 }
            : r,
        ),
      );
    },
    [rects, onChange],
  );

  return (
    <div
      data-mask-canvas
      className="relative w-full aspect-video rounded-md overflow-hidden border border-[var(--color-border)] bg-[var(--color-background)]"
    >
      <img
        src={snapshotUrl}
        alt="snapshot"
        draggable={false}
        className="w-full h-full object-contain select-none pointer-events-none"
      />
      {rects.map((r, idx) => (
        <ShelterRectBox
          key={r.id}
          rect={r}
          onUpdate={(next) => updateRect(idx, next)}
          onRemove={() => removeRect(idx)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
