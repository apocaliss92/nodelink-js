import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@apocaliss92/camstack-ui';
import { trpcMutation } from "../../api";
import type { NvrChannel, NvrInfo } from "./types";

interface AddNvrForm {
  host: string;
  port: number;
  username: string;
  password: string;
}

export function AddNvrDialog({
  open,
  onOpenChange,
  onDone,
  existingNvr,
  existingCameraChannels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  existingNvr?: NvrInfo;
  existingCameraChannels?: number[];
}) {
  const [form, setForm] = useState<AddNvrForm>({
    host: "",
    port: 9000,
    username: "",
    password: "",
  });
  const [step, setStep] = useState<"credentials" | "channels">(
    existingNvr ? "channels" : "credentials",
  );
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [nvrName, setNvrName] = useState(existingNvr?.name ?? "");
  const [nvrId, setNvrId] = useState<string | null>(existingNvr?.id ?? null);
  const [channels, setChannels] = useState<NvrChannel[]>([]);
  const [addingChannels, setAddingChannels] = useState<Set<number>>(new Set());
  const [addedChannels, setAddedChannels] = useState<Set<number>>(
    new Set(existingCameraChannels ?? []),
  );

  const canDiscover =
    form.host && form.username && form.password && !discovering;

  const discoverByNvrId = async (id: string) => {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const result = await trpcMutation<{
        success: boolean;
        error?: string;
        nvrName: string;
        channelCount: number;
        channels: NvrChannel[];
      }>("cameras.discoverNvrChannels", { nvrId: id });

      if (!result.success) {
        setDiscoverError(result.error ?? "Discovery failed");
        return;
      }
      setChannels(result.channels);
      if (result.nvrName) setNvrName(result.nvrName);
    } catch (e: any) {
      setDiscoverError(e?.message ?? "Discovery failed");
    } finally {
      setDiscovering(false);
    }
  };

  const discover = async () => {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const result = await trpcMutation<{
        success: boolean;
        error?: string;
        nvrName: string;
        channelCount: number;
        channels: NvrChannel[];
      }>("cameras.discoverNvrChannels", {
        host: form.host,
        port: form.port,
        username: form.username,
        password: form.password,
      });

      if (!result.success) {
        setDiscoverError(result.error ?? "Discovery failed");
        return;
      }

      const nvr = await trpcMutation<{ id: string; name: string }>(
        "cameras.addNvr",
        {
          name: result.nvrName || form.host,
          host: form.host,
          port: form.port,
          username: form.username,
          password: form.password,
        },
      );

      setNvrName(result.nvrName || form.host);
      setNvrId(nvr.id);
      setChannels(result.channels);
      setStep("channels");
    } catch (e: any) {
      setDiscoverError(e?.message ?? "Discovery failed");
    } finally {
      setDiscovering(false);
    }
  };

  // Auto-discover when opening for an existing NVR
  useEffect(() => {
    if (existingNvr) {
      void discoverByNvrId(existingNvr.id);
    }
  }, []);

  const addChannel = async (ch: NvrChannel) => {
    if (!nvrId) return;
    setAddingChannels((s) => new Set(s).add(ch.channel));
    try {
      await trpcMutation("cameras.addNvrCamera", {
        nvrId,
        channelName: ch.name,
        channelNumber: ch.channel,
        isBattery: ch.isBattery,
      });
      setAddedChannels((s) => new Set(s).add(ch.channel));
    } catch {
      // error handled by parent
    } finally {
      setAddingChannels((s) => {
        const next = new Set(s);
        next.delete(ch.channel);
        return next;
      });
    }
  };

  const addAllOnline = async () => {
    for (const ch of channels) {
      if ((ch.online || ch.isBattery) && !addedChannels.has(ch.channel)) {
        await addChannel(ch);
      }
    }
  };

  const handleClose = () => {
    if (step === "channels") {
      onDone();
    } else {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose(); }}>
      <DialogContent width="lg" className={`m-auto bg-[var(--color-background-elevated)] text-[var(--color-foreground)] border-[var(--color-border)]${step === "channels" ? " max-w-3xl" : ""}`}>
        <DialogHeader>
          <DialogTitle>
            {step === "channels"
              ? `${nvrName || "NVR"} – Channels`
              : "Add NVR / Hub"}
          </DialogTitle>
        </DialogHeader>

        {step === "credentials" && (
          <div className="flex flex-col gap-3 mt-1">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-foreground-muted mb-1">
                  Host
                </label>
                <input
                  className="input w-full"
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs text-foreground-muted mb-1">
                  Port
                </label>
                <input
                  className="input w-full"
                  type="number"
                  value={form.port}
                  onChange={(e) =>
                    setForm({ ...form, port: Number(e.target.value) })
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
                  value={form.username}
                  onChange={(e) =>
                    setForm({ ...form, username: e.target.value })
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
                  value={form.password}
                  onChange={(e) =>
                    setForm({ ...form, password: e.target.value })
                  }
                />
              </div>
            </div>

            {discoverError && (
              <div className="text-danger text-xs">{discoverError}</div>
            )}
          </div>
        )}

        {step === "channels" && (
          <div className="mt-1">
            {discovering ? (
              <div className="flex items-center justify-center gap-2 py-6">
                <span className="spinner" aria-hidden="true" />
                Discovering channels...
              </div>
            ) : discoverError ? (
              <div className="text-danger text-xs p-3">{discoverError}</div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-foreground-muted">
                    {channels.length} channel{channels.length !== 1 ? "s" : ""}{" "}
                    found ({channels.filter((c) => c.online).length} online)
                  </span>
                  <Button
                    size="sm"
                    onClick={() => void addAllOnline()}
                    disabled={
                      channels.filter(
                        (c) =>
                          (c.online || c.isBattery) &&
                          !addedChannels.has(c.channel),
                      ).length === 0
                    }
                  >
                    Add All Available
                  </Button>
                </div>

                <div className="flex flex-col gap-1.5">
                  {channels.map((ch) => {
                    const isAdding = addingChannels.has(ch.channel);
                    const isAdded = addedChannels.has(ch.channel);

                    return (
                      <div
                        key={ch.channel}
                        className="flex items-center justify-between rounded-md px-2.5 py-2"
                        style={{
                          background: "var(--panel-2)",
                          opacity: ch.online || ch.isBattery ? 1 : 0.5,
                        }}
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="badge mono">CH {ch.channel}</span>
                          <span className="text-sm font-semibold">
                            {ch.name}
                          </span>
                          {ch.model && (
                            <span className="text-xs text-foreground-muted">
                              {ch.model}
                            </span>
                          )}
                          <span
                            className={`badge ${ch.online ? "ok" : "err"} text-[10px]`}
                          >
                            {ch.online ? "online" : "offline"}
                          </span>
                          {ch.isBattery && (
                            <span className="badge text-[10px]">battery</span>
                          )}
                          {ch.isDoorbell && (
                            <span className="badge text-[10px]">doorbell</span>
                          )}
                          {ch.isMultifocal && (
                            <span className="badge text-[10px]">dual-lens</span>
                          )}
                          {ch.ip && (
                            <span className="badge mono text-[10px]">
                              {ch.ip}
                            </span>
                          )}
                        </div>
                        <Button
                          variant={isAdded ? "secondary" : "primary"}
                          size="sm"
                          disabled={
                            (!ch.online && !ch.isBattery) || isAdding || isAdded
                          }
                          onClick={() => void addChannel(ch)}
                          className="text-xs min-w-[56px]"
                        >
                          {isAdding ? (
                            <span className="spinner" aria-hidden="true" />
                          ) : isAdded ? (
                            "Added"
                          ) : (
                            "Add"
                          )}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "credentials" ? (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => void discover()}
                disabled={!canDiscover}
              >
                {discovering && (
                  <span
                    className="spinner"
                    aria-hidden="true"
                  />
                )}
                {discovering ? "Discovering..." : "Connect & Discover"}
              </Button>
            </>
          ) : (
            <Button onClick={onDone}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
