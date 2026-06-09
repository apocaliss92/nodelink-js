import { useRef, useState } from "react";
import { Server, Settings, GripVertical } from "lucide-react";
import { CameraCard } from "./CameraCard";
import type { CameraInfo, AvailableStream, StreamProfile, NvrInfo } from "./types";
import type { GridItem } from "./groupAndSort";

interface CameraGridProps {
  items: GridItem[];
  streamsByCamera: Record<string, AvailableStream[]>;
  rtspServers: Array<{ cameraId: string; profile: StreamProfile; status?: string; connections?: number }>;
  connectingByCamera: Record<string, boolean>;
  selectedCamera: CameraInfo | null;
  onSelectCamera: (camera: CameraInfo) => void;
  onConnect?: (camera: CameraInfo) => void;
  onOpenPtz?: (camera: CameraInfo) => void;
  onOpenEvents?: (camera: CameraInfo) => void;
  onOpenSessions?: (camera: CameraInfo) => void;
  onOpenDeviceControls?: (camera: CameraInfo) => void;
  onOpenStream?: (camera: CameraInfo, stream: AvailableStream) => void;
  onOpenNvrSettings?: (nvr: NvrInfo) => void;
  /** When provided, enables HTML5 drag-and-drop reordering — the callback
   * receives the new full ordered list of camera ids (header items
   * stripped). Only called when the user releases a drop on a different
   * card; identity drops are ignored. */
  onReorder?: (orderedCameraIds: string[]) => void;
}

export function CameraGrid({
  items,
  streamsByCamera,
  rtspServers,
  connectingByCamera,
  selectedCamera,
  onSelectCamera,
  onConnect,
  onOpenPtz,
  onOpenEvents,
  onOpenSessions,
  onOpenDeviceControls,
  onOpenStream,
  onOpenNvrSettings,
  onReorder,
}: CameraGridProps) {
  const draggingIdRef = useRef<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const dragEnabled = !!onReorder;

  const handleDragStart = (id: string) => (e: React.DragEvent) => {
    if (!dragEnabled) return;
    draggingIdRef.current = id;
    e.dataTransfer.effectAllowed = "move";
    // Setting some data is required for some browsers to start the drag.
    e.dataTransfer.setData("text/plain", id);
  };

  const handleDragOver = (id: string) => (e: React.DragEvent) => {
    if (!dragEnabled || !draggingIdRef.current) return;
    if (draggingIdRef.current === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHoverId(id);
  };

  const handleDragEnd = () => {
    draggingIdRef.current = null;
    setHoverId(null);
  };

  const handleDrop = (targetId: string) => (e: React.DragEvent) => {
    if (!dragEnabled) return;
    e.preventDefault();
    const sourceId = draggingIdRef.current;
    draggingIdRef.current = null;
    setHoverId(null);
    if (!sourceId || sourceId === targetId || !onReorder) return;

    // Compute new order: take the current list of camera ids and move
    // `sourceId` to the slot of `targetId`.
    const cameraIds = items
      .filter((it): it is { kind: "camera"; id: string; camera: CameraInfo } =>
        it.kind === "camera",
      )
      .map((it) => it.id);
    const srcIdx = cameraIds.indexOf(sourceId);
    const tgtIdx = cameraIds.indexOf(targetId);
    if (srcIdx === -1 || tgtIdx === -1) return;
    const next = [...cameraIds];
    next.splice(srcIdx, 1);
    next.splice(tgtIdx, 0, sourceId);
    onReorder(next);
  };

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-4 overflow-y-auto flex-1 content-start">
      {items.map((item) => {
        if (item.kind === "header") {
          const online = item.cameras.filter((c) => c.status === "connected").length;
          return (
            <div
              key={item.id}
              className="col-span-full flex items-center gap-2 text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)] mt-1 first:mt-0"
            >
              {item.nvr ? (
                <Server size={11} className="text-[var(--color-foreground-muted)]" />
              ) : null}
              <span className="font-semibold">{item.label}</span>
              <span className="text-[var(--color-foreground-muted)] normal-case tracking-normal font-mono">
                · {item.cameras.length} {item.cameras.length === 1 ? "camera" : "cameras"}
                {item.cameras.length > 0 && ` · ${online} online`}
              </span>
              {item.nvr && onOpenNvrSettings ? (
                <button
                  type="button"
                  onClick={() => onOpenNvrSettings(item.nvr!)}
                  className="ml-auto inline-flex items-center gap-1 text-[10px] tracking-normal normal-case rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-1.5 py-0.5 hover:bg-[var(--color-surface-hover)]"
                  title="Open NVR-level settings"
                >
                  <Settings size={10} />
                  NVR settings
                </button>
              ) : null}
              <div className="flex-1 h-px bg-[var(--color-border)] ml-2" />
            </div>
          );
        }
        const camera = item.camera;
        const card = (
          <CameraCard
            key={camera.id}
            camera={camera}
            streams={streamsByCamera[camera.id] ?? []}
            rtspServers={rtspServers}
            selected={selectedCamera?.id === camera.id}
            connecting={connectingByCamera[camera.id] ?? false}
            onClick={() => onSelectCamera(camera)}
            onConnect={onConnect ? () => onConnect(camera) : undefined}
            onOpenPtz={onOpenPtz ? () => onOpenPtz(camera) : undefined}
            onOpenEvents={onOpenEvents ? () => onOpenEvents(camera) : undefined}
            onOpenSessions={onOpenSessions ? () => onOpenSessions(camera) : undefined}
            onOpenDeviceControls={onOpenDeviceControls ? () => onOpenDeviceControls(camera) : undefined}
            onOpenStream={onOpenStream ? (stream) => onOpenStream(camera, stream) : undefined}
          />
        );
        if (!dragEnabled) return card;
        const isHover = hoverId === camera.id;
        return (
          <div
            key={camera.id}
            draggable
            onDragStart={handleDragStart(camera.id)}
            onDragOver={handleDragOver(camera.id)}
            onDragEnd={handleDragEnd}
            onDrop={handleDrop(camera.id)}
            onDragLeave={() => hoverId === camera.id && setHoverId(null)}
            className={`relative group ${isHover ? "ring-2 ring-[var(--color-accent,#22d3ee)] ring-offset-1 ring-offset-[var(--color-background)] rounded-md" : ""}`}
          >
            <div className="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              <div className="rounded-md bg-[var(--color-background-elevated)]/80 border border-[var(--color-border)] p-0.5">
                <GripVertical
                  size={11}
                  className="text-[var(--color-foreground-muted)]"
                />
              </div>
            </div>
            {card}
          </div>
        );
      })}
    </div>
  );
}
