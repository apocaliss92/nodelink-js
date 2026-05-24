import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Section, ApplyBar, Field, FieldGrid, Toggle, type TabProps } from "./shared";
import { trpcQuery, trpcMutation } from "../../../api";
import { withAuthTokenQuery } from "../utils";
import {
  PrivacyMaskOverlay,
  type MaskRect,
} from "./privacy/PrivacyMaskOverlay";

/**
 * Privacy Mask (Shelter) editor — `<shelterList>` portion only.
 *
 * The cmd_id 52 response also carries a `<trackShelterList>` block for
 * PTZ-tracking privacy masks (zones anchored to a saved pPos/tPos/zPos).
 * That schema is present on E1 Zoom firmware but never populated by the
 * official Reolink app and never exposed in their UI — every slot stays
 * disabled with `-1` PTZ coords across firmwares we've tested. We don't
 * surface it here to avoid promising unverified functionality. The
 * library still preserves whatever the camera ships back on read-modify-
 * write (we just don't send a `trackShelterList` override on SET).
 */

interface PrivacyMaskData {
  enable: boolean;
  maxNum: number;
  shelterList: MaskRect[];
  canvas: { width: number; height: number };
}

interface GetMaskZonesResponse {
  enable?: boolean;
  maxNum?: number;
  shelterList?: MaskRect[];
  canvas?: { width: number; height: number };
}

function padShelterList(
  list: MaskRect[] | undefined,
  maxNum: number,
): MaskRect[] {
  const out: MaskRect[] = [];
  for (let id = 0; id < maxNum; id++) {
    const existing = list?.find((r) => r.id === id);
    out.push(
      existing ?? {
        id,
        enable: false,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      },
    );
  }
  return out;
}

export function PrivacyMaskTab({ cameraId, channel }: TabProps) {
  const [data, setData] = useState<PrivacyMaskData | null>(null);
  const [loaded, setLoaded] = useState<PrivacyMaskData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable snapshot URL — dragging rectangles must not shift when the parent
  // re-renders. Reolink masks anchor to the camera's frame, not whatever the
  // snapshot endpoint happens to return.
  const [snapshotUrl] = useState(() =>
    withAuthTokenQuery(
      `${window.location.origin}/api/cameras/${cameraId}/snapshot?channel=${channel}`,
    ),
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const raw = await trpcQuery<GetMaskZonesResponse>(
        "baichuan.getMaskZones",
        { cameraId, channel },
      );
      const maxNum = raw.maxNum ?? 4;
      const normalized: PrivacyMaskData = {
        enable: !!raw.enable,
        maxNum,
        shelterList: padShelterList(raw.shelterList ?? [], maxNum),
        canvas: raw.canvas ?? { width: 540, height: 304 },
      };
      setData(normalized);
      setLoaded(JSON.parse(JSON.stringify(normalized)));
      setSaved(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cameraId, channel]);

  useEffect(() => { void refresh(); }, [refresh]);

  const dirty = useMemo(() => {
    if (!data || !loaded) return false;
    return JSON.stringify(data) !== JSON.stringify(loaded);
  }, [data, loaded]);

  const enabledShelterCount = data
    ? data.shelterList.filter((r) => r.enable).length
    : 0;

  const addShelterZone = () => {
    if (!data) return;
    // Find the first disabled slot and turn it into a centered default zone.
    const next = data.shelterList.map((r) => ({ ...r }));
    const target = next.find((r) => !r.enable);
    if (!target) return;
    target.enable = true;
    target.x = 0.35;
    target.y = 0.35;
    target.width = 0.3;
    target.height = 0.3;
    setData({ ...data, shelterList: next });
  };

  const apply = useCallback(async () => {
    if (!data) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // We only send `enable` + `shelterList`. The lib does a read-modify-
      // write on cmd_id 53 so `trackShelterList` / `trackEnable` / any
      // other camera-side tags are preserved untouched.
      await trpcMutation("baichuan.setMaskZones", {
        cameraId,
        channel,
        enable: data.enable,
        shelterList: data.shelterList
          .filter((r) => r.enable)
          .map((r) => ({
            id: r.id,
            enable: true,
            layer: 0,
            color: 0,
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
          })),
      });
      setSaved(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data, cameraId, channel, refresh]);

  const revert = useCallback(() => {
    if (loaded) setData(JSON.parse(JSON.stringify(loaded)));
  }, [loaded]);

  if (loading) {
    return (
      <div className="text-[11px] text-[var(--color-foreground-muted)] py-4">
        Loading…
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-[11px] text-red-300 py-2">
        {error ?? "Camera did not return a privacy mask config."}
      </div>
    );
  }

  return (
    <div>
      <Section
        title="Privacy mask zones"
        description={`Up to ${data.maxNum} rectangular zones that the camera blanks out before encoding the video. Coordinates are normalized to the camera's mask canvas (${data.canvas.width} × ${data.canvas.height} on this firmware). Drag the body to move, drag the corner to resize.`}
      >
        <FieldGrid>
          <Field label="Master enable">
            <Toggle
              value={data.enable}
              onChange={(v) => setData({ ...data, enable: v })}
              disabled={saving}
            />
          </Field>
          <Field label="Active zones" hint={`${enabledShelterCount} / ${data.maxNum}`}>
            <div className="flex items-center gap-2 mt-1">
              <button
                type="button"
                onClick={addShelterZone}
                disabled={saving || enabledShelterCount >= data.maxNum}
                className="inline-flex items-center gap-1 text-[11px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
              >
                <Plus size={11} />
                Add zone
              </button>
            </div>
          </Field>
        </FieldGrid>

        <div className="mt-3">
          <PrivacyMaskOverlay
            snapshotUrl={snapshotUrl}
            rects={data.shelterList}
            onChange={(next) => setData({ ...data, shelterList: next })}
            disabled={saving}
          />
        </div>
      </Section>

      <ApplyBar
        dirty={dirty}
        saving={saving}
        saved={saved}
        error={error}
        onApply={() => void apply()}
        onRevert={revert}
        onRefresh={() => void refresh()}
      />
    </div>
  );
}
