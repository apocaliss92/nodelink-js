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
    <>
      <div className="header">
        <h1 className="h1">Reports</h1>
        <button className="btn" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="card" style={{ borderColor: "rgba(239,68,68,0.5)", marginBottom: 12 }}>
          <span style={{ color: "#ef4444", fontSize: 12 }}>{error}</span>
          <button className="btn" style={{ marginLeft: 8, fontSize: 11 }} onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {!loading && reports.length === 0 && (
        <div className="card" style={{ color: "var(--muted)", textAlign: "center", padding: 40 }}>
          No reports yet. Use the &quot;Analyze&quot; button on any stream to create one.
        </div>
      )}

      {reports.map((r) => (
        <div key={r.reportId} className="card" style={{ marginBottom: 8 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <span style={{ fontWeight: 600 }}>{r.cameraId}</span>
              <span className="badge" style={{ marginLeft: 8 }}>{r.profile}</span>
              {r.channel > 0 && <span className="badge" style={{ marginLeft: 4 }}>ch{r.channel}</span>}
              <span style={{ color: "var(--muted)", fontSize: 11, marginLeft: 8 }}>
                {new Date(r.startedAt).toLocaleString()}
              </span>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn" style={{ fontSize: 11 }} onClick={() => void viewReport(r.reportId)}>
                {expandedReport === r.reportId ? "Hide" : "View"}
              </button>
              <button
                className="btn"
                style={{ fontSize: 11 }}
                disabled={!reportData[r.reportId]}
                onClick={() => downloadReport(r.reportId)}
              >
                Download
              </button>
              <button
                className="btn danger"
                style={{ fontSize: 11 }}
                disabled={deleting === r.reportId}
                onClick={() => void deleteReport(r.reportId)}
              >
                {deleting === r.reportId ? "..." : "Delete"}
              </button>
            </div>
          </div>

          {expandedReport === r.reportId && reportData[r.reportId] && (
            <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              {(() => {
                const d = reportData[r.reportId];
                return (
                  <>
                    <div className="grid cols2" style={{ fontSize: 12, gap: 8 }}>
                      <div>
                        <div className="label">Duration</div>
                        <div>{d.durationSeconds}s</div>
                      </div>
                      <div>
                        <div className="label">Codec</div>
                        <div>{d.video?.codec ?? "\u2014"}</div>
                      </div>
                      <div>
                        <div className="label">Resolution</div>
                        <div>{d.video?.resolution ? `${d.video.resolution.width}x${d.video.resolution.height}` : "\u2014"}</div>
                      </div>
                      <div>
                        <div className="label">FPS (avg)</div>
                        <div>{d.video?.fpsAvg?.toFixed(1) ?? "\u2014"}</div>
                      </div>
                      <div>
                        <div className="label">Bitrate (avg)</div>
                        <div>{d.video?.bitrateAvgKbps ? `${d.video.bitrateAvgKbps} kbps` : "\u2014"}</div>
                      </div>
                      <div>
                        <div className="label">Keyframe Interval</div>
                        <div>{d.video?.keyframeIntervalAvgMs ? `${d.video.keyframeIntervalAvgMs}ms` : "\u2014"}</div>
                      </div>
                      <div>
                        <div className="label">Audio</div>
                        <div>{d.audio?.detected ? `${d.audio.codec ?? "yes"} ${d.audio.sampleRate ? `@ ${d.audio.sampleRate}Hz` : ""}` : "No"}</div>
                      </div>
                      <div>
                        <div className="label">Protocol Frames</div>
                        <div>{d.protocol?.totalBaichuanFrames ?? "\u2014"}</div>
                      </div>
                    </div>
                    {d.events && d.events.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div className="label" style={{ marginBottom: 4 }}>Events ({d.events.length})</div>
                        <div style={{ maxHeight: 200, overflow: "auto", fontSize: 11 }}>
                          <table className="table" style={{ width: "100%" }}>
                            <thead>
                              <tr>
                                <th>Time</th>
                                <th>Type</th>
                                <th>Severity</th>
                                <th>Details</th>
                              </tr>
                            </thead>
                            <tbody>
                              {d.events.map((ev: any, i: number) => (
                                <tr key={i}>
                                  <td className="mono">{(ev.offsetMs / 1000).toFixed(1)}s</td>
                                  <td><span className={`badge ${ev.severity === "error" ? "err" : "warn"}`}>{ev.type}</span></td>
                                  <td>{ev.severity}</td>
                                  <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{ev.details}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    {(!d.events || d.events.length === 0) && (
                      <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>No issues detected</div>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
