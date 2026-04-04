import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@camstack/ui-library';
import type { AddCameraInput } from "./types";
import { useConnectionLogs } from "./hooks/useConnectionLogs";


function levelColor(level: string): string {
  if (level === "error") return "text-[var(--color-danger)]";
  if (level === "warn")  return "text-[var(--color-warning)]";
  if (level === "debug") return "text-[var(--color-foreground-muted)]";
  return "text-[var(--color-foreground)]";
}

/** Sentinel messages emitted by the backend to signal detection outcome. */
const DETECTION_SUCCESS = "__detection_success__";
const DETECTION_FAILED = "__detection_failed__";

type DetectionStatus = "detecting" | "success" | "failed";

export function AddCameraDialog({
  open,
  onOpenChange,
  adding,
  setAdding,
  onAdd,
  connectedCameraId,
  onRefresh,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adding: AddCameraInput;
  setAdding: (v: AddCameraInput) => void;
  onAdd: () => Promise<void>;
  connectedCameraId?: string | null;
  onRefresh?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const rawLogs = useConnectionLogs(connectedCameraId);

  // Derive detection status from sentinel messages and filter them out of display
  const { displayLogs, status } = useMemo(() => {
    let s = "detecting" as DetectionStatus;
    const filtered = rawLogs.filter((l) => {
      if (l.msg === DETECTION_SUCCESS) { s = "success"; return false; }
      if (l.msg === DETECTION_FAILED) { s = "failed"; return false; }
      return true;
    });
    return { displayLogs: filtered, status: s };
  }, [rawLogs, connectedCameraId]);

  async function handleRetry() {
    setRetrying(true);
    try {
      // Re-run the full add flow (generates new temp ID, re-runs autodetect)
      await onAdd();
    } catch {
      // errors will appear in the log stream
    } finally {
      setRetrying(false);
    }
  }

  function handleClose() {
    if (status === "success") {
      onRefresh?.();
    }
    onOpenChange(false);
  }

  // Auto-scroll to bottom as new log lines arrive
  useEffect(() => {
    const box = logBoxRef.current;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
  }, [rawLogs]);

  function handleCopy() {
    const text = displayLogs
      .map((l) => {
        const ts = new Date(l.ts).toLocaleTimeString();
        return `[${ts}] ${l.level.toUpperCase()} ${l.msg}`;
      })
      .join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width="sm" className="m-auto bg-[var(--color-background-elevated)] text-[var(--color-foreground)] border-[var(--color-border)]">
        <DialogHeader>
          <DialogTitle>Add camera</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 mt-1">
          {/* Input fields — hidden once detection is running */}
          {!connectedCameraId && (
            <>
              <div>
                <label className="block text-xs text-foreground-muted mb-1">
                  Name (optional)
                </label>
                <input
                  className="input w-full"
                  value={adding.name ?? ""}
                  onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-foreground-muted mb-1">
                    Host
                  </label>
                  <input
                    className="input w-full"
                    value={adding.host}
                    onChange={(e) =>
                      setAdding({ ...adding, host: e.target.value })
                    }
                  />
                </div>
                <div>
                  <label className="block text-xs text-foreground-muted mb-1">
                    Port
                  </label>
                  <input
                    className="input w-full"
                    type="number"
                    value={adding.port ?? 9000}
                    onChange={(e) =>
                      setAdding({ ...adding, port: Number(e.target.value) })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-foreground-muted mb-1">
                    Username
                  </label>
                  <input
                    className="input w-full"
                    value={adding.username}
                    onChange={(e) =>
                      setAdding({ ...adding, username: e.target.value })
                    }
                  />
                </div>
                <div>
                  <label className="block text-xs text-foreground-muted mb-1">
                    Password
                  </label>
                  <input
                    className="input w-full"
                    type="password"
                    value={adding.password}
                    onChange={(e) =>
                      setAdding({ ...adding, password: e.target.value })
                    }
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-foreground-muted mb-1">
                  UID <span className="text-foreground-muted/60">(optional, for battery cameras)</span>
                </label>
                <input
                  className="input w-full"
                  value={adding.uid ?? ""}
                  placeholder="e.g. ABCDEF1234567890"
                  onChange={(e) => setAdding({ ...adding, uid: e.target.value || undefined })}
                />
              </div>
            </>
          )}

          {/* Connection log panel — visible once detection starts */}
          {connectedCameraId && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-foreground-muted">Connection log</span>
                <div className="flex items-center gap-2">
                  {status === "failed" && (
                    <button
                      type="button"
                      className="text-xs text-[var(--color-warning)] hover:text-[var(--color-foreground)] transition-colors disabled:opacity-50"
                      onClick={() => void handleRetry()}
                      disabled={retrying}
                    >
                      {retrying ? "Retrying…" : "Retry"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-xs text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] transition-colors"
                    onClick={handleCopy}
                    disabled={displayLogs.length === 0}
                  >
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
              <div
                ref={logBoxRef}
                className="h-36 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-background)] p-2 font-mono text-[11px] leading-relaxed"
              >
                {displayLogs.length === 0 ? (
                  <span className="text-[var(--color-foreground-muted)]">Waiting for connection…</span>
                ) : (
                  displayLogs.map((l, i) => {
                    const ts = new Date(l.ts).toLocaleTimeString();
                    return (
                      <div key={i} className={`whitespace-pre-wrap break-all ${levelColor(l.level)}`}>
                        <span className="text-[var(--color-foreground-muted)] select-none">{ts} </span>
                        {l.msg}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Status banner */}
              {status === "success" && (
                <div className="flex items-center gap-2 rounded-md bg-[var(--color-success)]/10 border border-[var(--color-success)]/30 px-3 py-2 text-xs text-[var(--color-success)]">
                  <span>Camera added successfully</span>
                </div>
              )}
              {status === "failed" && (
                <div className="flex items-center gap-2 rounded-md bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 px-3 py-2 text-xs text-[var(--color-danger)]">
                  <span>Detection failed — check log above</span>
                </div>
              )}
              {status === "detecting" && (
                <div className="flex items-center gap-2 rounded-md bg-[var(--color-surface-hover)] px-3 py-2 text-xs text-[var(--color-foreground-muted)]">
                  <span className="animate-pulse">Detecting device…</span>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {connectedCameraId ? (
            <>
              {status === "failed" && (
                <Button
                  variant="secondary"
                  onClick={() => void handleRetry()}
                  disabled={retrying}
                >
                  {retrying ? "Retrying…" : "Retry"}
                </Button>
              )}
              <Button onClick={handleClose}>
                {status === "success" ? "Done" : "Close"}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void onAdd()}
                disabled={!adding.host || !adding.username || !adding.password}
              >
                Add
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
