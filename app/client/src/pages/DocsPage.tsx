import { useEffect, useState } from "react";
import { trpcQuery } from "../api";

type CameraInfo = {
  id: string;
  name: string;
  status: string;
};

export default function DocsPage() {
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    trpcQuery<CameraInfo[]>("cameras.list")
      .then((list) => {
        if (!cancelled) {
          setCameras(list);
          setSelectedId((prev) => {
            if (list.length === 0) return "";
            if (!prev || !list.some((c) => c.id === prev)) return list[0].id;
            return prev;
          });
        }
      })
      .catch(() => {
        if (!cancelled) setCameras([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = cameras.find((c) => c.id === selectedId);

  function copyId() {
    if (!selected) return;
    navigator.clipboard.writeText(selected.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {cameras.length > 0 ? (
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <label
            htmlFor="docs-camera-select"
            style={{ color: "var(--muted)", fontSize: 14 }}
          >
            Camera for Baichuan procedures:
          </label>
          <select
            id="docs-camera-select"
            className="input"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            style={{ minWidth: 200, maxWidth: 320 }}
          >
            {cameras.map((cam) => (
              <option key={cam.id} value={cam.id}>
                {cam.name || cam.id}
              </option>
            ))}
          </select>
          {selected ? (
            <button
              type="button"
              className="btn primary"
              onClick={copyId}
              style={{ padding: "4px 10px", fontSize: 12 }}
              title={`Copy camera ID: ${selected.id}`}
            >
              {copied ? "Copied!" : "Copy ID"}
            </button>
          ) : null}
        </div>
      ) : null}
      <iframe
        src="/panel"
        title="API Docs"
        style={{
          width: "100%",
          height: cameras.length > 0 ? "calc(100vh - 140px)" : "calc(100vh - 80px)",
          border: "none",
        }}
      />
    </div>
  );
}
