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

interface DumpEntry {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

interface CaptureReport {
  id: string;
  cameraDisplayName: string;
  iface: string;
  startedAt: number;
  stoppedAt: number;
  durationMs: number;
  framesDecoded: number;
  knownCmdCount: number;
  unknownCmdCount: number;
  phase: string;
  hasRawPcap: boolean;
  rawPcapBytes: number;
  redactedBytes: number;
  redactedLoginFrames: number;
}

export default function ReportsPage() {
  const [reports, setReports] = useState<ReportEntry[]>([]);
  const [dumps, setDumps] = useState<DumpEntry[]>([]);
  const [captures, setCaptures] = useState<CaptureReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedReport, setExpandedReport] = useState<string | null>(null);
  const [reportData, setReportData] = useState<Record<string, any>>({});
  const [deleting, setDeleting] = useState<string | null>(null);
  const [downloadingDump, setDownloadingDump] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [reportList, dumpList, captureList] = await Promise.all([
        trpcQuery<ReportEntry[]>("diagnostics.list", {}),
        trpcQuery<DumpEntry[]>("cameras.listDumps", {}),
        trpcQuery<{ reports: CaptureReport[] }>("capture.listSaved", {}),
      ]);
      setReports(reportList);
      setDumps(dumpList);
      setCaptures(captureList?.reports ?? []);
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

  const downloadDump = async (filename: string) => {
    setDownloadingDump(filename);
    try {
      const result = await trpcMutation<{ token: string; filename: string }>(
        "cameras.downloadDump",
        { filename },
      );
      const link = document.createElement("a");
      link.href = `/api/dump/${result.token}`;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadingDump(null);
    }
  };

  const deleteDump = async (filename: string) => {
    if (!confirm("Delete this dump?")) return;
    setDeleting(filename);
    try {
      await trpcMutation("cameras.deleteDump", { filename });
      setDumps((prev) => prev.filter((d) => d.filename !== filename));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const btnClass =
    "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] px-2 py-1 rounded-[10px] cursor-pointer text-[11px] hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed";
  const deleteBtnClass =
    "border border-red-500/50 bg-red-500/[0.18] text-[var(--color-foreground)] px-2 py-1 rounded-[10px] cursor-pointer text-[11px] hover:bg-red-500/25 transition-colors disabled:opacity-60 disabled:cursor-not-allowed";

  const deleteCapture = async (id: string) => {
    if (!confirm("Delete this capture report?")) return;
    setDeleting(id);
    try {
      await trpcMutation("capture.deleteSaved", { captureId: id });
      setCaptures((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  };

  const isEmpty =
    !loading &&
    reports.length === 0 &&
    dumps.length === 0 &&
    captures.length === 0;

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
          <button className={btnClass} onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Empty state */}
      {isEmpty && (
        <div className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center text-[var(--color-foreground-muted)]">
          No reports yet. Use &quot;Analyze&quot; on a stream or &quot;Dump&quot; on a camera to create one.
        </div>
      )}

      {/* Model Fixture Dumps */}
      {dumps.length > 0 && (
        <>
          <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
            Model Fixture Dumps
          </div>
          {dumps.map((d) => (
            <div
              key={d.filename}
              className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-2"
            >
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-[var(--color-foreground)]">
                    {d.filename.replace(".zip", "")}
                  </span>
                  <span className="text-xs px-2 py-1 rounded-full border border-[var(--color-border)] bg-white/[0.04] text-[var(--color-foreground-muted)]">
                    {formatSize(d.sizeBytes)}
                  </span>
                  <span className="text-[11px] text-[var(--color-foreground-muted)]">
                    {new Date(d.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    className={btnClass}
                    disabled={downloadingDump === d.filename}
                    onClick={() => void downloadDump(d.filename)}
                  >
                    {downloadingDump === d.filename ? "..." : "Download"}
                  </button>
                  <button
                    className={deleteBtnClass}
                    disabled={deleting === d.filename}
                    onClick={() => void deleteDump(d.filename)}
                  >
                    {deleting === d.filename ? "..." : "Delete"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {/* Packet Capture Reports */}
      {captures.length > 0 && (
        <>
          <div className="mb-2 mt-4 text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
            Packet Captures
          </div>
          {captures.map((c) => (
            <CaptureReportCard
              key={c.id}
              capture={c}
              deleting={deleting}
              btnClass={btnClass}
              deleteBtnClass={deleteBtnClass}
              onDelete={() => void deleteCapture(c.id)}
              formatSize={formatSize}
            />
          ))}
        </>
      )}

      {/* Stream Analysis Reports */}
      {reports.length > 0 && (
        <>
          <div className="mb-2 mt-4 text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
            Stream Analysis Reports
          </div>
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
                  <button className={btnClass} onClick={() => void viewReport(r.reportId)}>
                    {expandedReport === r.reportId ? "Hide" : "View"}
                  </button>
                  <button
                    className={btnClass}
                    disabled={!reportData[r.reportId]}
                    onClick={() => downloadReport(r.reportId)}
                  >
                    Download
                  </button>
                  <button
                    className={deleteBtnClass}
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
        </>
      )}
    </div>
  );
}

interface CaptureFrameEntry {
  offsetMs: number;
  direction: "c2s" | "s2c";
  cmdId: number;
  cmdNames: string[] | undefined;
  msgNum: number;
  channelId: number;
  responseCode: number;
  bodyLen: number;
  bodyHexPreview: string;
  bodyDecrypted: string | null;
}

interface CaptureManifest {
  version: number;
  summary: CaptureReport;
  sanitizedExport: {
    cmdSummary: Array<{
      cmdId: number;
      cmdNames: string[] | undefined;
      count: number;
      lastResponseCode: number | undefined;
      lastBodyHexPreview: string | undefined;
    }>;
    frames: CaptureFrameEntry[];
  };
}

function CaptureReportCard({
  capture,
  deleting,
  btnClass,
  deleteBtnClass,
  onDelete,
  formatSize,
}: {
  capture: CaptureReport;
  deleting: string | null;
  btnClass: string;
  deleteBtnClass: string;
  onDelete: () => void;
  formatSize: (bytes: number) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [manifest, setManifest] = useState<CaptureManifest | null>(null);
  const [loadingManifest, setLoadingManifest] = useState(false);
  const [filter, setFilter] = useState<"all" | "known" | "unknown" | "decrypted">("all");
  const [openFrameIdx, setOpenFrameIdx] = useState<number | null>(null);

  const toggle = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (manifest) return;
    setLoadingManifest(true);
    try {
      const m = await trpcQuery<CaptureManifest>("capture.getSaved", {
        captureId: capture.id,
      });
      setManifest(m);
    } catch (e) {
      console.error("Load manifest failed", e);
    } finally {
      setLoadingManifest(false);
    }
  };

  const filteredFrames = manifest?.sanitizedExport.frames.filter((f) => {
    if (filter === "known") return f.cmdNames && f.cmdNames.length > 0;
    if (filter === "unknown") return !f.cmdNames || f.cmdNames.length === 0;
    if (filter === "decrypted") return f.bodyDecrypted && f.bodyDecrypted !== "" && !f.bodyDecrypted.startsWith("<binary");
    return true;
  }) ?? [];

  return (
    <div className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-[var(--color-foreground)]">
            {capture.cameraDisplayName}
          </span>
          <span className="text-xs px-2 py-1 rounded-full border border-[var(--color-border)] bg-white/[0.04] text-[var(--color-foreground-muted)]">
            {capture.iface}
          </span>
          <span className="text-xs px-2 py-1 rounded-full border border-[var(--color-border)] bg-white/[0.04] text-[var(--color-foreground-muted)]">
            {capture.framesDecoded} frames
          </span>
          <span className="text-xs px-2 py-1 rounded-full border border-[var(--color-border)] bg-white/[0.04] text-[var(--color-foreground-muted)]">
            {capture.knownCmdCount} known / {capture.unknownCmdCount} unknown
          </span>
          <span className="text-[11px] text-[var(--color-foreground-muted)]">
            {new Date(capture.startedAt).toLocaleString()} ·{" "}
            {(capture.durationMs / 1000).toFixed(0)}s
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button className={btnClass} onClick={() => void toggle()}>
            {expanded ? "Hide" : "View"}
          </button>
          <a className={btnClass} href={`/api/capture/${capture.id}/export`}>
            JSON
          </a>
          {capture.hasRawPcap && (
            <a className={btnClass} href={`/api/capture/${capture.id}/pcap`}>
              PCAP {formatSize(capture.rawPcapBytes)}
            </a>
          )}
          <button
            className={deleteBtnClass}
            disabled={deleting === capture.id}
            onClick={onDelete}
          >
            {deleting === capture.id ? "..." : "Delete"}
          </button>
        </div>
      </div>
      {capture.redactedLoginFrames > 0 && (
        <div className="mt-2 text-[10px] text-[var(--color-foreground-muted)]">
          Redacted {capture.redactedLoginFrames} login frame
          {capture.redactedLoginFrames === 1 ? "" : "s"} ({capture.redactedBytes}{" "}
          bytes wiped).
        </div>
      )}

      {expanded && (
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          {loadingManifest && (
            <div className="text-[11px] text-[var(--color-foreground-muted)]">
              Loading…
            </div>
          )}
          {manifest && (
            <>
              <div className="flex items-center gap-2 mb-2 text-[11px]">
                <span className="text-[var(--color-foreground-muted)]">
                  Filter:
                </span>
                {(["all", "known", "unknown", "decrypted"] as const).map((f) => (
                  <button
                    key={f}
                    className={`px-2 py-0.5 rounded border ${
                      filter === f
                        ? "border-[var(--color-accent,#22d3ee)]/50 bg-[var(--color-accent,#22d3ee)]/10 text-[var(--color-foreground)]"
                        : "border-[var(--color-border)] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]"
                    }`}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                  </button>
                ))}
                <span className="ml-auto text-[var(--color-foreground-muted)]">
                  {filteredFrames.length} / {manifest.sanitizedExport.frames.length} frames
                </span>
              </div>
              <div className="max-h-[420px] overflow-auto rounded border border-[var(--color-border)]">
                <table className="w-full text-[11px]">
                  <thead className="text-left text-[var(--color-foreground-muted)] sticky top-0 bg-[var(--color-surface)]">
                    <tr>
                      <th className="py-1 px-2">#</th>
                      <th className="py-1 px-2">dir</th>
                      <th className="py-1 px-2">cmd</th>
                      <th className="py-1 px-2">name</th>
                      <th className="py-1 px-2">msgNum</th>
                      <th className="py-1 px-2">resp</th>
                      <th className="py-1 px-2 text-right">bodyLen</th>
                      <th className="py-1 px-2">body</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFrames.map((fr, i) => {
                      const isOpen = openFrameIdx === i;
                      const decryptedSummary = fr.bodyDecrypted
                        ? fr.bodyDecrypted.startsWith("<")
                          ? fr.bodyDecrypted.slice(0, 60).replace(/\s+/g, " ")
                          : fr.bodyDecrypted
                        : fr.bodyHexPreview;
                      return (
                        <>
                          <tr
                            key={i}
                            className="border-t border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-surface-hover)]"
                            onClick={() => setOpenFrameIdx(isOpen ? null : i)}
                          >
                            <td className="py-1 px-2 font-mono text-[var(--color-foreground-muted)]">{i}</td>
                            <td className="py-1 px-2 font-mono text-[var(--color-foreground-muted)]">{fr.direction}</td>
                            <td className="py-1 px-2 font-mono text-[var(--color-foreground)]">{fr.cmdId}</td>
                            <td className="py-1 px-2 text-[var(--color-foreground)]">
                              {fr.cmdNames?.[0] ?? <span className="text-[var(--color-foreground-muted)]">(unknown)</span>}
                            </td>
                            <td className="py-1 px-2 font-mono text-[var(--color-foreground-muted)]">{fr.msgNum}</td>
                            <td className="py-1 px-2 font-mono text-[var(--color-foreground-muted)]">{fr.responseCode}</td>
                            <td className="py-1 px-2 text-right font-mono text-[var(--color-foreground-muted)]">{fr.bodyLen}</td>
                            <td className="py-1 px-2 font-mono text-[10px] text-[var(--color-foreground-muted)] max-w-[400px] truncate">
                              {decryptedSummary || "—"}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr key={`${i}-detail`}>
                              <td colSpan={8} className="px-2 py-2 bg-[var(--color-background)]/40">
                                <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)] mb-1">
                                  Decrypted body
                                </div>
                                <pre className="text-[11px] text-[var(--color-foreground)] bg-[var(--color-surface)] border border-[var(--color-border)] p-2 rounded overflow-auto max-h-[200px] whitespace-pre-wrap">
{fr.bodyDecrypted || "(not decrypted)"}
                                </pre>
                                <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)] mt-2 mb-1">
                                  Encrypted hex preview
                                </div>
                                <pre className="text-[10px] font-mono text-[var(--color-foreground-muted)] bg-[var(--color-surface)] border border-[var(--color-border)] p-2 rounded overflow-auto max-h-[100px] whitespace-pre-wrap break-all">
{fr.bodyHexPreview || "(empty)"}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
