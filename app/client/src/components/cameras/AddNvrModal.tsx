import { useEffect, useState } from "react";
import { trpcMutation } from "../../api";
import type { NvrChannel, NvrInfo } from "./types";

interface AddNvrForm {
  host: string;
  port: number;
  username: string;
  password: string;
}

export function AddNvrModal({
  onClose,
  onDone,
  existingNvr,
  existingCameraChannels,
}: {
  onClose: () => void;
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="modalOverlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          if (step === "channels") onDone();
          else onClose();
        }
      }}
    >
      <div
        className="modalPanel"
        style={{ width: step === "channels" ? "min(900px, 100%)" : "min(720px, 100%)" }}
      >
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div style={{ fontWeight: 800 }}>
            {step === "channels"
              ? `${nvrName || "NVR"} - Channels`
              : "Add NVR / Hub"}
          </div>
          <button
            className="btn"
            onClick={() => {
              if (step === "channels") onDone();
              else onClose();
            }}
          >
            {step === "channels" ? "Done" : "Close"}
          </button>
        </div>

        {step === "credentials" && (
          <div className="grid" style={{ marginTop: 12 }}>
            <div className="grid cols2">
              <div>
                <div className="label">Host</div>
                <input
                  className="input"
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
              </div>
              <div>
                <div className="label">Port</div>
                <input
                  className="input"
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                />
              </div>
            </div>

            <div className="grid cols2">
              <div>
                <div className="label">Username</div>
                <input
                  className="input"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                />
              </div>
              <div>
                <div className="label">Password</div>
                <input
                  className="input"
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </div>
            </div>

            {discoverError && (
              <div style={{ color: "var(--danger)", fontSize: 12 }}>
                {discoverError}
              </div>
            )}

            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button
                className="btn primary"
                onClick={() => void discover()}
                disabled={!canDiscover}
              >
                {discovering && (
                  <span
                    className="spinner"
                    aria-hidden="true"
                    style={{ marginRight: 6, width: 12, height: 12 }}
                  />
                )}
                {discovering ? "Discovering..." : "Connect & Discover"}
              </button>
            </div>
          </div>
        )}

        {step === "channels" && (
          <div style={{ marginTop: 12 }}>
            {discovering ? (
              <div className="row" style={{ justifyContent: "center", padding: 24 }}>
                <span
                  className="spinner"
                  aria-hidden="true"
                  style={{ width: 16, height: 16, marginRight: 8 }}
                />
                Discovering channels...
              </div>
            ) : discoverError ? (
              <div style={{ color: "var(--danger)", fontSize: 12, padding: 12 }}>
                {discoverError}
              </div>
            ) : (
              <>
                <div
                  className="row"
                  style={{ justifyContent: "space-between", marginBottom: 8 }}
                >
                  <span style={{ color: "var(--muted)", fontSize: 12 }}>
                    {channels.length} channel{channels.length !== 1 ? "s" : ""} found
                    {" "}({channels.filter((c) => c.online).length} online)
                  </span>
                  <button
                    className="btn primary"
                    onClick={() => void addAllOnline()}
                    disabled={
                      channels.filter((c) => (c.online || c.isBattery) && !addedChannels.has(c.channel))
                        .length === 0
                    }
                  >
                    Add All Available
                  </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {channels.map((ch) => {
                    const isAdding = addingChannels.has(ch.channel);
                    const isAdded = addedChannels.has(ch.channel);

                    return (
                      <div
                        key={ch.channel}
                        style={{
                          padding: "8px 10px",
                          background: "var(--panel-2)",
                          borderRadius: 6,
                          opacity: ch.online || ch.isBattery ? 1 : 0.5,
                        }}
                      >
                        <div
                          className="row"
                          style={{ justifyContent: "space-between" }}
                        >
                          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                            <span className="badge mono">CH {ch.channel}</span>
                            <span style={{ fontWeight: 600, fontSize: 13 }}>
                              {ch.name}
                            </span>
                            {ch.model && (
                              <span style={{ color: "var(--muted)", fontSize: 12 }}>
                                {ch.model}
                              </span>
                            )}
                            <span
                              className={`badge ${ch.online ? "ok" : "err"}`}
                              style={{ fontSize: 10 }}
                            >
                              {ch.online ? "online" : "offline"}
                            </span>
                            {ch.isBattery && (
                              <span className="badge" style={{ fontSize: 10 }}>
                                battery
                              </span>
                            )}
                            {ch.isDoorbell && (
                              <span className="badge" style={{ fontSize: 10 }}>
                                doorbell
                              </span>
                            )}
                            {ch.isMultifocal && (
                              <span className="badge" style={{ fontSize: 10 }}>
                                dual-lens
                              </span>
                            )}
                            {ch.ip && (
                              <span className="badge mono" style={{ fontSize: 10 }}>
                                {ch.ip}
                              </span>
                            )}
                          </div>
                          <button
                            className={`btn ${isAdded ? "" : "primary"}`}
                            disabled={(!ch.online && !ch.isBattery) || isAdding || isAdded}
                            onClick={() => void addChannel(ch)}
                            style={{ fontSize: 12, padding: "3px 10px", minWidth: 60 }}
                          >
                            {isAdding ? (
                              <span
                                className="spinner"
                                aria-hidden="true"
                                style={{ width: 10, height: 10 }}
                              />
                            ) : isAdded ? (
                              "Added"
                            ) : (
                              "Add"
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
