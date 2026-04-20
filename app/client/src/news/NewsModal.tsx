import { useEffect } from "react";
import { X, Megaphone } from "lucide-react";
import type { NewsItem } from "./news-items";

interface NewsModalProps {
  open: boolean;
  items: NewsItem[];
  onClose: () => void;
}

export function NewsModal({ open, items, onClose }: NewsModalProps) {
  // Close on Escape for keyboard accessibility.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="news-modal-title"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg max-h-[80vh] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-background-elevated)] shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <Megaphone size={16} className="text-[var(--color-brand)]" />
            <h2
              id="news-modal-title"
              className="text-sm font-semibold text-[var(--color-foreground)]"
            >
              What&apos;s new
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-foreground-subtle)] hover:text-[var(--color-foreground)] transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body — scrollable when there are many items. */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
          {items.length === 0 ? (
            <p className="text-xs text-[var(--color-foreground-muted)]">
              No news yet.
            </p>
          ) : (
            items.map((item) => (
              <article key={item.id} className="space-y-1.5">
                <header className="flex items-baseline justify-between gap-3">
                  <h3 className="text-[13px] font-semibold text-[var(--color-foreground)]">
                    {item.title}
                  </h3>
                  <time
                    className="text-[10px] text-[var(--color-foreground-subtle)] shrink-0"
                    dateTime={item.date}
                  >
                    {item.date}
                  </time>
                </header>
                <div>{item.body}</div>
              </article>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 transition-opacity"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
