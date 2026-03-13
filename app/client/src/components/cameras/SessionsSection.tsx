import { useCallback, useEffect, useState } from "react";
import { trpcQuery } from "../../api";

interface Session {
  userName: string;
  ip: string;
  sessionId: number;
  level: number;
}

interface SessionsData {
  sessions: Session[];
  total: number;
}

export function SessionsSection({
  cameraId,
  isConnected,
}: {
  cameraId: string;
  isConnected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SessionsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(
    async (silent = false) => {
      if (!isConnected) return;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const result = await trpcQuery<SessionsData>("cameras.getSessions", {
          id: cameraId,
        });
        setData(result ?? null);
      } catch (e: any) {
        setError(e?.message ?? "Failed to fetch");
        if (!silent) setData(null);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [cameraId, isConnected],
  );

  // Fetch on open
  useEffect(() => {
    if (open && isConnected) void fetchSessions();
  }, [open, isConnected, fetchSessions]);

  // Auto-refresh every 30s when open
  useEffect(() => {
    if (!open || !isConnected) return;
    const iv = setInterval(() => void fetchSessions(true), 30_000);
    return () => clearInterval(iv);
  }, [open, isConnected, fetchSessions]);

  // Reset on disconnect
  useEffect(() => {
    if (!isConnected) {
      setData(null);
      setOpen(false);
    }
  }, [isConnected]);

  // Group sessions by IP
  const byIp = new Map<string, Session[]>();
  if (data?.sessions) {
    for (const s of data.sessions) {
      const list = byIp.get(s.ip) ?? [];
      list.push(s);
      byIp.set(s.ip, list);
    }
  }

  return (
    <>
      <button
        className="btn"
        onClick={() => setOpen((v) => !v)}
        title="View active sessions on this camera"
      >
        Sessions{data ? ` (${data.total})` : ""}
      </button>

      {open && (
        <>
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 999,
              background: "rgba(0,0,0,0.4)",
            }}
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            className="dropdownMenu"
            style={{
              position: "fixed",
              zIndex: 1000,
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              padding: 12,
              minWidth: 320,
              maxWidth: 440,
              fontSize: 13,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="row"
              style={{
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 10,
              }}
            >
              <span style={{ fontWeight: 600 }}>
                Active Sessions{data ? ` (${data.total})` : ""}
              </span>
              <div className="row" style={{ gap: 4 }}>
                <button
                  className="btn"
                  style={{ fontSize: 11, padding: "2px 8px" }}
                  onClick={() => void fetchSessions()}
                  disabled={loading}
                >
                  {loading && (
                    <span
                      className="spinner"
                      aria-hidden="true"
                      style={{ marginRight: 4, width: 10, height: 10 }}
                    />
                  )}
                  Refresh
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setOpen(false)}
                  style={{ padding: "2px 8px", fontSize: 11 }}
                >
                  Close
                </button>
              </div>
            </div>

            {error && (
              <div style={{ color: "var(--danger)", marginBottom: 6, fontSize: 12 }}>
                {error}
              </div>
            )}

            {loading && !data ? (
              <div className="row" style={{ color: "var(--muted)" }}>
                <span className="spinner" aria-hidden="true" />
                Loading...
              </div>
            ) : data?.sessions.length === 0 ? (
              <div style={{ color: "var(--muted)" }}>No active sessions</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {Array.from(byIp.entries()).map(([ip, sessions]) => (
                  <div
                    key={ip}
                    style={{
                      padding: "6px 8px",
                      background: "var(--panel-2)",
                      borderRadius: 6,
                    }}
                  >
                    <div className="row" style={{ gap: 6 }}>
                      <span className="badge mono">{ip}</span>
                      <span style={{ color: "var(--muted)", fontSize: 11 }}>
                        {sessions.length} session{sessions.length !== 1 ? "s" : ""}
                      </span>
                      <span style={{ color: "var(--muted)", fontSize: 11 }}>
                        {sessions[0]?.userName}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 4,
                        marginTop: 4,
                      }}
                    >
                      {sessions.map((s) => (
                        <span
                          key={s.sessionId}
                          className="badge mono"
                          style={{ fontSize: 10, opacity: 0.7 }}
                        >
                          #{s.sessionId}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div
              style={{
                marginTop: 6,
                fontSize: 10,
                color: "var(--muted)",
                textAlign: "right",
              }}
            >
              Auto-refresh 30s
            </div>
          </div>
        </>
      )}
    </>
  );
}
