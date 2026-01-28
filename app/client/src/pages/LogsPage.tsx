import { useEffect, useMemo, useRef, useState } from "react";

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

function shortTime(ts?: string): string {
  if (!ts) return "";
  // ISO: 2026-01-28T12:34:56.789Z
  if (ts.includes("T") && ts.length >= 23) return ts.slice(11, 23);
  return ts;
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
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/logs`);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WsMsg;
        if (msg.type === "history") {
          setLogs((prev) => {
            if (msg.append) return [...msg.logs, ...prev];
            return msg.logs;
          });
          return;
        }
        if (msg.type === "log") {
          setLogs((prev) => {
            const next = [...prev, msg];
            return next.length > 1500 ? next.slice(next.length - 1500) : next;
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
    box.scrollTop = box.scrollHeight;
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

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row">
          <label className="row">
            <span className="label" style={{ margin: 0 }}>
              Level
            </span>
            <select
              className="input"
              style={{ width: 160 }}
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

          <label className="row">
            <span className="label" style={{ margin: 0 }}>
              Source
            </span>
            <select
              className="input"
              style={{ width: 160 }}
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

          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="Search…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />

          <label className="row" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            <span>Auto-scroll</span>
          </label>
        </div>
      </div>

      <div
        ref={boxRef}
        className="card"
        style={{ height: "calc(100vh - 190px)", overflow: "auto" }}
      >
        <table className="table compact">
          <thead>
            <tr>
              <th style={{ width: 110 }}>Time</th>
              <th style={{ width: 140 }}>Source</th>
              <th style={{ width: 95 }}>Level</th>
              <th>Rest</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((l, idx) => (
              <tr key={idx}>
                <td className="mono">{shortTime(l.timestamp)}</td>
                <td className="mono">{l.source ?? ""}</td>
                <td>
                  <span className={levelBadge(l.level)}>{l.level}</span>
                </td>
                <td className="logRest">{formatRest(l)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
