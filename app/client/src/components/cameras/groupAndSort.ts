import type { CameraInfo, NvrInfo } from "./types";

export type SortMode = "group" | "name" | "status" | "custom";

export interface GroupHeaderItem {
  kind: "header";
  /** Stable id for the React key. */
  id: string;
  /** Display label, e.g. "Standalone" or NVR name. */
  label: string;
  /** Subset of cameras in this group (for badge: "3 of 5 online"). */
  cameras: CameraInfo[];
  /** When `nvr` is present, the header is for an NVR (clickable Settings link). */
  nvr?: NvrInfo;
}

export interface CameraItem {
  kind: "camera";
  id: string;
  camera: CameraInfo;
}

export type GridItem = GroupHeaderItem | CameraItem;

const STATUS_ORDER: Record<CameraInfo["status"], number> = {
  connected: 0,
  disconnected: 1,
  error: 2,
};

function compareByName(a: CameraInfo, b: CameraInfo): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function compareByStatus(a: CameraInfo, b: CameraInfo): number {
  const d = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (d !== 0) return d;
  return compareByName(a, b);
}

/**
 * Build the renderable list for the camera grid given the chosen sort mode.
 *
 *   - "group"  → headers per parent: "Standalone" first, then each NVR.
 *                Cameras inside each group are sorted alphabetically.
 *   - "name"   → flat list sorted by camera name (no headers).
 *   - "status" → flat list, connected first, then by name.
 *
 * Sort order respects all cameras uniformly — standalone and NVR children
 * are mixed in the same comparison frame for "name" and "status" modes.
 */
export function buildGridItems(
  cameras: CameraInfo[],
  nvrs: NvrInfo[],
  mode: SortMode,
): GridItem[] {
  if (mode === "name") {
    return [...cameras]
      .sort(compareByName)
      .map((c) => ({ kind: "camera" as const, id: c.id, camera: c }));
  }

  if (mode === "status") {
    return [...cameras]
      .sort(compareByStatus)
      .map((c) => ({ kind: "camera" as const, id: c.id, camera: c }));
  }

  if (mode === "custom") {
    // Persisted user order — `position` is the index assigned by
    // `cameras.reorder`. Items without a position sort to the end in their
    // original (config) order so the grid stays stable when a new camera is
    // added before the user reorders it.
    const indexed = cameras.map((c, idx) => ({ c, idx }));
    indexed.sort((a, b) => {
      const ap = a.c.position;
      const bp = b.c.position;
      if (ap !== undefined && bp !== undefined) return ap - bp;
      if (ap !== undefined) return -1;
      if (bp !== undefined) return 1;
      return a.idx - b.idx;
    });
    return indexed.map(({ c }) => ({
      kind: "camera" as const,
      id: c.id,
      camera: c,
    }));
  }

  // group mode
  const items: GridItem[] = [];

  // Standalone first (no nvrId)
  const standalone = cameras
    .filter((c) => !c.nvrId)
    .sort(compareByName);
  if (standalone.length > 0) {
    items.push({
      kind: "header",
      id: "header:standalone",
      label: "Standalone",
      cameras: standalone,
    });
    for (const c of standalone) {
      items.push({ kind: "camera", id: c.id, camera: c });
    }
  }

  // Then each NVR (preserve nvrs[] order — that's user-add order).
  for (const nvr of nvrs) {
    const children = cameras
      .filter((c) => c.nvrId === nvr.id)
      .sort(compareByName);
    items.push({
      kind: "header",
      id: `header:nvr:${nvr.id}`,
      label: nvr.name,
      cameras: children,
      nvr,
    });
    for (const c of children) {
      items.push({ kind: "camera", id: c.id, camera: c });
    }
  }

  // Orphan children whose nvrId points at a missing NVR — render under
  // a fallback header so they're still reachable.
  const knownNvrIds = new Set(nvrs.map((n) => n.id));
  const orphans = cameras
    .filter((c) => c.nvrId && !knownNvrIds.has(c.nvrId))
    .sort(compareByName);
  if (orphans.length > 0) {
    items.push({
      kind: "header",
      id: "header:orphans",
      label: "Other (orphaned NVR children)",
      cameras: orphans,
    });
    for (const c of orphans) {
      items.push({ kind: "camera", id: c.id, camera: c });
    }
  }

  return items;
}
