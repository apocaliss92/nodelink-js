import { useEffect, useMemo, useRef, useState } from "react";
import { getStoredAuthToken } from "../authToken";

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

function levelBadge(level: LogEntry["level"]) {
  if (level === "error") return "badge err";
  if (level === "warn") return "badge warn";
  if (level === "info") return "badge ok";
  return "badge";
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

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<"all" | LogEntry["level"]>("all");
  const [source, setSource] = useState<string>("");
  const [text, setText] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [connected, setConnected] = useState(false);

  const boxRef = useRef<HTMLDivElement | null>(null);

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
            // Newest-first ordering:
            // - initial history replaces
            // - older history appends at the end
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
    // Newest-first: keep view pinned to the top.
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

  return (
    <>
      <div className="header">
        <h1 className="h1">Logs</h1>
        <span className={connected ? "badge ok" : "badge warn"}>
          {connected ? "WS connected" : "WS disconnected"}
        </span>
      </div>

      <div className="card logsFilters">
        <div className="logsFiltersRow">
          <label className="logsFilterItem">
            <span className="label" style={{ margin: 0 }}>
              Level
            </span>
            <select
              className="input"
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

          <label className="logsFilterItem">
            <span className="label" style={{ margin: 0 }}>
              Source
            </span>
            <select
              className="input"
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

          <div className="logsFilterItem logsFilterSearch">
            <input
              className="input"
              placeholder="Search…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>

          <label className="logsFilterItem logsFilterCheck">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            <span>Auto-scroll</span>
          </label>
        </div>
      </div>

      <div ref={boxRef} className="card logsContainer">
        {/* Desktop: table view */}
        <table className="table compact logsTable">
          <thead>
            <tr>
              <th style={{ width: 100 }}>Time</th>
              <th style={{ width: 120 }}>Source</th>
              <th style={{ width: 80 }}>Level</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((l, idx) => (
              <tr key={idx}>
                <td className="mono">{formatLocalTime(l.timestamp)}</td>
                <td className="mono">{l.source ?? ""}</td>
                <td>
                  <span className={levelBadge(l.level)}>{l.level}</span>
                </td>
                <td className="logRest">{formatRest(l)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Mobile: card view */}
        <div className="logsList">
          {filtered.map((l, idx) => (
            <div key={idx} className="logCard">
              <div className="logCardHeader">
                <span className={levelBadge(l.level)}>{l.level}</span>
                <span className="logCardSource">{l.source ?? ""}</span>
                <span className="logCardTime mono">
                  {formatLocalTime(l.timestamp)}
                </span>
              </div>
              <div className="logCardMessage">{formatRest(l)}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
