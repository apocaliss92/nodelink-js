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
    "text-[10px] px-2 py-0.5 rounded-md border font-medium capitalize";
  if (level === "error")
    return `${base} bg-[var(--color-danger)]/15 text-[var(--color-danger)] border-[var(--color-danger)]/30`;
  if (level === "warn")
    return `${base} bg-[var(--color-warning)]/15 text-[var(--color-warning)] border-[var(--color-warning)]/30`;
  if (level === "info")
    return `${base} bg-[var(--color-success)]/15 text-[var(--color-success)] border-[var(--color-success)]/30`;
  return `${base} bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)] border-[var(--color-border)]`;
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
// Match SettingsPage surface / form tokens
// ---------------------------------------------------------------------------
const cardCls =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4";

const labelCls =
  "text-xs font-medium text-[var(--color-foreground-muted)] uppercase tracking-wider mb-1.5 block";

const inputCls =
  "w-full min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm text-[var(--color-foreground)] outline-none";

const btnCls =
  "border border-[var(--color-border)] bg-white/[.06] text-[var(--color-foreground)] rounded-md cursor-pointer text-xs px-3 py-1.5 disabled:opacity-60 disabled:cursor-not-allowed";

const btnDangerCls =
  "border border-[rgba(239,68,68,0.5)] bg-[rgba(239,68,68,0.18)] text-[var(--color-foreground)] rounded-md cursor-pointer text-xs px-3 py-1.5 disabled:opacity-60 disabled:cursor-not-allowed";

const thCls =
  "text-left px-2.5 py-2 border-b border-[var(--color-border)] text-[var(--color-foreground-muted)] text-xs font-semibold";

const tdCls =
  "text-xs px-2.5 py-2 border-b border-[var(--color-border)] align-top text-[var(--color-foreground)]";

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
    <div className="p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h1 className="text-lg font-bold m-0">Logs</h1>
        <div className="flex items-center gap-2.5 flex-wrap">
          <span
            className={
              connected
                ? "text-[10px] px-2 py-0.5 rounded-md border font-medium bg-[var(--color-success)]/15 text-[var(--color-success)] border-[var(--color-success)]/30"
                : "text-[10px] px-2 py-0.5 rounded-md border font-medium bg-[var(--color-warning)]/15 text-[var(--color-warning)] border-[var(--color-warning)]/30"
            }
          >
            {connected ? "Live" : "Disconnected"}
          </span>
        </div>
      </div>

      <div className={cardCls}>
        <span className={labelCls}>Filters</span>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-2">
          <div>
            <span className={labelCls}>Log file</span>
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
          </div>
          <div>
            <span className={labelCls}>Level</span>
            <select
              className={inputCls}
              value={level}
              onChange={(e) => setLevel(e.target.value as "all" | LogEntry["level"])}
            >
              <option value="all">All</option>
              <option value="error">error</option>
              <option value="warn">warn</option>
              <option value="info">info</option>
              <option value="debug">debug</option>
            </select>
          </div>
          <div>
            <span className={labelCls}>Component</span>
            <select
              className={inputCls}
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">All</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2 lg:col-span-1">
            <span className={labelCls}>Search</span>
            <input
              className={inputCls}
              placeholder="Filter messages…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4 pt-3 border-t border-[var(--color-border)]">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="rounded border-[var(--color-border)]"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            <span className="text-sm text-[var(--color-foreground)]">Auto-scroll new entries</span>
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className={btnCls}
              onClick={() => void handleCopy()}
              title="Copy filtered logs to clipboard"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              type="button"
              className={btnDangerCls}
              onClick={() => void handleClear()}
              title="Clear in-memory log buffer"
            >
              Clear
            </button>
          </div>
        </div>

        {loadingFile && (
          <div className="flex items-center gap-2 text-[var(--color-foreground-muted)] text-xs mt-3">
            <span
              className="inline-block size-3.5 rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-primary)] animate-spin"
              aria-hidden="true"
            />
            <span>Loading log file…</span>
          </div>
        )}

        <div className="text-[var(--color-foreground-muted)] text-xs mt-3">
          {filtered.length} log{filtered.length !== 1 ? "s" : ""}
          {selectedFile ? ` from ${selectedFile}` : " (live)"}
        </div>
      </div>

      <div
        className={`${cardCls} mt-3 p-0 flex flex-col overflow-hidden`}
        style={{ height: "calc(100vh - 220px)", minHeight: 240 }}
      >
        <div className="px-4 py-2.5 border-b border-[var(--color-border)] text-xs text-[var(--color-foreground-muted)]">
          Log output
        </div>
        <div
          ref={boxRef}
          className="flex-1 overflow-auto p-3 bg-[var(--color-background)]"
        >
          <table className="w-full border-collapse table-fixed hidden sm:table text-sm">
            <thead>
              <tr>
                <th className={thCls} style={{ width: 100 }}>
                  Time
                </th>
                <th className={thCls} style={{ width: 120 }}>
                  Source
                </th>
                <th className={thCls} style={{ width: 88 }}>
                  Level
                </th>
                <th className={thCls}>Message</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l, idx) => (
                <tr key={idx}>
                  <td className={`${tdCls} font-mono text-[var(--color-foreground-muted)]`}>
                    {formatLocalTime(l.timestamp)}
                  </td>
                  <td className={`${tdCls} font-mono text-[var(--color-foreground-muted)]`}>
                    {l.source ?? ""}
                  </td>
                  <td className={tdCls}>
                    <span className={levelBadgeClass(l.level)}>{l.level}</span>
                  </td>
                  <td className={`${tdCls} whitespace-pre-wrap break-words leading-snug`}>
                    {formatRest(l)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="sm:hidden divide-y divide-[var(--color-border)]">
            {filtered.map((l, idx) => (
              <div key={idx} className="py-3 first:pt-0">
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <span className={levelBadgeClass(l.level)}>{l.level}</span>
                  <span className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
                    {l.source ?? ""}
                  </span>
                  <span className="font-mono text-[11px] text-[var(--color-foreground-muted)] ml-auto">
                    {formatLocalTime(l.timestamp)}
                  </span>
                </div>
                <div className="text-xs leading-snug break-words whitespace-pre-wrap text-[var(--color-foreground)]">
                  {formatRest(l)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
