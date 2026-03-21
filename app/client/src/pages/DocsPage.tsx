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
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] overflow-hidden">
      {cameras.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
          <label
            htmlFor="docs-camera-select"
            className="text-sm text-[var(--muted)]"
          >
            Camera for Baichuan procedures:
          </label>
          <select
            id="docs-camera-select"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="min-w-[200px] max-w-xs rounded-lg border border-[var(--border)] bg-[var(--input-bg,var(--card))] px-3 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
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
              onClick={copyId}
              title={`Copy camera ID: ${selected.id}`}
              className="rounded-lg bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 active:opacity-80 transition-opacity"
            >
              {copied ? "Copied!" : "Copy ID"}
            </button>
          ) : null}
        </div>
      ) : null}
      <iframe
        src="/panel"
        title="API Docs"
        className="w-full border-none"
        style={{
          height: cameras.length > 0 ? "calc(100vh - 140px)" : "calc(100vh - 80px)",
        }}
      />
    </div>
  );
}
