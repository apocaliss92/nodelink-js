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
        trpcQuery<{ apiUrl: string | null; running: boolean }>("go2rtc.status").catch(() => null),
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
      }
      updateIfChanged(setCameras, list);

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
      await trpcMutation("cameras.add", {
        name: adding.name || undefined,
        host: adding.host,
        port: adding.port ?? 9000,
        username: adding.username,
        password: adding.password,
        channels: 1,
        isNvr: adding.isNvr,
        rtspChannel: adding.isNvr ? Number(adding.nvrChannel || 0) : 0,
      });
      setAdding({
        host: "",
        port: 9000,
        username: "",
        password: "",
        name: "",
        isNvr: false,
        nvrChannel: 0,
      });
      setAddOpen(false);
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
      if (!confirm("Delete camera?")) return;
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
    // Skip sleeping cameras — they'll be discovered when they wake up.
    const connected = cameras.filter(
      (c) => c.status === "connected" && !streamsByCamera[c.id] && c.sleepStatus !== "sleeping",
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
      const connected = cameras.filter((c) => c.status === "connected" && c.sleepStatus !== "sleeping");
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
    savingAutoStart,
    setAdding,
    setAddOpen,
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
