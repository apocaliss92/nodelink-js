import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Paintbrush, Eraser } from "lucide-react";
import {
  decodeMotionScopeBitmap,
  encodeMotionScopeBitmap,
} from "../utils/motionZoneBitmap";
import { Section, ApplyBar, type TabProps } from "./shared";
import { trpcQuery, trpcMutation } from "../../../api";
import { withAuthTokenQuery } from "../utils";

/**
 * Motion detection zone editor.
 *
 * Reolink exposes the active detection region as a column×row grid
 * (typically 96×64 on E1 Zoom, smaller on older firmwares). Each cell
 * is one bit in a base64-packed `<valueTable>` inside the GetMdAlarm
 * response (cmd_46). To update, we read the current XML, swap the
 * bitmap in place, and POST it back via SetMdAlarm (cmd_47).
 *
 * The editor renders the grid scaled over the camera's current snapshot
 * so the user can paint exactly the area they want monitored. Clicks
 * toggle a single cell; clicking+dragging paints continuously in the
 * direction of the first cell ("paint" or "erase" depending on which
 * tool is selected).
 */
interface ScopeData {
  /** UI grid width (matches the camera's active motion region). */
  width: number;
  /** UI grid height. */
  height: number;
  /** Wire-format bitmap columns (typically 96 on E1 Zoom). */
  columns: number;
  /** Wire-format bitmap rows (typically 64). */
  rows: number;
  valueTable: string;
  channelId: number;
  enable?: number;
}

/**
 * The library's `getMotionAlarm` returns the raw XML parsed as JSON, so the
 * shape varies by firmware: some cameras nest under `body.MD`, others under
 * `body.MdAlarm`, and a few flatten everything at the top. We walk the
 * object recursively looking for the first node that exposes a `scope`
 * sub-block with `columns/rows/valueTable` — that's what we need.
 */
type MotionAlarmRaw = Record<string, unknown>;

function findScope(
  obj: unknown,
): { node: Record<string, unknown>; scope: { columns?: number; rows?: number; valueTable?: string } } | null {
  if (obj === null || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  const scope = rec.scope;
  if (scope && typeof scope === "object") {
    const s = scope as Record<string, unknown>;
    if (
      (typeof s.columns === "number" || typeof s.columns === "string") &&
      (typeof s.rows === "number" || typeof s.rows === "string") &&
      typeof s.valueTable === "string"
    ) {
      return {
        node: rec,
        scope: {
          columns: Number(s.columns),
          rows: Number(s.rows),
          valueTable: s.valueTable,
        },
      };
    }
  }
  for (const value of Object.values(rec)) {
    const hit = findScope(value);
    if (hit) return hit;
  }
  return null;
}

export function MotionZonesTab({ cameraId, channel }: TabProps) {
  const [scope, setScope] = useState<ScopeData | null>(null);
  const [cells, setCells] = useState<boolean[] | null>(null);
  const [loaded, setLoaded] = useState<boolean[] | null>(null);
  const [tool, setTool] = useState<"paint" | "erase">("paint");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<boolean>(false);
  // Cells already toggled during the current drag — prevents the same cell
  // from flipping multiple times when the mouse hovers it again mid-drag.
  const touchedRef = useRef<Set<number>>(new Set());

  const snapshotUrl = useMemo(() => {
    return withAuthTokenQuery(
      `${window.location.origin}/api/cameras/${cameraId}/snapshot?channel=${channel}`,
    );
  }, [cameraId, channel]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await trpcQuery<MotionAlarmRaw>(
        "baichuan.getMotionAlarm",
        { cameraId, channel },
      );
      const hit = findScope(data);
      if (!hit || !hit.scope.columns || !hit.scope.rows || !hit.scope.valueTable) {
        setError(
          "Camera did not report a motion-zone grid (missing <scope> block). Older firmwares might not support zone editing.",
        );
        setScope(null);
        setCells(null);
        setLoaded(null);
        return;
      }
      const cols = hit.scope.columns;
      const rows = hit.scope.rows;
      const vt = hit.scope.valueTable;
      // The MD block reports a `width × height` ACTIVE region next to
      // the bitmap `columns × rows`. Only the first width × height cells
      // of the bitmap correspond to the actual camera frame; the rest
      // are camera-side padding that stays 0. We render the editor at
      // the active size so the painted cells map onto the full picture
      // — otherwise the grid only covers the top-left fraction.
      const widthRaw = hit.node.width;
      const heightRaw = hit.node.height;
      const width = Math.max(
        1,
        Math.min(cols, typeof widthRaw === "number" ? widthRaw : Number(widthRaw) || cols),
      );
      const height = Math.max(
        1,
        Math.min(rows, typeof heightRaw === "number" ? heightRaw : Number(heightRaw) || rows),
      );
      const decoded = decodeMotionScopeBitmap(vt, cols, rows, width, height);
      const channelIdRaw = hit.node.channelId;
      setScope({
        width,
        height,
        columns: cols,
        rows,
        valueTable: vt,
        channelId:
          typeof channelIdRaw === "number"
            ? channelIdRaw
            : typeof channelIdRaw === "string"
              ? Number(channelIdRaw)
              : channel,
        enable: typeof hit.node.enable === "number" ? hit.node.enable : undefined,
      });
      setCells([...decoded.cells]);
      setLoaded([...decoded.cells]);
      setSaved(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cameraId, channel]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dirty = useMemo(() => {
    if (!cells || !loaded) return false;
    if (cells.length !== loaded.length) return true;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] !== loaded[i]) return true;
    }
    return false;
  }, [cells, loaded]);

  const apply = useCallback(async () => {
    if (!scope || !cells) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const valueTable = encodeMotionScopeBitmap({
        width: scope.width,
        height: scope.height,
        columns: scope.columns,
        rows: scope.rows,
        cells,
      });
      await trpcMutation("baichuan.setMotionAlarmZone", {
        cameraId,
        channel,
        valueTable,
      });
      setSaved(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [scope, cells, cameraId, channel, refresh]);

  const paintAll = (value: boolean) => {
    if (!cells) return;
    setCells(cells.map(() => value));
  };

  const invert = () => {
    if (!cells) return;
    setCells(cells.map((c) => !c));
  };

  // Mouse/touch handlers: paint cells under the pointer while a drag is
  // active. We compute the (col, row) hit from the pointer's position
  // inside the canvas wrapper using its bounding rect — no per-cell event
  // listeners needed, scales to 96×64 = 6144 cells without DOM noise.
  const onPointerEvent = useCallback((e: React.PointerEvent<HTMLDivElement>, drag: boolean) => {
    if (!scope || !cells || !canvasRef.current) return;
    if (drag && !draggingRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const col = Math.floor((x / rect.width) * scope.width);
    const row = Math.floor((y / rect.height) * scope.height);
    if (col < 0 || col >= scope.width || row < 0 || row >= scope.height) return;
    const idx = row * scope.width + col;
    if (touchedRef.current.has(idx)) return;
    touchedRef.current.add(idx);
    setCells((prev) => {
      if (!prev) return prev;
      if (prev[idx] === (tool === "paint")) return prev;
      const next = [...prev];
      next[idx] = tool === "paint";
      return next;
    });
  }, [scope, cells, tool]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    touchedRef.current = new Set();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    onPointerEvent(e, false);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => onPointerEvent(e, true);
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    touchedRef.current = new Set();
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  return (
    <div>
      <Section
        title="Detection zone"
        description="Paint over the parts of the frame you want monitored for motion. The camera reports the grid size — typically 96×64 on E1 Zoom, smaller on older firmwares. Click and drag to paint with the selected tool."
      >
        {loading ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-4">Loading…</div>
        ) : error && !scope ? (
          <div className="text-[11px] text-red-300 py-2">{error}</div>
        ) : scope && cells ? (
          <>
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
                Grid {scope.width} × {scope.height} · {cells.filter(Boolean).length} of {cells.length} cells included
              </span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => paintAll(true)}
                className="text-[11px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1 hover:bg-[var(--color-surface-hover)]"
              >
                All on
              </button>
              <button
                type="button"
                onClick={() => paintAll(false)}
                className="text-[11px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1 hover:bg-[var(--color-surface-hover)]"
              >
                All off
              </button>
              <button
                type="button"
                onClick={invert}
                className="text-[11px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1 hover:bg-[var(--color-surface-hover)]"
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
              <img
                src={snapshotUrl}
                alt=""
                draggable={false}
                className="absolute inset-0 w-full h-full object-cover opacity-80"
                onError={(e) => {
                  // If the snapshot can't load (camera offline / no JPEG
                  // support), hide the broken-image icon and rely on the
                  // grid background.
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
              {/* SVG overlay for the grid — one rect per cell. SVG handles
                  6k+ rectangles smoothly without per-element re-renders. */}
              <svg
                className="absolute inset-0 w-full h-full pointer-events-none"
                viewBox={`0 0 ${scope.width} ${scope.height}`}
                preserveAspectRatio="none"
              >
                {cells.map((on, i) => {
                  if (!on) return null;
                  const c = i % scope.width;
                  const r = Math.floor(i / scope.width);
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
          </>
        ) : null}
      </Section>

      <ApplyBar
        dirty={dirty}
        saving={saving}
        saved={saved}
        error={error}
        onApply={() => void apply()}
        onRevert={() => {
          if (loaded) setCells([...loaded]);
        }}
        onRefresh={() => void refresh()}
      />
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

