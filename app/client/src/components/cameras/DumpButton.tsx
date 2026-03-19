import { useState } from "react";
import { trpcMutation } from "../../api";

interface DumpResult {
  token: string;
  filename: string;
  summary: {
    total: number;
    ok: number;
    failed: number;
    errors: string[];
  };
}

export function DumpButton({
  cameraId,
  cameraName,
}: {
  cameraId: string;
  cameraName: string;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DumpResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const res = await trpcMutation<DumpResult>("cameras.dump", { cameraId });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const download = () => {
    if (!result) return;
    const a = document.createElement("a");
    a.href = `/api/dump/${result.token}`;
    a.download = result.filename;
    a.click();
  };

  const close = () => {
    setResult(null);
    setError(null);
  };

  return (
    <>
      <button
        className="btn"
        disabled={running}
        onClick={() => void run()}
        title="Dump all API responses for debugging"
      >
        {running ? "Dumping..." : "Dump"}
      </button>

      {(running || result || error) && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !running) close();
          }}
        >
          <div
            style={{
              background: "var(--bg, #fff)",
              borderRadius: 10,
              padding: 20,
              minWidth: 340,
              maxWidth: 480,
              boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>
              Diagnostics Dump — {cameraName}
            </div>

            {running && (
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                <div style={{ marginBottom: 8 }}>Capturing API responses...</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {[
                    "Device info & capabilities",
                    "Stream metadata & encoding",
                    "AI config & motion alarm",
                    "White LED / Floodlight",
                    "Dual-lens analysis",
                    "Stream combination test",
                  ].map((step, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="spinner" style={{ width: 10, height: 10 }} />
                      <span>{step}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result && (
              <div style={{ fontSize: 12 }}>
                <div
                  style={{
                    padding: "8px 10px",
                    borderRadius: 6,
                    background: result.summary.failed === 0
                      ? "rgba(34,197,94,0.1)"
                      : "rgba(245,158,11,0.1)",
                    color: result.summary.failed === 0 ? "#22c55e" : "#f59e0b",
                    marginBottom: 10,
                  }}
                >
                  {result.summary.ok}/{result.summary.total} calls succeeded
                  {result.summary.failed > 0 && `, ${result.summary.failed} failed`}
                </div>

                {result.summary.errors.length > 0 && (
                  <div style={{ marginBottom: 10, fontSize: 11, color: "var(--muted)" }}>
                    <div style={{ fontWeight: 600, marginBottom: 3 }}>Errors:</div>
                    {result.summary.errors.map((e, i) => (
                      <div key={i} style={{ paddingLeft: 8 }}>- {e}</div>
                    ))}
                  </div>
                )}

                <div className="row" style={{ gap: 8 }}>
                  <button className="btn primary" onClick={download}>
                    Download ZIP
                  </button>
                  <button className="btn" onClick={close}>
                    Close
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div style={{ fontSize: 12 }}>
                <div
                  style={{
                    padding: "8px 10px",
                    borderRadius: 6,
                    background: "rgba(239,68,68,0.1)",
                    color: "#ef4444",
                    marginBottom: 10,
                  }}
                >
                  {error}
                </div>
                <button className="btn" onClick={close}>
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
