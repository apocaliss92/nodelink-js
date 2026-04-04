import { useEffect, useState } from "react";
import { getStoredAuthToken } from "../../../authToken";

export type ConnLogEntry = {
  ts: number;
  level: "info" | "warn" | "error" | "debug";
  msg: string;
};

type SseMsg =
  | { type: "history"; logs: ConnLogEntry[] }
  | ({ type: "log" } & ConnLogEntry);

/**
 * Subscribes to GET /api/cameras/:id/logs (SSE) and streams connection log
 * entries exclusively from the BaichuanClient logger for that camera.
 *
 * @param cameraId  Camera ID to stream logs for. Pass null/undefined to disable.
 */
export function useConnectionLogs(cameraId: string | null | undefined) {
  const [logs, setLogs] = useState<ConnLogEntry[]>([]);

  useEffect(() => {
    if (!cameraId) {
      setLogs([]);
      return;
    }

    setLogs([]);

    const token = getStoredAuthToken();
    const url = token
      ? `/api/cameras/${cameraId}/logs?token=${encodeURIComponent(token)}`
      : `/api/cameras/${cameraId}/logs`;

    const es = new EventSource(url);

    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as SseMsg;
        if (msg.type === "history") {
          setLogs(msg.logs);
          return;
        }
        const { type: _, ...entry } = msg;
        setLogs((prev) => [...prev, entry]);
      } catch {
        // ignore
      }
    };

    return () => es.close();
  }, [cameraId]);

  return logs;
}
