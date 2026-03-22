import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@apocaliss92/camstack-ui';
import type { AddCameraInput } from "./types";

export function AddCameraDialog({
  open,
  onOpenChange,
  adding,
  setAdding,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adding: AddCameraInput;
  setAdding: (v: AddCameraInput) => void;
  onAdd: () => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width="lg" className="m-auto bg-[var(--color-background-elevated)] text-[var(--color-foreground)] border-[var(--color-border)]">
        <DialogHeader>
          <DialogTitle>Add camera</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 mt-1">
          <div>
            <label className="block text-xs text-foreground-muted mb-1">
              Name (optional)
            </label>
            <input
              className="input w-full"
              value={adding.name ?? ""}
              onChange={(e) => setAdding({ ...adding, name: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-foreground-muted mb-1">
                Host
              </label>
              <input
                className="input w-full"
                value={adding.host}
                onChange={(e) =>
                  setAdding({ ...adding, host: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-xs text-foreground-muted mb-1">
                Port
              </label>
              <input
                className="input w-full"
                type="number"
                value={adding.port ?? 9000}
                onChange={(e) =>
                  setAdding({ ...adding, port: Number(e.target.value) })
                }
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-foreground-muted mb-1">
                Username
              </label>
              <input
                className="input w-full"
                value={adding.username}
                onChange={(e) =>
                  setAdding({ ...adding, username: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-xs text-foreground-muted mb-1">
                Password
              </label>
              <input
                className="input w-full"
                type="password"
                value={adding.password}
                onChange={(e) =>
                  setAdding({ ...adding, password: e.target.value })
                }
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void onAdd()}
            disabled={!adding.host || !adding.username || !adding.password}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
