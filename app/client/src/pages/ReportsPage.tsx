import { useState, useEffect, useCallback } from "react";
import { trpcQuery, trpcMutation } from "../api";

interface ReportEntry {
  reportId: string;
  cameraId: string;
  profile: string;
  channel: number;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
}

export default function ReportsPage() {
  const [reports, setReports] = useState<ReportEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedReport, setExpandedReport] = useState<string | null>(null);
  const [reportData, setReportData] = useState<Record<string, any>>({});
  const [deleting, setDeleting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await trpcQuery<ReportEntry[]>("diagnostics.list", {});
      setReports(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const viewReport = async (id: string) => {
    if (expandedReport === id) {
      setExpandedReport(null);
      return;
    }
    if (!reportData[id]) {
      try {
        const data = await trpcQuery<any>("diagnostics.download", { reportId: id });
        setReportData((prev) => ({ ...prev, [id]: data }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setExpandedReport(id);
  };

  const downloadReport = (id: string) => {
    const data = reportData[id];
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const deleteReport = async (id: string) => {
    if (!confirm("Delete this report?")) return;
    setDeleting(id);
    try {
      await trpcMutation("diagnostics.delete", { reportId: id });
      setReports((prev) => prev.filter((r) => r.reportId !== id));
      if (expandedReport === id) setExpandedReport(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <h1 className="text-lg font-bold m-0 text-[var(--color-foreground)]">Reports</h1>
        <button
          className="border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] px-3 py-2 rounded-[10px] cursor-pointer text-sm hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-[14px] border border-red-500/50 bg-[var(--color-surface)] p-3 mb-3 flex items-center gap-2">
          <span className="text-red-400 text-xs flex-1">{error}</span>
          <button
            className="border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] px-2 py-1 rounded-[10px] cursor-pointer text-xs hover:bg-[var(--color-surface-hover)] transition-colors"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Empty state */}
      {!loading && reports.length === 0 && (
        <div className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center text-[var(--color-foreground-muted)]">
          No reports yet. Use the &quot;Analyze&quot; button on any stream to create one.
        </div>
      )}

      {/* Report list */}
      {reports.map((r) => (
        <div
          key={r.reportId}
          className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-2"
        >
          {/* Report row */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-[var(--color-foreground)]">{r.cameraId}</span>
              <span className="text-xs px-2 py-1 rounded-full border border-[var(--color-border)] bg-white/[0.04] text-[var(--color-foreground-muted)]">
                {r.profile}
              </span>
              {r.channel > 0 && (
                <span className="text-xs px-2 py-1 rounded-full border border-[var(--color-border)] bg-white/[0.04] text-[var(--color-foreground-muted)]">
                  ch{r.channel}
                </span>
              )}
              <span className="text-[11px] text-[var(--color-foreground-muted)]">
                {new Date(r.startedAt).toLocaleString()}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                className="border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] px-2 py-1 rounded-[10px] cursor-pointer text-[11px] hover:bg-[var(--color-surface-hover)] transition-colors"
                onClick={() => void viewReport(r.reportId)}
              >
                {expandedReport === r.reportId ? "Hide" : "View"}
              </button>
              <button
                className="border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] px-2 py-1 rounded-[10px] cursor-pointer text-[11px] hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                disabled={!reportData[r.reportId]}
                onClick={() => downloadReport(r.reportId)}
              >
                Download
              </button>
              <button
                className="border border-red-500/50 bg-red-500/[0.18] text-[var(--color-foreground)] px-2 py-1 rounded-[10px] cursor-pointer text-[11px] hover:bg-red-500/25 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                disabled={deleting === r.reportId}
                onClick={() => void deleteReport(r.reportId)}
              >
                {deleting === r.reportId ? "..." : "Delete"}
              </button>
            </div>
          </div>

          {/* Expanded report details */}
          {expandedReport === r.reportId && reportData[r.reportId] && (
            <div className="mt-3 border-t border-[var(--color-border)] pt-3">
              {(() => {
                const d = reportData[r.reportId];
                return (
                  <>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <div className="text-[var(--color-foreground-muted)] text-[12px] mb-1">Duration</div>
                        <div className="text-[var(--color-foreground)]">{d.durationSeconds}s</div>
                      </div>
                      <div>
                        <div className="text-[var(--color-foreground-muted)] text-[12px] mb-1">Codec</div>
                        <div className="text-[var(--color-foreground)]">{d.video?.codec ?? "\u2014"}</div>
                      </div>
                      <div>
                        <div className="text-[var(--color-foreground-muted)] text-[12px] mb-1">Resolution</div>
                        <div className="text-[var(--color-foreground)]">
                          {d.video?.resolution ? `${d.video.resolution.width}x${d.video.resolution.height}` : "\u2014"}
                        </div>
                      </div>
                      <div>
                        <div className="text-[var(--color-foreground-muted)] text-[12px] mb-1">FPS (avg)</div>
                        <div className="text-[var(--color-foreground)]">{d.video?.fpsAvg?.toFixed(1) ?? "\u2014"}</div>
                      </div>
                      <div>
                        <div className="text-[var(--color-foreground-muted)] text-[12px] mb-1">Bitrate (avg)</div>
                        <div className="text-[var(--color-foreground)]">
                          {d.video?.bitrateAvgKbps ? `${d.video.bitrateAvgKbps} kbps` : "\u2014"}
                        </div>
                      </div>
                      <div>
                        <div className="text-[var(--color-foreground-muted)] text-[12px] mb-1">Keyframe Interval</div>
                        <div className="text-[var(--color-foreground)]">
                          {d.video?.keyframeIntervalAvgMs ? `${d.video.keyframeIntervalAvgMs}ms` : "\u2014"}
                        </div>
                      </div>
                      <div>
                        <div className="text-[var(--color-foreground-muted)] text-[12px] mb-1">Audio</div>
                        <div className="text-[var(--color-foreground)]">
                          {d.audio?.detected
                            ? `${d.audio.codec ?? "yes"} ${d.audio.sampleRate ? `@ ${d.audio.sampleRate}Hz` : ""}`
                            : "No"}
                        </div>
                      </div>
                      <div>
                        <div className="text-[var(--color-foreground-muted)] text-[12px] mb-1">Protocol Frames</div>
                        <div className="text-[var(--color-foreground)]">{d.protocol?.totalBaichuanFrames ?? "\u2014"}</div>
                      </div>
                    </div>

                    {d.events && d.events.length > 0 && (
                      <div className="mt-3">
                        <div className="text-[var(--color-foreground-muted)] text-[12px] mb-1">
                          Events ({d.events.length})
                        </div>
                        <div className="max-h-[200px] overflow-auto text-[11px]">
                          <table className="w-full border-collapse">
                            <thead>
                              <tr>
                                {["Time", "Type", "Severity", "Details"].map((h) => (
                                  <th
                                    key={h}
                                    className="text-left px-2.5 py-2 border-b border-[var(--color-border)] text-[var(--color-foreground-muted)] text-xs font-semibold"
                                  >
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {d.events.map((ev: any, i: number) => (
                                <tr key={i}>
                                  <td className="px-2.5 py-2 border-b border-[var(--color-border)] font-mono align-top text-[var(--color-foreground)]">
                                    {(ev.offsetMs / 1000).toFixed(1)}s
                                  </td>
                                  <td className="px-2.5 py-2 border-b border-[var(--color-border)] align-top">
                                    <span
                                      className={`text-xs px-2 py-0.5 rounded-full border ${
                                        ev.severity === "error"
                                          ? "text-red-200 border-red-500/40"
                                          : "text-yellow-200 border-yellow-500/40"
                                      }`}
                                    >
                                      {ev.type}
                                    </span>
                                  </td>
                                  <td className="px-2.5 py-2 border-b border-[var(--color-border)] align-top text-[var(--color-foreground)]">
                                    {ev.severity}
                                  </td>
                                  <td className="px-2.5 py-2 border-b border-[var(--color-border)] align-top max-w-[200px] overflow-hidden text-ellipsis text-[var(--color-foreground)]">
                                    {ev.details}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {(!d.events || d.events.length === 0) && (
                      <div className="mt-2 text-[11px] text-[var(--color-foreground-muted)]">No issues detected</div>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
