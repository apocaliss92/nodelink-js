import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getStoredAuthToken } from "../authToken";
import { trpcMutation, trpcQuery } from "../api";

type LogEntry = {
  timestamp?: string;
  level: "error" | "warn" | "info" | "debug";
  source?: string;
  message: string;
  meta?: Record<string, unknown>;
};

type WsMsg =
  | { type: "history"; logs: LogEntry[]; append?: boolean }
  | ({ type: "log" } & LogEntry);

type LogFile = {
  filename: string;
  size: number;
  modified: string;
};

function levelBadgeClass(level: LogEntry["level"]): string {
  const base =
    "text-xs px-2 py-0.5 rounded-full border bg-white/[.04] text-[var(--muted)] border-[var(--border)]";
  if (level === "error")
    return `${base} !text-[#fecaca] !border-[rgba(239,68,68,0.4)]`;
  if (level === "warn")
    return `${base} !text-[#fde68a] !border-[rgba(245,158,11,0.4)]`;
  if (level === "info")
    return `${base} !text-[#bbf7d0] !border-[rgba(34,197,94,0.4)]`;
  return base;
}

function formatLocalTime(ts?: string): string {
  if (!ts) return "";

  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;

  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  const opts: Intl.DateTimeFormatOptions = sameDay
    ? {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }
    : {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      };

  return new Intl.DateTimeFormat(undefined, opts).format(d);
}

function formatRest(l: LogEntry): string {
  const meta =
    l.meta && Object.keys(l.meta).length ? ` ${JSON.stringify(l.meta)}` : "";
  return `${l.message}${meta}`;
}

function formatLogLine(l: LogEntry): string {
  const ts = l.timestamp ?? "";
  const src = l.source ?? "";
  return `${ts}\t${src}\t${l.level}\t${l.message}${l.meta && Object.keys(l.meta).length ? " " + JSON.stringify(l.meta) : ""}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Shared input / select style
// ---------------------------------------------------------------------------
const inputCls =
  "bg-black/25 border border-[var(--border)] text-[var(--text)] px-2.5 py-2 rounded-xl text-sm outline-none min-w-[120px]";

// ---------------------------------------------------------------------------
// Shared button styles
// ---------------------------------------------------------------------------
const btnCls =
  "border border-[var(--border)] bg-white/[.06] text-[var(--text)] rounded-xl cursor-pointer text-[11px] px-2 py-0.5 disabled:opacity-60 disabled:cursor-not-allowed";
const btnDangerCls =
  "border border-[rgba(239,68,68,0.5)] bg-[rgba(239,68,68,0.18)] text-[var(--text)] rounded-xl cursor-pointer text-[11px] px-2 py-0.5 disabled:opacity-60 disabled:cursor-not-allowed";

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<"all" | LogEntry["level"]>("all");
  const [source, setSource] = useState<string>("");
  const [text, setText] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);

  // Historical log files
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [loadingFile, setLoadingFile] = useState(false);

  const boxRef = useRef<HTMLDivElement | null>(null);

  // Load list of available log files
  useEffect(() => {
    trpcQuery<LogFile[]>("logs.listFiles")
      .then((files) => setLogFiles(files ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const token = getStoredAuthToken();
    const base = `${proto}://${window.location.host}/ws/logs`;
    const url = token ? `${base}?token=${encodeURIComponent(token)}` : base;
    const ws = new WebSocket(url);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WsMsg;
        if (msg.type === "history") {
          setLogs((prev) => {
            if (msg.append) return [...prev, ...msg.logs];
            return msg.logs;
          });
          return;
        }
        if (msg.type === "log") {
          setLogs((prev) => {
            const next = [msg, ...prev];
            return next.length > 1500 ? next.slice(0, 1500) : next;
          });
        }
      } catch {
        // ignore
      }
    };

    return () => ws.close();
  }, []);

  useEffect(() => {
    if (!autoScroll) return;
    const box = boxRef.current;
    if (!box) return;
    box.scrollTop = 0;
  }, [logs, autoScroll]);

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const l of logs) if (l.source) set.add(l.source);
    return Array.from(set).sort();
  }, [logs]);

  const filtered = useMemo(() => {
    return logs.filter((l) => {
      if (level !== "all" && l.level !== level) return false;
      if (source && l.source !== source) return false;
      if (text) {
        const t = text.toLowerCase();
        const hay = `${l.message} ${l.source ?? ""}`.toLowerCase();
        if (!hay.includes(t)) return false;
      }
      return true;
    });
  }, [logs, level, source, text]);

  const handleClear = useCallback(async () => {
    try {
      await trpcMutation("logs.clear", undefined as any);
      setLogs([]);
    } catch {
      // ignore
    }
  }, []);

  const handleCopy = useCallback(async () => {
    const copyText = filtered.map(formatLogLine).join("\n");
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = copyText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [filtered]);

  const handleLoadFile = useCallback(async (filename: string) => {
    if (!filename) {
      setSelectedFile("");
      return;
    }
    setSelectedFile(filename);
    setLoadingFile(true);
    try {
      const result = await trpcQuery<{
        logs: LogEntry[];
        totalLines: number;
        hasMore: boolean;
      }>("logs.readFile", { filename, lines: 2000 });
      if (result?.logs) {
        setLogs(result.logs);
      }
    } catch {
      // ignore
    } finally {
      setLoadingFile(false);
    }
  }, []);

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-3.5">
        <h1 className="text-lg font-bold m-0">Logs</h1>
        <div className="flex items-center gap-2.5 flex-wrap">
          <span
            className={
              connected
                ? "text-xs px-2 py-0.5 rounded-full border bg-white/[.04] !text-[#bbf7d0] !border-[rgba(34,197,94,0.4)]"
                : "text-xs px-2 py-0.5 rounded-full border bg-white/[.04] !text-[#fde68a] !border-[rgba(245,158,11,0.4)]"
            }
          >
            {connected ? "Live" : "Disconnected"}
          </span>
        </div>
      </div>

      {/* Filters card */}
      <div className="bg-[var(--panel)] border border-[var(--border)] rounded-2xl p-3.5 mb-3">
        {/* Filters row */}
        <div className="flex items-center gap-3 flex-wrap max-sm:flex-col max-sm:items-stretch max-sm:gap-2.5">
          {/* Log source (file picker) */}
          <label className="flex items-center gap-2">
            <span className="text-xs text-[var(--muted)]">Source</span>
            <select
              className={inputCls}
              value={selectedFile}
              onChange={(e) => void handleLoadFile(e.target.value)}
            >
              <option value="">Live (in-memory)</option>
              {logFiles.map((f) => (
                <option key={f.filename} value={f.filename}>
                  {f.filename} ({formatFileSize(f.size)})
                </option>
              ))}
            </select>
          </label>

          {/* Level filter */}
          <label className="flex items-center gap-2">
            <span className="text-xs text-[var(--muted)]">Level</span>
            <select
              className={inputCls}
              value={level}
              onChange={(e) => setLevel(e.target.value as any)}
            >
              <option value="all">all</option>
              <option value="error">error</option>
              <option value="warn">warn</option>
              <option value="info">info</option>
              <option value="debug">debug</option>
            </select>
          </label>

          {/* Source filter */}
          <label className="flex items-center gap-2">
            <span className="text-xs text-[var(--muted)]">Source</span>
            <select
              className={inputCls}
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">all</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          {/* Text search */}
          <div className="flex items-center flex-1 min-w-[180px] max-sm:min-w-0">
            <input
              className={`${inputCls} w-full`}
              placeholder="Search…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>

          {/* Auto-scroll checkbox */}
          <label className="flex items-center gap-2 cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            <span className="text-sm">Auto-scroll</span>
          </label>

          {/* Action buttons */}
          <div className="flex items-center gap-1">
            <button
              className={btnCls}
              onClick={() => void handleCopy()}
              title="Copy filtered logs to clipboard"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              className={btnDangerCls}
              onClick={() => void handleClear()}
              title="Clear in-memory log buffer"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Loading indicator */}
        {loadingFile && (
          <div className="flex items-center gap-1.5 text-[var(--muted)] text-xs mt-1.5">
            <span
              className="inline-block w-3 h-3 rounded-full border-2 border-white/20 border-t-white/80 animate-spin"
              aria-hidden="true"
            />
            <span>Loading log file…</span>
          </div>
        )}

        {/* Entry count */}
        <div className="text-[var(--muted)] text-[11px] mt-1">
          {filtered.length} log{filtered.length !== 1 ? "s" : ""}
          {selectedFile ? ` from ${selectedFile}` : " (live)"}
        </div>
      </div>

      {/* Log output card */}
      <div
        ref={boxRef}
        className="bg-[var(--panel)] border border-[var(--border)] rounded-2xl p-3.5 overflow-auto"
        style={{ height: "calc(100vh - 190px)" }}
      >
        {/* Desktop: table view (hidden on mobile) */}
        <table className="w-full border-collapse table-fixed hidden sm:table">
          <thead>
            <tr>
              <th
                className="text-left text-xs text-[var(--muted)] font-semibold px-2 py-1.5 border-b border-[var(--border)]"
                style={{ width: 100 }}
              >
                Time
              </th>
              <th
                className="text-left text-xs text-[var(--muted)] font-semibold px-2 py-1.5 border-b border-[var(--border)]"
                style={{ width: 120 }}
              >
                Source
              </th>
              <th
                className="text-left text-xs text-[var(--muted)] font-semibold px-2 py-1.5 border-b border-[var(--border)]"
                style={{ width: 80 }}
              >
                Level
              </th>
              <th className="text-left text-xs text-[var(--muted)] font-semibold px-2 py-1.5 border-b border-[var(--border)]">
                Message
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((l, idx) => (
              <tr key={idx}>
                <td className="font-mono text-xs px-2 py-1 border-b border-[var(--border)] align-top">
                  {formatLocalTime(l.timestamp)}
                </td>
                <td className="font-mono text-xs px-2 py-1 border-b border-[var(--border)] align-top">
                  {l.source ?? ""}
                </td>
                <td className="text-xs px-2 py-1 border-b border-[var(--border)] align-top">
                  <span className={levelBadgeClass(l.level)}>{l.level}</span>
                </td>
                <td className="text-xs px-2 py-1 border-b border-[var(--border)] align-top whitespace-pre-wrap break-words leading-snug">
                  {formatRest(l)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Mobile: card view (hidden on sm+) */}
        <div className="sm:hidden">
          {filtered.map((l, idx) => (
            <div
              key={idx}
              className="px-3 py-2.5 border-b border-[var(--border)] last:border-b-0"
            >
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className={levelBadgeClass(l.level)}>{l.level}</span>
                <span className="font-mono text-[11px] text-[var(--muted)]">
                  {l.source ?? ""}
                </span>
                <span className="font-mono text-[11px] text-[var(--muted)] ml-auto">
                  {formatLocalTime(l.timestamp)}
                </span>
              </div>
              <div className="text-[11px] leading-[1.4] break-words whitespace-pre-wrap">
                {formatRest(l)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
