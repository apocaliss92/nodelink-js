export function EmptyState({ onAddCamera }: { onAddCamera: () => void }) {
  return (
    <div className="emptyState">
      <svg
        width="80"
        height="80"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ opacity: 0.4, marginBottom: 16 }}
      >
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
        <circle cx="12" cy="13" r="4" />
      </svg>
      <h2 style={{ margin: 0, fontWeight: 600, fontSize: 20 }}>
        No cameras configured
      </h2>
      <p style={{ color: "var(--muted)", margin: "8px 0 24px" }}>
        Add your first camera to start streaming
      </p>
      <button className="btn primary large" onClick={onAddCamera}>
        + Add Camera
      </button>
    </div>
  );
}
