import { useState, useEffect, useCallback, useRef } from "react";
import { trpcQuery, trpcMutation } from "../api";
import { CheckCircle2, Circle, AlertCircle, Loader2, Wand2 } from "lucide-react";

interface NetIface {
  id: string;
  description: string;
}

interface InterfaceTestResult {
  iface: string;
  packetCount: number;
  routeSuggested: boolean;
  errorHint?: string;
}

interface CameraOpt {
  id: string;
  name: string;
  host: string;
  status?: string;
}

interface CmdSeen {
  cmdId: number;
  names: string[] | undefined;
  count: number;
  lastBodyHexPreview: string | undefined;
  lastResponseCode: number | undefined;
}

type CapturePhase =
  | "starting"
  | "running"
  | "nonce-acquired"
  | "authenticated"
  | "stopped"
  | "error";

interface CaptureStatus {
  id: string;
  phase: CapturePhase;
  cameraHost: string;
  cameraName: string;
  iface: string;
  startedAt: number;
  stoppedAt?: number;
  errorMessage?: string;
  framesDecoded: number;
  pcapBytes: number;
  knownCmds: CmdSeen[];
  unknownCmds: CmdSeen[];
}

const PHASE_STEPS: Array<{
  id: string;
  label: string;
  hint: string;
  match: (s: CaptureStatus) => boolean;
}> = [
  {
    id: "started",
    label: "tshark capture started",
    hint: "Wireshark is filtering the camera's TCP 9000 traffic on the chosen interface.",
    match: (s) =>
      s.phase === "running" ||
      s.phase === "nonce-acquired" ||
      s.phase === "authenticated" ||
      (s.phase === "stopped" && s.framesDecoded > 0),
  },
  {
    id: "nonce",
    label: "Auth handshake observed (nonce captured)",
    hint: "Open the official Reolink mobile or desktop app and connect to this camera so the protocol challenge fires.",
    match: (s) =>
      s.phase === "nonce-acquired" ||
      s.phase === "authenticated" ||
      (s.phase === "stopped" &&
        s.knownCmds.some((c) => c.cmdId === 1 && c.lastResponseCode === 56594)),
  },
  {
    id: "auth",
    label: "Login successful — full conversation now visible",
    hint: "Once you see this you can perform the action you want to capture (PTZ move, AI toggle, settings change, etc.).",
    match: (s) => s.phase === "authenticated",
  },
];

export default function CapturePage() {
  const [interfaces, setInterfaces] = useState<NetIface[]>([]);
  const [cameras, setCameras] = useState<CameraOpt[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string>("");
  const [selectedIface, setSelectedIface] = useState<string>("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<InterfaceTestResult[] | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // Initial load: cameras + interfaces.
  useEffect(() => {
    void (async () => {
      try {
        const [camList, ifaceData] = await Promise.all([
          trpcQuery<CameraOpt[]>("cameras.list", {}),
          trpcQuery<{ interfaces: NetIface[] }>("capture.listInterfaces", {}),
        ]);
        setCameras(camList ?? []);
        setInterfaces(ifaceData.interfaces ?? []);
        if (camList?.[0]) setSelectedCamera(camList[0].id);
        if (ifaceData.interfaces?.[0]) setSelectedIface(ifaceData.interfaces[0].id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // Poll status while a capture is active.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await trpcQuery<CaptureStatus>("capture.getStatus", {
          sessionId: activeId,
        });
        if (!cancelled) setStatus(s);
        if (s.phase === "stopped" || s.phase === "error") {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    pollRef.current = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [activeId]);

  const detectInterface = useCallback(async () => {
    if (!selectedCamera) return;
    setTesting(true);
    setTestResults(null);
    setError(null);
    try {
      const r = await trpcMutation<{ results: InterfaceTestResult[] }>(
        "capture.testInterfaces",
        { cameraId: selectedCamera },
      );
      setTestResults(r.results);
      const best = r.results[0];
      if (best && best.packetCount > 0) {
        setSelectedIface(best.iface);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }, [selectedCamera]);

  const startCapture = useCallback(async () => {
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const r = await trpcMutation<{ sessionId: string }>("capture.start", {
        cameraId: selectedCamera,
        iface: selectedIface,
      });
      setActiveId(r.sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [selectedCamera, selectedIface]);

  const stopCapture = useCallback(async () => {
    if (!activeId) return;
    setBusy(true);
    try {
      await trpcMutation("capture.stop", { sessionId: activeId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [activeId]);

  const resetCapture = useCallback(() => {
    setActiveId(null);
    setStatus(null);
  }, []);

  const downloadJson = () => {
    if (!activeId) return;
    const url = `/api/capture/${activeId}/export`;
    window.open(url, "_blank");
  };

  const downloadPcap = () => {
    if (!activeId) return;
    const url = `/api/capture/${activeId}/pcap`;
    window.open(url, "_blank");
  };

  const isRunning =
    status &&
    status.phase !== "stopped" &&
    status.phase !== "error";
  const isStopped = status && (status.phase === "stopped" || status.phase === "error");

  return (
    <div className="p-4 max-w-5xl">
      <h1 className="text-lg font-bold m-0 text-[var(--color-foreground)] mb-1">
        Packet capture
      </h1>
      <p className="text-xs text-[var(--color-foreground-muted)] mb-4">
        Live wireshark/tshark capture filtered to a single camera. Use it to
        diagnose protocol issues or to attach a sanitized trace to a feature
        request on GitHub. Login bodies are always redacted before download.
      </p>

      {error && (
        <div className="rounded-[14px] border border-red-500/50 bg-[var(--color-surface)] p-3 mb-3 flex items-start gap-2">
          <AlertCircle size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
          <span className="text-red-200 text-xs flex-1 whitespace-pre-wrap">{error}</span>
          <button
            className="text-xs text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Selector / start panel */}
      {!activeId && (
        <div className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs text-[var(--color-foreground-muted)]">
              Camera
              <select
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-2 text-sm"
                value={selectedCamera}
                onChange={(e) => setSelectedCamera(e.target.value)}
                disabled={cameras.length === 0}
              >
                {cameras.length === 0 && <option value="">No cameras configured</option>}
                {cameras.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.host}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--color-foreground-muted)]">
              <span className="flex items-center justify-between gap-2">
                Network interface
                <button
                  type="button"
                  className="flex items-center gap-1 text-[11px] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] disabled:opacity-50"
                  onClick={() => void detectInterface()}
                  disabled={!selectedCamera || testing}
                  title="Probe each interface for camera traffic"
                >
                  {testing ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Wand2 size={12} />
                  )}
                  Auto-detect
                </button>
              </span>
              <select
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-2 text-sm"
                value={selectedIface}
                onChange={(e) => setSelectedIface(e.target.value)}
                disabled={interfaces.length === 0}
              >
                {interfaces.length === 0 && <option value="">tshark not available</option>}
                {interfaces.map((i) => {
                  const probed = testResults?.find((r) => r.iface === i.id);
                  const note = probed
                    ? ` — ${probed.packetCount} pkt${probed.routeSuggested ? " ★" : ""}`
                    : "";
                  return (
                    <option key={i.id} value={i.id}>
                      {i.id}
                      {i.description && i.description !== i.id ? ` (${i.description})` : ""}
                      {note}
                    </option>
                  );
                })}
              </select>
            </label>
          </div>
          {testResults && (
            <div className="mt-2 text-[11px] text-[var(--color-foreground-muted)]">
              {testResults[0] && testResults[0].packetCount > 0 ? (
                <>
                  Best match:{" "}
                  <strong className="text-[var(--color-foreground)]">{testResults[0].iface}</strong>
                  {" "}saw {testResults[0].packetCount} packet
                  {testResults[0].packetCount === 1 ? "" : "s"} from this camera
                  {testResults[0].routeSuggested && " (matches OS routing table)"}.
                </>
              ) : (
                <>
                  No interface saw camera traffic. Check that the camera is
                  reachable on this host (`ping` it) or that tshark has
                  permission to read packets.
                </>
              )}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <button
              className="rounded-md border border-[var(--color-accent,#22d3ee)]/50 bg-[var(--color-accent,#22d3ee)]/10 text-[var(--color-foreground)] px-4 py-2 text-sm hover:bg-[var(--color-accent,#22d3ee)]/20 disabled:opacity-50"
              onClick={() => void startCapture()}
              disabled={busy || !selectedCamera || !selectedIface}
            >
              {busy ? "Starting…" : "Start capture"}
            </button>
          </div>
        </div>
      )}

      {/* Live progress */}
      {status && (
        <>
          <div className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-3">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-sm font-semibold text-[var(--color-foreground)]">
                  {status.cameraName}
                </div>
                <div className="text-[11px] text-[var(--color-foreground-muted)]">
                  iface {status.iface} · {status.framesDecoded} frames ·{" "}
                  {(status.pcapBytes / 1024).toFixed(1)} KB on disk
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isRunning && (
                  <button
                    className="rounded-md border border-red-500/50 bg-red-500/10 text-red-200 px-3 py-1.5 text-xs hover:bg-red-500/20 disabled:opacity-50"
                    onClick={() => void stopCapture()}
                    disabled={busy}
                  >
                    Stop capture
                  </button>
                )}
                {isStopped && (
                  <button
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] px-3 py-1.5 text-xs hover:bg-[var(--color-surface-hover)]"
                    onClick={resetCapture}
                  >
                    New capture
                  </button>
                )}
              </div>
            </div>

            <ol className="space-y-2">
              {PHASE_STEPS.map((step) => {
                const done = step.match(status);
                return (
                  <li key={step.id} className="flex items-start gap-2">
                    {done ? (
                      <CheckCircle2 size={18} className="text-green-400 mt-0.5 flex-shrink-0" />
                    ) : isRunning ? (
                      <Loader2 size={18} className="text-[var(--color-foreground-muted)] mt-0.5 flex-shrink-0 animate-spin" />
                    ) : (
                      <Circle size={18} className="text-[var(--color-foreground-subtle)] mt-0.5 flex-shrink-0" />
                    )}
                    <div className="flex-1">
                      <div
                        className={`text-sm ${done ? "text-[var(--color-foreground)]" : "text-[var(--color-foreground-muted)]"}`}
                      >
                        {step.label}
                      </div>
                      {!done && isRunning && (
                        <div className="text-[11px] text-[var(--color-foreground-muted)] mt-0.5">
                          {step.hint}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>

            {status.phase === "error" && status.errorMessage && (
              <div className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-200">
                {status.errorMessage}
              </div>
            )}

            {isStopped && status.phase !== "error" && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] px-3 py-1.5 text-xs hover:bg-[var(--color-surface-hover)]"
                  onClick={downloadJson}
                >
                  Download sanitized JSON
                </button>
                <button
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] px-3 py-1.5 text-xs hover:bg-[var(--color-surface-hover)]"
                  onClick={downloadPcap}
                >
                  Download redacted pcap
                </button>
                <span className="text-[11px] text-[var(--color-foreground-muted)]">
                  Saved to Reports — login XML is wiped, everything else (incl.
                  the nonce so the conversation can be decrypted) is kept.
                </span>
              </div>
            )}
          </div>

          {/* Cmd tables */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <CmdTable
              title="Known commands"
              hint="Recognized cmd_ids. Use the count to see what the official app calls per action."
              cmds={status.knownCmds}
            />
            <CmdTable
              title="Unknown commands"
              hint="cmd_ids that aren't in the SDK constants table — these are great candidates for a feature request."
              cmds={status.unknownCmds}
              showBodyPreview
            />
          </div>
        </>
      )}
    </div>
  );
}

interface CmdTableProps {
  title: string;
  hint: string;
  cmds: CmdSeen[];
  showBodyPreview?: boolean;
}

function CmdTable({ title, hint, cmds, showBodyPreview }: CmdTableProps) {
  return (
    <div className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
          {title}
        </div>
        <div className="text-[11px] text-[var(--color-foreground-muted)]">
          {hint}
        </div>
      </div>
      {cmds.length === 0 ? (
        <div className="text-[11px] text-[var(--color-foreground-muted)] py-4 text-center">
          —
        </div>
      ) : (
        <div className="max-h-[400px] overflow-auto">
          <table className="w-full text-[11px]">
            <thead className="text-left text-[var(--color-foreground-muted)] sticky top-0 bg-[var(--color-surface)]">
              <tr>
                <th className="py-1 pr-2">cmd_id</th>
                <th className="py-1 pr-2">name</th>
                <th className="py-1 pr-2 text-right">count</th>
                <th className="py-1 pr-2">last code</th>
                {showBodyPreview && <th className="py-1">body preview</th>}
              </tr>
            </thead>
            <tbody>
              {cmds.map((c) => (
                <tr key={c.cmdId} className="border-t border-[var(--color-border)]">
                  <td className="py-1 pr-2 font-mono text-[var(--color-foreground)]">{c.cmdId}</td>
                  <td className="py-1 pr-2 text-[var(--color-foreground)]">
                    {c.names && c.names.length > 0 ? c.names.join(" / ") : <span className="text-[var(--color-foreground-muted)]">(unknown)</span>}
                  </td>
                  <td className="py-1 pr-2 text-right font-mono text-[var(--color-foreground)]">{c.count}</td>
                  <td className="py-1 pr-2 font-mono text-[var(--color-foreground-muted)]">
                    {c.lastResponseCode ?? "—"}
                  </td>
                  {showBodyPreview && (
                    <td className="py-1 font-mono text-[10px] text-[var(--color-foreground-muted)] break-all">
                      {c.lastBodyHexPreview ?? "—"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
