import { useEffect, useState } from "react";
import { trpcQuery } from "../api";

type CameraInfo = {
  id: string;
  name: string;
  status: string;
};

const cardCls =
  "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4";

const labelCls =
  "text-xs font-medium text-[var(--color-foreground-muted)] uppercase tracking-wider mb-1.5 block";

const inputCls =
  "w-full max-w-md rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm text-[var(--color-foreground)] outline-none";

const btnPrimaryCls =
  "border border-[rgba(59,130,246,0.55)] bg-[rgba(59,130,246,0.28)] text-[var(--color-foreground)] rounded-md cursor-pointer text-xs px-3 py-2 font-medium disabled:opacity-60 disabled:cursor-not-allowed hover:opacity-95 transition-opacity";

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
    void navigator.clipboard.writeText(selected.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  /** Most of the viewport for the tRPC panel; small subtract = header + padding + optional camera bar. */
  const iframeHeight =
    cameras.length > 0 ? "calc(100dvh - 132px)" : "calc(100dvh - 62px)";

  return (
    <div className="p-5">
      <div className="mb-2">
        <h1 className="text-lg font-bold m-0">API documentation</h1>
        <p className="text-xs text-[var(--color-foreground-muted)] mt-1 m-0 leading-snug">
          Interactive tRPC panel — select a camera when procedures need a device id.
        </p>
      </div>

      <div className={`${cardCls} p-0 overflow-hidden`}>
        {cameras.length > 0 ? (
          <div className="px-3 py-2 border-b border-[var(--color-border)]">
            <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3">
              <div className="flex-1 min-w-0 max-w-md">
                <label htmlFor="docs-camera-select" className={labelCls}>
                  Camera for Baichuan procedures
                </label>
                <select
                  id="docs-camera-select"
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                  className={inputCls}
                >
                  {cameras.map((cam) => (
                    <option key={cam.id} value={cam.id}>
                      {cam.name || cam.id}
                    </option>
                  ))}
                </select>
              </div>
              {selected ? (
                <button
                  type="button"
                  onClick={copyId}
                  title={`Copy camera ID: ${selected.id}`}
                  className={btnPrimaryCls}
                >
                  {copied ? "Copied!" : "Copy camera ID"}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="bg-[var(--color-background)]">
          <iframe
            src="/panel"
            title="API Docs"
            className="w-full border-0 block"
            style={{
              height: iframeHeight,
              minHeight: 560,
            }}
          />
        </div>
      </div>
    </div>
  );
}
