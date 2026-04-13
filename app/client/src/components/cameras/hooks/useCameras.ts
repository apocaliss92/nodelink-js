import { useCallback, useEffect, useState } from "react";
import { trpcMutation, trpcQuery } from "../../../api";
import type {
  AddCameraInput,
  AvailableStream,
  CameraInfo,
  NvrInfo,
  PreviewModalState,
  StreamProfile,
} from "../types";

const MAX_STREAM_DISCOVERY_ATTEMPTS = 12;
const STREAM_DISCOVERY_RETRY_MS = 3000;

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function updateIfChanged<T>(
  setter: React.Dispatch<React.SetStateAction<T>>,
  newValue: T,
) {
  setter((prev) => {
    const prevJson = JSON.stringify(prev);
    const newJson = JSON.stringify(newValue);
    return prevJson === newJson ? prev : newValue;
  });
}

export function useCameras() {
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectingByCamera, setConnectingByCamera] = useState<
    Record<string, boolean>
  >({});
  const [rtspServers, setRtspServers] = useState<
    Array<{
      cameraId: string;
      profile: StreamProfile;
      channel: number;
      status: string | undefined;
      connections: number | undefined;
      go2rtcStreamName: string | undefined;
      rtspUrl: string | undefined;
      mode: string | undefined;
    }>
  >([]);
  const [rtspProxyStatus, setRtspProxyStatus] = useState<null | {
    enabled: boolean;
    running: boolean;
    port: number;
    host: string;
    connections: number;
  }>(null);
  const [go2rtcApiPort, setGo2rtcApiPort] = useState<number | null>(null);
  const [go2rtcRtspPort, setGo2rtcRtspPort] = useState<number | null>(null);
  const [serviceIp, setServiceIp] = useState<string>("");
  const [streamsLoadingByCamera, setStreamsLoadingByCamera] = useState<
    Record<string, boolean>
  >({});
  const [streamsDiscoveryAttemptsByCamera, setStreamsDiscoveryAttemptsByCamera] =
    useState<Record<string, number>>({});
  const [previewModal, setPreviewModal] = useState<PreviewModalState>({
    open: false,
  });
  const [addOpen, setAddOpen] = useState(false);
  const [addedCameraId, setAddedCameraId] = useState<string | null>(null);
  const [adding, setAdding] = useState<AddCameraInput>({
    host: "",
    port: 9000,
    username: "",
    password: "",
    name: "",
    isNvr: false,
    nvrChannel: 0,
  });
  const [streamsByCamera, setStreamsByCamera] = useState<
    Record<string, AvailableStream[]>
  >({});
  const [savingAutoStart, setSavingAutoStart] = useState<
    Record<string, boolean>
  >({});
  const [nvrs, setNvrs] = useState<NvrInfo[]>([]);
  const [addNvrOpen, setAddNvrOpen] = useState(false);

  const refresh = useCallback(async (silent = false): Promise<CameraInfo[] | null> => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const [list, proxy, rtspList, nvrList, go2rtcSt, settingsRes, go2rtcSettings] = await Promise.all([
        trpcQuery<CameraInfo[]>("cameras.list"),
        trpcQuery<any>("rtspProxy.getStatus").catch(() => null),
        trpcQuery<any[]>("rtsp.list").catch(() => []),
        trpcQuery<NvrInfo[]>("cameras.listNvrs").catch(() => []),
        trpcQuery<{ apiUrl: string | null; running: boolean; rtspPort?: number }>("go2rtc.status").catch(() => null),
        trpcQuery<{ serviceIp?: string }>("settings.get").catch(() => null),
        trpcQuery<{ rtspSource?: "go2rtc" | "local" }>("go2rtc.getSettings").catch(() => null),
      ]);
      if (settingsRes?.serviceIp) setServiceIp(settingsRes.serviceIp);
      if (go2rtcSettings?.rtspSource) setRtspSourceState(go2rtcSettings.rtspSource);
      if (go2rtcSt) {
        setGo2rtcRunning(go2rtcSt.running);
        if (go2rtcSt.apiUrl) {
          try {
            const port = new URL(go2rtcSt.apiUrl).port;
            if (port) setGo2rtcApiPort(Number(port));
          } catch { /* ignore */ }
        }
        if (go2rtcSt.rtspPort) setGo2rtcRtspPort(go2rtcSt.rtspPort);
      }
      updateIfChanged(setCameras, list);

      // Clear discovered streams for cameras that are no longer connected,
      // so the UI removes stale stream profiles and action buttons.
      const disconnectedIds = (list ?? [])
        .filter((c: CameraInfo) => c.status === "disconnected" || c.status === "error")
        .map((c: CameraInfo) => c.id);

      if (disconnectedIds.length > 0) {
        // Clear discovered streams for cameras that are no longer connected,
        // so the UI removes stale stream profiles and action buttons.
        setStreamsByCamera((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const id of disconnectedIds) {
            if (next[id] && next[id].length > 0) {
              delete next[id];
              changed = true;
            }
          }
          return changed ? next : prev;
        });

        // Also reset discovery attempt counters so stream discovery
        // runs again when the camera reconnects (e.g. via auto-reconnect).
        setStreamsDiscoveryAttemptsByCamera((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const id of disconnectedIds) {
            if (next[id] !== undefined) {
              delete next[id];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }

      updateIfChanged(
        setRtspServers,
        (rtspList ?? []).map((x: any) => ({
          cameraId: String(x.cameraId ?? x.cameraName ?? ""),
          profile: String(x.profile ?? "main") as StreamProfile,
          channel: Number(x.channel ?? 0),
          status: x.status ? String(x.status) : undefined,
          connections: x.connections === undefined ? undefined : Number(x.connections),
          go2rtcStreamName: x.go2rtcStreamName ? String(x.go2rtcStreamName) : undefined,
          rtspUrl: x.rtspUrl ? String(x.rtspUrl) : undefined,
          mode: x.mode ? String(x.mode) : undefined,
        })),
      );

      if (proxy) {
        setRtspProxyStatus((prev) => {
          const newVal = {
            enabled: Boolean(proxy.enabled),
            running: Boolean(proxy.running),
            port: Number(proxy.port ?? 0),
            host: String(proxy.host ?? ""),
            connections: Number(proxy.connections ?? 0),
          };
          if (JSON.stringify(prev) === JSON.stringify(newVal)) return prev;
          return newVal;
        });
      }

      updateIfChanged(setNvrs, nvrList ?? []);

      return list;
    } catch (e) {
      if (!silent) setError(String(e));
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const discoverStreamsOnce = useCallback(
    async (id: string, cameraSnapshot?: CameraInfo[] | null): Promise<AvailableStream[] | null> => {
      if (streamsLoadingByCamera[id]) return null;

      setStreamsLoadingByCamera((m) => ({ ...m, [id]: true }));
      try {
        const cam = (cameraSnapshot ?? cameras).find((c) => c.id === id);
        const res = await trpcQuery<{ nativeStreams: AvailableStream[] }>(
          "cameras.getAvailableStreams",
          {
            id,
            channel: cam?.isNvr ? (cam.rtspChannel ?? 0) : undefined,
          },
        );

        const discovered = res.nativeStreams ?? [];
        setStreamsByCamera((prev) => ({ ...prev, [id]: discovered }));
        return discovered;
      } catch {
        setStreamsByCamera((prev) => ({ ...prev, [id]: [] }));
        return [];
      } finally {
        setStreamsLoadingByCamera((m) => ({ ...m, [id]: false }));
      }
    },
    [cameras, streamsLoadingByCamera],
  );

  const connect = useCallback(
    async (id: string, action?: () => Promise<void>) => {
      setConnectingByCamera((m) => ({ ...m, [id]: true }));
      setStreamsDiscoveryAttemptsByCamera((m) => ({ ...m, [id]: 0 }));
      setStreamsByCamera((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });

      try {
        if (action) {
          await action();
        } else {
          await trpcMutation("cameras.connect", { id });
        }

        let cameraSnapshot = await refresh(true);
        for (let attempt = 0; attempt < MAX_STREAM_DISCOVERY_ATTEMPTS; attempt++) {
          setStreamsDiscoveryAttemptsByCamera((m) => ({ ...m, [id]: attempt + 1 }));

          const streams = await discoverStreamsOnce(id, cameraSnapshot);
          if ((streams?.length ?? 0) > 0) {
            setStreamsDiscoveryAttemptsByCamera((m) => ({
              ...m,
              [id]: MAX_STREAM_DISCOVERY_ATTEMPTS,
            }));
            break;
          }

          await delay(STREAM_DISCOVERY_RETRY_MS);
          cameraSnapshot = await refresh(true);
        }
      } finally {
        setConnectingByCamera((m) => ({ ...m, [id]: false }));
      }
    },
    [discoverStreamsOnce, refresh],
  );

  const disconnect = useCallback(
    async (id: string) => {
      await trpcMutation("cameras.disconnect", { id });
      await refresh();
    },
    [refresh],
  );

  const setCameraDebug = useCallback(
    (id: string, enabled: boolean) => {
      void connect(id, () =>
        trpcMutation("cameras.setDebug", { id, enabled, reconnect: true }),
      );
    },
    [connect],
  );

  const setAutoStartForCamera = useCallback(
    async (camera: CameraInfo, autoStart: boolean) => {
      setSavingAutoStart((m) => ({ ...m, [camera.id]: true }));
      try {
        await trpcMutation("cameras.setAutoStart", {
          id: camera.id,
          autoStart,
        });
        await refresh();
      } finally {
        setSavingAutoStart((m) => ({ ...m, [camera.id]: false }));
      }
    },
    [refresh],
  );

  const addCamera = useCallback(async () => {
    setError(null);
    try {
      const created = await trpcMutation("cameras.add", {
        name: adding.name || undefined,
        host: adding.host,
        port: adding.port ?? 9000,
        username: adding.username,
        password: adding.password,
        uid: adding.uid || undefined,
        channels: 1,
        isNvr: adding.isNvr,
        rtspChannel: adding.isNvr ? Number(adding.nvrChannel || 0) : 0,
      });
      // Keep dialog open to show connection log; user closes manually
      setAddedCameraId((created as { id: string } | null)?.id ?? null);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }, [adding, refresh]);

  const deleteNvr = useCallback(
    async (id: string) => {
      if (!confirm("Delete NVR and all its cameras?")) return;
      await trpcMutation("cameras.deleteNvr", { id });
      await refresh();
    },
    [refresh],
  );

  const [go2rtcRunning, setGo2rtcRunning] = useState(false);
  const [go2rtcToggling, setGo2rtcToggling] = useState(false);
  const [rtspSource, setRtspSourceState] = useState<"go2rtc" | "local">("go2rtc");
  const [rtspSourceSaving, setRtspSourceSaving] = useState(false);

  const toggleGo2rtc = useCallback(async () => {
    setGo2rtcToggling(true);
    setError(null);
    try {
      if (go2rtcRunning) {
        await trpcMutation("go2rtc.stop", undefined as any);
      } else {
        await trpcMutation("go2rtc.start", undefined as any);
      }
      const st = await trpcQuery<{ running: boolean }>("go2rtc.status").catch(() => null);
      setGo2rtcRunning(st?.running ?? false);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setGo2rtcToggling(false);
    }
  }, [go2rtcRunning, refresh]);

  const setRtspSource = useCallback(async (value: "go2rtc" | "local") => {
    setRtspSourceSaving(true);
    try {
      await trpcMutation("go2rtc.updateSettings", { rtspSource: value });
      setRtspSourceState(value);
    } catch (e) {
      setError(String(e));
    } finally {
      setRtspSourceSaving(false);
    }
  }, []);

  const deleteCamera = useCallback(
    async (id: string) => {
      await trpcMutation("cameras.delete", { id });
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(true), 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    // Discover streams for connected cameras that don't have cached streams yet.
    // Sleeping battery cameras are included: the server returns a lightweight cached
    // profile list without waking the camera, so the UI can show preview/URL buttons.
    const connected = cameras.filter(
      (c) => c.status === "connected" && !streamsByCamera[c.id],
    );
    if (connected.length === 0) return;

    const loadStreams = async () => {
      const nextLoading: Record<string, boolean> = {};
      for (const cam of connected) nextLoading[cam.id] = true;
      setStreamsLoadingByCamera((prev) => ({ ...prev, ...nextLoading }));

      const nextStreams: Record<string, AvailableStream[]> = {};
      await Promise.all(
        connected.map(async (cam) => {
          try {
            const res = await trpcQuery<{ nativeStreams: AvailableStream[] }>(
              "cameras.getAvailableStreams",
              {
                id: cam.id,
                channel: cam.isNvr ? (cam.rtspChannel ?? 0) : undefined,
              },
            );
            nextStreams[cam.id] = res.nativeStreams ?? [];
          } catch {
            nextStreams[cam.id] = [];
          }
        }),
      );
      setStreamsByCamera((prev) => ({ ...prev, ...nextStreams }));
      setStreamsLoadingByCamera((prev) => {
        const next = { ...prev };
        for (const cam of connected) next[cam.id] = false;
        return next;
      });
    };
    void loadStreams();
  }, [cameras]);

  useEffect(() => {
    const t = window.setInterval(() => {
      const connected = cameras.filter((c) => c.status === "connected");
      for (const cam of connected) {
        const streams = streamsByCamera[cam.id];
        const attempts = streamsDiscoveryAttemptsByCamera[cam.id] ?? 0;
        if ((streams?.length ?? 0) > 0) continue;
        if (attempts >= MAX_STREAM_DISCOVERY_ATTEMPTS) continue;
        if (streamsLoadingByCamera[cam.id]) continue;

        setStreamsDiscoveryAttemptsByCamera((m) => ({
          ...m,
          [cam.id]: attempts + 1,
        }));
        void discoverStreamsOnce(cam.id);
      }
    }, STREAM_DISCOVERY_RETRY_MS);

    return () => window.clearInterval(t);
  }, [
    cameras,
    streamsByCamera,
    streamsLoadingByCamera,
    streamsDiscoveryAttemptsByCamera,
    discoverStreamsOnce,
  ]);

  return {
    cameras,
    loading,
    error,
    connectingByCamera,
    rtspServers,
    rtspProxyStatus,
    go2rtcApiPort,
    go2rtcRtspPort,
    serviceIp,
    go2rtcRunning,
    go2rtcToggling,
    rtspSource,
    rtspSourceSaving,
    setRtspSource,
    streamsByCamera,
    streamsLoadingByCamera,
    streamsDiscoveryAttemptsByCamera,
    previewModal,
    addOpen,
    adding,
    addedCameraId,
    savingAutoStart,
    setAdding,
    setAddOpen: (open: boolean) => {
      if (!open) setAddedCameraId(null);
      setAddOpen(open);
    },
    setPreviewModal,
    refresh,
    connect,
    disconnect,
    setCameraDebug,
    setAutoStartForCamera,
    addCamera,
    deleteCamera,
    nvrs,
    addNvrOpen,
    setAddNvrOpen,
    deleteNvr,
    toggleGo2rtc,
  };
}
