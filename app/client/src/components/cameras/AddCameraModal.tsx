import type { AddCameraInput } from "./types";

export function AddCameraModal({
  adding,
  setAdding,
  onAdd,
  onClose,
}: {
  adding: AddCameraInput;
  setAdding: (v: AddCameraInput) => void;
  onAdd: () => Promise<void>;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="modalOverlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modalPanel" style={{ width: "min(720px, 100%)" }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div style={{ fontWeight: 800 }}>Add camera</div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="grid" style={{ marginTop: 12 }}>
          <div>
            <div className="label">Name (optional)</div>
            <input
              className="input"
              value={adding.name ?? ""}
              onChange={(e) => setAdding({ ...adding, name: e.target.value })}
            />
          </div>

          <div className="grid cols2">
            <div>
              <div className="label">Host</div>
              <input
                className="input"
                value={adding.host}
                onChange={(e) => setAdding({ ...adding, host: e.target.value })}
              />
            </div>
            <div>
              <div className="label">Port</div>
              <input
                className="input"
                type="number"
                value={adding.port ?? 9000}
                onChange={(e) =>
                  setAdding({ ...adding, port: Number(e.target.value) })
                }
              />
            </div>
          </div>

          <div className="grid cols2">
            <div>
              <div className="label">Username</div>
              <input
                className="input"
                value={adding.username}
                onChange={(e) =>
                  setAdding({ ...adding, username: e.target.value })
                }
              />
            </div>
            <div>
              <div className="label">Password</div>
              <input
                className="input"
                type="password"
                value={adding.password}
                onChange={(e) =>
                  setAdding({ ...adding, password: e.target.value })
                }
              />
            </div>
          </div>

          <div className="grid cols2">
            <label className="row" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={adding.isNvr}
                onChange={(e) =>
                  setAdding({ ...adding, isNvr: e.target.checked })
                }
              />
              <span>Camera is part of an NVR / Hub</span>
            </label>

            {adding.isNvr ? (
              <div>
                <div className="label">Channel</div>
                <input
                  className="input"
                  type="number"
                  value={adding.nvrChannel}
                  onChange={(e) =>
                    setAdding({
                      ...adding,
                      nvrChannel: Number(e.target.value),
                    })
                  }
                />
              </div>
            ) : (
              <div />
            )}
          </div>

          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button
              className="btn primary"
              onClick={() => void onAdd()}
              disabled={
                !adding.host || !adding.username || !adding.password
              }
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
