export default function DocsPage() {
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <iframe
        src="/panel"
        title="API Docs"
        style={{ width: "100%", height: "calc(100vh - 80px)", border: "none" }}
      />
    </div>
  );
}
