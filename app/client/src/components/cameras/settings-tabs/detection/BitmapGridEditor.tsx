import { useCallback, useRef, useState } from "react";
import { Paintbrush, Eraser } from "lucide-react";

/**
 * Reusable bitmap-grid editor for Reolink detection masks.
 *
 * Used by:
 *   - MotionZonesTab (cmd_46/47 `<scope><valueTable>` — typically 96×64)
 *   - DetectionTab AI area (cmd_342/343 `<AiDetectCfg><area>` — 60×33)
 *
 * The component is pure: it renders the cells the parent gives it,
 * captures pointer events, and asks the parent to update via
 * `onCellsChange`. Snapshot URL is optional — when not provided, the
 * grid renders against a black background.
 */

interface BitmapGridEditorProps {
  /** Flat width × height boolean grid, row-major. */
  cells: boolean[];
  width: number;
  height: number;
  /** Snapshot URL displayed behind the grid for context. */
  snapshotUrl?: string;
  onCellsChange: (next: boolean[]) => void;
  disabled?: boolean;
}

export function BitmapGridEditor({
  cells,
  width,
  height,
  snapshotUrl,
  onCellsChange,
  disabled,
}: BitmapGridEditorProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [tool, setTool] = useState<"paint" | "erase">("paint");
  const toolRef = useRef<"paint" | "erase">("paint");
  toolRef.current = tool; // mirror for the pointer-callback fast path
  const touchedRef = useRef<Set<number>>(new Set());

  const onPointerEvent = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, drag: boolean) => {
      if (disabled || !canvasRef.current) return;
      if (drag && !draggingRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const col = Math.floor((x / rect.width) * width);
      const row = Math.floor((y / rect.height) * height);
      if (col < 0 || col >= width || row < 0 || row >= height) return;
      const idx = row * width + col;
      if (touchedRef.current.has(idx)) return;
      touchedRef.current.add(idx);
      const desired = toolRef.current === "paint";
      if (cells[idx] === desired) return;
      const next = [...cells];
      next[idx] = desired;
      onCellsChange(next);
    },
    [cells, width, height, onCellsChange, disabled],
  );

  const paintAll = (value: boolean) =>
    onCellsChange(cells.map(() => value));
  const invert = () => onCellsChange(cells.map((c) => !c));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    touchedRef.current = new Set();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    onPointerEvent(e, false);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) =>
    onPointerEvent(e, true);
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    touchedRef.current = new Set();
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  const includedCount = cells.filter(Boolean).length;

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <ToolButton
          active={tool === "paint"}
          onClick={() => setTool("paint")}
          icon={<Paintbrush size={12} />}
          label="Paint (include)"
        />
        <ToolButton
          active={tool === "erase"}
          onClick={() => setTool("erase")}
          icon={<Eraser size={12} />}
          label="Erase (exclude)"
        />
        <span className="text-[11px] text-[var(--color-foreground-muted)] ml-2">
          Grid {width} × {height} · {includedCount} of {cells.length} cells
          included
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => paintAll(true)}
          disabled={disabled}
          className="text-[11px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          All on
        </button>
        <button
          type="button"
          onClick={() => paintAll(false)}
          disabled={disabled}
          className="text-[11px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          All off
        </button>
        <button
          type="button"
          onClick={invert}
          disabled={disabled}
          className="text-[11px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          Invert
        </button>
      </div>

      <div
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        className="relative w-full rounded-md overflow-hidden bg-black select-none touch-none cursor-crosshair"
        style={{ aspectRatio: "16 / 9" }}
      >
        {snapshotUrl ? (
          <img
            src={snapshotUrl}
            alt=""
            draggable={false}
            className="absolute inset-0 w-full h-full object-cover opacity-80"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : null}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
        >
          {cells.map((on, i) => {
            if (!on) return null;
            const c = i % width;
            const r = Math.floor(i / width);
            return (
              <rect
                key={i}
                x={c}
                y={r}
                width={1}
                height={1}
                fill="rgba(34,211,238,0.35)"
                stroke="rgba(34,211,238,0.7)"
                strokeWidth={0.02}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function ToolButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 text-[11px] rounded-md border px-2 py-1 transition-colors ${
        active
          ? "border-[var(--color-accent,#22d3ee)]/50 bg-[var(--color-accent,#22d3ee)]/10 text-[var(--color-foreground)]"
          : "border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-hover)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
