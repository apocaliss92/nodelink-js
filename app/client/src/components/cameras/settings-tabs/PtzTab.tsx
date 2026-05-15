import { useCallback, useEffect, useState } from "react";
import {
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Plus,
  Minus,
  Crosshair,
  Save,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { trpcQuery, trpcMutation } from "../../../api";
import { WebRTCInlinePlayer } from "../WebRTCInlinePlayer";
import { Section, type TabProps } from "./shared";

/**
 * PTZ control tab. The user gets:
 *   - A live stream of the camera (substream via the native WebRTC path)
 *     so they can see what they're aiming at.
 *   - A D-pad + zoom slider for press-and-hold movement (sends `start`
 *     on press, `stop` on release; the server auto-stops after the
 *     configured autoStopMs if the release event is missed).
 *   - The list of saved presets with goto / overwrite / delete actions.
 *   - A "Save current position" form for storing a NEW preset by name.
 */
type PtzCommand =
  | "Left"
  | "Right"
  | "Up"
  | "Down"
  | "ZoomIn"
  | "ZoomOut"
  | "FocusNear"
  | "FocusFar";

interface PtzPreset {
  id: number;
  name: string;
  enable?: number;
}

export function PtzTab({ cameraId, channel }: TabProps) {
  const [presets, setPresets] = useState<PtzPreset[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newId, setNewId] = useState<number>(1);
  const [speed, setSpeed] = useState<number>(32);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await trpcQuery<PtzPreset[]>("baichuan.getPtzPresets", {
        cameraId,
        channel,
      });
      // Filter out slots explicitly disabled by the camera.
      const filtered = (list ?? []).filter(
        (p) => p && (p.enable === undefined || p.enable === 1),
      );
      setPresets(filtered);
      // Suggest the next free slot id for the "save new" input.
      const used = new Set(filtered.map((p) => p.id));
      let next = 1;
      while (used.has(next)) next++;
      setNewId(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [cameraId, channel]);

  useEffect(() => { void refresh(); }, [refresh]);

  const sendPtz = useCallback(
    async (command: PtzCommand, action: "start" | "stop") => {
      try {
        await trpcMutation("baichuan.ptzControl", {
          cameraId,
          channel,
          command,
          action,
          speed,
          autoStopMs: 1500,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [cameraId, channel, speed],
  );

  const goto = useCallback(
    async (presetId: number) => {
      setBusy(`goto-${presetId}`);
      setError(null);
      try {
        await trpcMutation("baichuan.gotoPtzPreset", {
          cameraId,
          channel,
          presetId,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [cameraId, channel],
  );

  const savePreset = useCallback(
    async (presetId: number, name: string) => {
      setBusy(`save-${presetId}`);
      setError(null);
      try {
        await trpcMutation("baichuan.setPtzPreset", {
          cameraId,
          channel,
          presetId,
          name,
        });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [cameraId, channel, refresh],
  );

  const deletePreset = useCallback(
    async (presetId: number) => {
      if (!confirm(`Delete preset ${presetId}?`)) return;
      setBusy(`del-${presetId}`);
      setError(null);
      try {
        await trpcMutation("baichuan.deletePtzPreset", {
          cameraId,
          channel,
          presetId,
        });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [cameraId, channel, refresh],
  );

  return (
    <div>
      {error && (
        <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1 mb-2">
          {error}
        </div>
      )}

      <Section
        title="Live view"
        description="Substream rendering via the native WebRTC backend so you can see what you're aiming the camera at. Use the controls below to move."
      >
        <div className="rounded-md overflow-hidden bg-black" style={{ aspectRatio: "16 / 9" }}>
          <WebRTCInlinePlayer
            cameraId={cameraId}
            profile="sub"
            useNative
            autoStart
          />
        </div>
      </Section>

      <Section
        title="Manual control"
        description="Press and hold a direction. Release to stop. If the release is dropped on the wire, the server auto-stops after ~1.5s."
      >
        <div className="flex items-center gap-4">
          <div className="grid grid-cols-3 gap-1.5">
            <div />
            <DPadButton onPress={() => sendPtz("Up", "start")} onRelease={() => sendPtz("Up", "stop")}>
              <ArrowUp size={16} />
            </DPadButton>
            <div />
            <DPadButton onPress={() => sendPtz("Left", "start")} onRelease={() => sendPtz("Left", "stop")}>
              <ArrowLeft size={16} />
            </DPadButton>
            <DPadButton onPress={() => sendPtz("Up", "stop")} onRelease={() => sendPtz("Up", "stop")} title="Stop all">
              <Crosshair size={16} />
            </DPadButton>
            <DPadButton onPress={() => sendPtz("Right", "start")} onRelease={() => sendPtz("Right", "stop")}>
              <ArrowRight size={16} />
            </DPadButton>
            <div />
            <DPadButton onPress={() => sendPtz("Down", "start")} onRelease={() => sendPtz("Down", "stop")}>
              <ArrowDown size={16} />
            </DPadButton>
            <div />
          </div>

          <div className="flex flex-col gap-2">
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">Zoom</div>
            <div className="flex gap-1.5">
              <DPadButton onPress={() => sendPtz("ZoomIn", "start")} onRelease={() => sendPtz("ZoomIn", "stop")} title="Zoom in">
                <Plus size={16} />
              </DPadButton>
              <DPadButton onPress={() => sendPtz("ZoomOut", "start")} onRelease={() => sendPtz("ZoomOut", "stop")} title="Zoom out">
                <Minus size={16} />
              </DPadButton>
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)] mt-3">Speed</div>
            <input
              type="range"
              min={1}
              max={64}
              step={1}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="w-[120px]"
            />
            <div className="text-[11px] text-[var(--color-foreground-muted)] tabular-nums">{speed}</div>
          </div>
        </div>
      </Section>

      <Section
        title="Presets"
        description="Saved positions on the camera. Recall to move there, overwrite to save the CURRENT position into a slot, delete to free it."
      >
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] text-[var(--color-foreground-muted)]">
            {presets.length} saved
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground-muted)] px-2 py-1 text-[11px] hover:bg-[var(--color-surface-hover)]"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>

        {presets.length === 0 ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-2">
            No presets saved on this camera. Use the form below to save the current position.
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {presets.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">#{p.id}</span>
                  <span className="text-sm text-[var(--color-foreground)] truncate">{p.name || "(unnamed)"}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void goto(p.id)}
                    disabled={busy === `goto-${p.id}`}
                    className="flex items-center gap-1 rounded-md border border-[var(--color-accent,#22d3ee)]/40 bg-[var(--color-accent,#22d3ee)]/10 text-[var(--color-foreground)] px-2 py-1 text-[11px] hover:bg-[var(--color-accent,#22d3ee)]/20 disabled:opacity-50"
                  >
                    <Crosshair size={12} />
                    Recall
                  </button>
                  <button
                    type="button"
                    onClick={() => void savePreset(p.id, p.name || `Preset ${p.id}`)}
                    disabled={busy === `save-${p.id}`}
                    title="Overwrite this preset with the current position"
                    className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground-muted)] px-2 py-1 text-[11px] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
                  >
                    <Save size={12} />
                    Overwrite
                  </button>
                  <button
                    type="button"
                    onClick={() => void deletePreset(p.id)}
                    disabled={busy === `del-${p.id}`}
                    className="flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 text-red-200 px-2 py-1 text-[11px] hover:bg-red-500/20 disabled:opacity-50"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 pt-3 border-t border-[var(--color-border)]">
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)] mb-2">
            Save current position as new preset
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">ID</span>
              <input
                type="number"
                min={1}
                max={64}
                value={newId}
                onChange={(e) => setNewId(Number(e.target.value))}
                className="w-[80px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 flex-1 min-w-[140px]">
              <span className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">Name</span>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Front door"
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1.5 text-sm"
              />
            </label>
            <button
              type="button"
              disabled={busy === `save-${newId}` || newName.trim().length === 0}
              onClick={() => {
                const name = newName.trim();
                if (!name) return;
                void savePreset(newId, name).then(() => setNewName(""));
              }}
              className="flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 px-3 py-1.5 text-xs hover:bg-emerald-500/20 disabled:opacity-50"
            >
              <Save size={12} />
              Save
            </button>
          </div>
        </div>
      </Section>
    </div>
  );
}

interface DPadButtonProps {
  onPress: () => void;
  onRelease: () => void;
  title?: string;
  children: React.ReactNode;
}

/**
 * Press-and-hold button used by the PTZ D-pad and zoom controls.
 * Sends `start` on pointer-down / focus, `stop` on every release path
 * (up / leave / blur / pointer-cancel / touch-end). The redundancy
 * matters: a missed release means the camera keeps panning.
 */
function DPadButton({ onPress, onRelease, title, children }: DPadButtonProps) {
  const release = () => onRelease();
  return (
    <button
      type="button"
      title={title}
      className="flex items-center justify-center w-10 h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-accent,#22d3ee)]/20 active:border-[var(--color-accent,#22d3ee)]/50 transition-colors"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        onPress();
      }}
      onPointerUp={(e) => {
        (e.target as Element).releasePointerCapture?.(e.pointerId);
        release();
      }}
      onPointerLeave={release}
      onPointerCancel={release}
      onBlur={release}
    >
      {children}
    </button>
  );
}
