import { useCallback, useEffect, useState } from "react";
import { trpcMutation, trpcQuery } from "../../api";
import { apiFetch } from "./utils";
import type {
  AddCameraInput,
  AvailableStream,
  CameraInfo,
  PreviewModalState,
  RtspStreamConfig,
  StreamProfile,
} from "./types";

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

export function useCamerasPage() {
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
      status?: string;
      connections?: number;
    }>
  >([]);
  const [mjpegStatus, setMjpegStatus] = useState<
    Array<{ cameraId: string; profile: StreamProfile; clients: number }>
  >([]);
  const [webrtcStatus, setWebrtcStatus] = useState<
    Array<{
      sessionId: string;
      cameraId: string;
      profile: StreamProfile;
      state: string;
    }>
  >([]);
  const [hlsStatus, setHlsStatus] = useState<
    Array<{ cameraId: string; profile: StreamProfile; clients: number }>
  >([]);
  const [rtspProxyStatus, setRtspProxyStatus] = useState<null | {
    enabled: boolean;
    running: boolean;
    port: number;
    host: string;
    connections: number;
  }>(null);
  const [savingProxy, setSavingProxy] = useState(false);
  const [streamsLoadingByCamera, setStreamsLoadingByCamera] = useState<
    Record<string, boolean>
  >({});
  const [streamsDiscoveryAttemptsByCamera, setStreamsDiscoveryAttemptsByCamera] =
    useState<Record<string, number>>({});
  const [previewModal, setPreviewModal] = useState<PreviewModalState>({
    open: false,
  });
  const [savingMaster, setSavingMaster] = useState(false);
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

  const refresh = useCallback(async (silent = false): Promise<CameraInfo[] | null> => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const [list, proxy, rtspList, mjpeg, webrtc, hls] = await Promise.all([
        trpcQuery<CameraInfo[]>("cameras.list"),
        trpcQuery<any>("rtspProxy.getStatus").catch(() => null),
        trpcQuery<any[]>("rtsp.list").catch(() => []),
        apiFetch("/api/mjpeg/status").then((r) => (r.ok ? r.json() : [])).catch(() => []),
        apiFetch("/api/webrtc/status")
          .then((r) => (r.ok ? r.json() : { sessions: [] }))
          .catch(() => ({ sessions: [] })),
        apiFetch("/api/hls/status").then((r) => (r.ok ? r.json() : [])).catch(() => []),
      ]);
      updateIfChanged(setCameras, list);

      updateIfChanged(
        setRtspServers,
        (rtspList ?? []).map((x: any) => ({
          cameraId: String(x.cameraId ?? x.cameraName ?? ""),
          profile: String(x.profile ?? "main") as StreamProfile,
          channel: Number(x.channel ?? 0),
          status: x.status ? String(x.status) : undefined,
          connections: x.connections === undefined ? undefined : Number(x.connections),
        })),
      );

      updateIfChanged(
        setMjpegStatus,
        (mjpeg ?? []).map((x: any) => ({
          cameraId: String(x.cameraId ?? ""),
          profile: String(x.profile ?? "main") as StreamProfile,
          clients: Number(x.clients ?? 0),
        })),
      );

      updateIfChanged(
        setWebrtcStatus,
        (webrtc?.sessions ?? []).map((x: any) => ({
          sessionId: String(x.sessionId ?? ""),
          cameraId: String(x.cameraId ?? ""),
          profile: String(x.profile ?? "main") as StreamProfile,
          state: String(x.state ?? ""),
        })),
      );

      updateIfChanged(
        setHlsStatus,
        (hls ?? []).map((x: any) => ({
          cameraId: String(x.cameraId ?? ""),
          profile: String(x.profile ?? "main") as StreamProfile,
          clients: Number(x.clients ?? 0),
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

  const toggleProxy = useCallback(async () => {
    setSavingProxy(true);
    setError(null);
    try {
      if (rtspProxyStatus?.running) {
        await trpcMutation("rtspProxy.stop", undefined as any);
      } else {
        await trpcMutation("rtspProxy.start", undefined as any);
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingProxy(false);
    }
  }, [rtspProxyStatus?.running, refresh]);

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
    mjpegStatus,
    webrtcStatus,
    hlsStatus,
    rtspProxyStatus,
    savingProxy,
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
    toggleProxy,
  };
}
