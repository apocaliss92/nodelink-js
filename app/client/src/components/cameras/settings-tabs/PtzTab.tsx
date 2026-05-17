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
import { Button, Input, Switch } from "@camstack/ui-library";
import { trpcQuery, trpcMutation } from "../../../api";
import { WebRTCInlinePlayer } from "../WebRTCInlinePlayer";
import { RangeInput, type TabProps } from "./shared";

/**
 * PTZ control tab in a two-column layout — live stream on the left,
 * controls + preset list on the right so the user can see what they're
 * aiming the camera at without scrolling.
 *
 *   - D-pad + zoom send `start` on press, `stop` on release. If the
 *     release is dropped on the wire the server auto-stops after the
 *     configured autoStopMs.
 *   - Preset list: Recall (move to), Overwrite (save current position
 *     into the slot), Delete (best-effort — some firmwares ignore).
 *   - "Save current position" form prefills the next free slot.
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
  // Inline confirm pattern: the row swaps to "Confirm delete / Cancel"
  // when the trash icon is clicked. Native `<dialog>` modals can't be
  // nested inside the settings modal without stacking issues (browser
  // shows the child top-left and the click closes the parent), so we
  // confirm inline like the dashboard's Delete-camera flow.
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  // Autofocus toggle state. The Baichuan setter takes `disable` (0/1)
  // where 1 = AF off; we surface the inverse — the toggle is "on" when
  // the camera is doing autofocus. `undefined` while loading or when
  // the camera doesn't expose the field (older firmwares).
  const [autoFocusOn, setAutoFocusOn] = useState<boolean | undefined>(undefined);
  const [autoFocusSupported, setAutoFocusSupported] = useState<boolean>(true);
  const [autoFocusBusy, setAutoFocusBusy] = useState<boolean>(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await trpcQuery<PtzPreset[]>("baichuan.getPtzPresets", {
        cameraId,
        channel,
      });
      const filtered = (list ?? []).filter(
        (p) => p && (p.enable === undefined || p.enable === 1),
      );
      setPresets(filtered);
      const used = new Set(filtered.map((p) => p.id));
      let next = 1;
      while (used.has(next)) next++;
      setNewId(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // Autofocus is firmware-dependent (PTZ models only). Fetch best-
    // effort so cameras without zoom optics don't break the whole tab.
    try {
      const af = await trpcQuery<{ disable?: number; body?: unknown } | null>(
        "baichuan.getAutoFocus",
        { cameraId, channel },
      );
      const findDisable = (obj: unknown): number | undefined => {
        if (!obj || typeof obj !== "object") return undefined;
        const rec = obj as Record<string, unknown>;
        if (typeof rec.disable === "number") return rec.disable;
        for (const v of Object.values(rec)) {
          const r = findDisable(v);
          if (r !== undefined) return r;
        }
        return undefined;
      };
      const disable = findDisable(af);
      if (disable === undefined) {
        setAutoFocusSupported(false);
        setAutoFocusOn(undefined);
      } else {
        setAutoFocusSupported(true);
        setAutoFocusOn(disable === 0);
      }
    } catch {
      setAutoFocusSupported(false);
      setAutoFocusOn(undefined);
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

  const toggleAutoFocus = useCallback(
    async (next: boolean) => {
      setAutoFocusBusy(true);
      setError(null);
      // Optimistic flip — the camera takes ~1 s to settle.
      setAutoFocusOn(next);
      try {
        await trpcMutation("baichuan.setAutoFocus", {
          cameraId,
          channel,
          // Baichuan field is `disable`: 1 = AF off, 0 = AF on. Toggle
          // semantics are the inverse for the user-facing label.
          disable: !next,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        // Roll back the optimistic update on failure.
        setAutoFocusOn(!next);
      } finally {
        setAutoFocusBusy(false);
      }
    },
    [cameraId, channel],
  );

  const deletePreset = useCallback(
    async (presetId: number) => {
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

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-3">
        {/* LEFT: live view */}
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 flex flex-col">
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)] mb-2">
            Live view
          </div>
          <div className="rounded-md overflow-hidden bg-black" style={{ aspectRatio: "16 / 9" }}>
            <WebRTCInlinePlayer
              cameraId={cameraId}
              profile="sub"
              useNative
              autoStart
            />
          </div>
        </div>

        {/* RIGHT: controls + presets */}
        <div className="flex flex-col gap-3">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)] mb-3">
              Manual control
            </div>
            <div className="flex items-start justify-around gap-4">
              {/* D-pad */}
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
              {/* Zoom */}
              <div className="flex flex-col gap-1.5 items-center">
                <DPadButton onPress={() => sendPtz("ZoomIn", "start")} onRelease={() => sendPtz("ZoomIn", "stop")} title="Zoom in">
                  <Plus size={16} />
                </DPadButton>
                <DPadButton onPress={() => sendPtz("ZoomOut", "start")} onRelease={() => sendPtz("ZoomOut", "stop")} title="Zoom out">
                  <Minus size={16} />
                </DPadButton>
              </div>
            </div>
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)] mb-1">
                Speed
              </div>
              <RangeInput value={speed} min={1} max={64} onChange={setSpeed} />
            </div>
            {autoFocusSupported && (
              <div className="mt-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
                    Autofocus
                  </div>
                  <div className="text-[10px] text-[var(--color-foreground-muted)]">
                    {autoFocusOn === undefined
                      ? "Loading…"
                      : autoFocusOn
                        ? "Camera focuses automatically"
                        : "Manual — use Focus near/far"}
                  </div>
                </div>
                <Switch
                  checked={autoFocusOn === true}
                  disabled={autoFocusOn === undefined || autoFocusBusy}
                  onCheckedChange={(v) => void toggleAutoFocus(v)}
                />
              </div>
            )}
          </div>

          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
                Presets ({presets.length})
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void refresh()}
                className="gap-1"
              >
                <RefreshCw size={12} />
                Refresh
              </Button>
            </div>

            {presets.length === 0 ? (
              <div className="text-[11px] text-[var(--color-foreground-muted)] py-2">
                No presets saved. Use the form below to save the current position.
              </div>
            ) : (
              <div className="flex flex-col gap-1 max-h-[260px] overflow-auto">
                {presets.map((p) => {
                  const isConfirming = confirmDeleteId === p.id;
                  return (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-[11px] text-[var(--color-foreground-muted)] w-6 shrink-0">
                          #{p.id}
                        </span>
                        <span className="text-xs text-[var(--color-foreground)] truncate">
                          {p.name || "(unnamed)"}
                        </span>
                      </div>
                      {isConfirming ? (
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              setConfirmDeleteId(null);
                              void deletePreset(p.id);
                            }}
                            disabled={busy === `del-${p.id}`}
                            className="px-2"
                          >
                            Delete
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmDeleteId(null)}
                            disabled={busy === `del-${p.id}`}
                            className="px-2"
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void goto(p.id)}
                            disabled={busy === `goto-${p.id}`}
                            className="gap-1 px-2"
                            title="Move camera to this preset"
                          >
                            <Crosshair size={12} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void savePreset(p.id, p.name || `Preset ${p.id}`)}
                            disabled={busy === `save-${p.id}`}
                            className="gap-1 px-2"
                            title="Overwrite with current position"
                          >
                            <Save size={12} />
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => setConfirmDeleteId(p.id)}
                            disabled={busy === `del-${p.id}`}
                            className="gap-1 px-2"
                            title="Delete preset"
                          >
                            <Trash2 size={12} />
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)] mb-2">
                Save current position
              </div>
              <div className="flex flex-col gap-2">
                <Input
                  type="text"
                  value={newName}
                  placeholder="Name (e.g. Front door)"
                  onChange={(e) => setNewName(e.currentTarget.value)}
                />
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={64}
                    value={newId}
                    onChange={(e) => setNewId(Number(e.currentTarget.value))}
                    className="w-[88px]"
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy === `save-${newId}` || newName.trim().length === 0}
                    onClick={() => {
                      const name = newName.trim();
                      if (!name) return;
                      void savePreset(newId, name).then(() => setNewName(""));
                    }}
                    className="gap-1 flex-1"
                  >
                    <Save size={12} />
                    Save preset
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}

interface DPadButtonProps {
  onPress: () => void;
  onRelease: () => void;
  title?: string;
  children: React.ReactNode;
}

function DPadButton({ onPress, onRelease, title, children }: DPadButtonProps) {
  const release = () => onRelease();
  return (
    <button
      type="button"
      title={title}
      className="flex items-center justify-center w-10 h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-accent,#22d3ee)]/20 active:border-[var(--color-accent,#22d3ee)]/50 transition-colors"
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
