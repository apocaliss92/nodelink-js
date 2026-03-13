import { useCallback, useEffect, useRef, useState } from "react";
import { trpcMutation, trpcQuery } from "../../api";
import { withAuthTokenQuery } from "./utils";
import type { CameraEvent, ControlsState } from "./types";
import { EventsModal } from "./EventsModal";
import { PtzModal } from "./PtzModal";

export function CameraControlsSection({
  cameraId,
  cameraName,
  isConnected,
  sleepStatus,
}: {
  cameraId: string;
  cameraName: string;
  sanitizedName: string;
  isConnected: boolean;
  sleepStatus?: "awake" | "sleeping";
}) {
  const [controlsState, setControlsState] = useState<ControlsState>(null);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [ptzOpen, setPtzOpen] = useState(false);
  const [events, setEvents] = useState<CameraEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // Don't fetch controls when camera is sleeping
  const isAwake = sleepStatus !== "sleeping";

  const fetchControlsState = useCallback(async () => {
    if (!isConnected || !isAwake) return;
    try {
      const st = await trpcQuery<ControlsState>("cameras.getControlsState", {
        id: cameraId,
      });
      setControlsState(st ?? null);
    } catch {
      setControlsState(null);
    }
  }, [cameraId, isConnected, isAwake]);

  useEffect(() => {
    void fetchControlsState();
  }, [fetchControlsState]);

  const fetchEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      const list = await trpcQuery<CameraEvent[]>("events.getRecent", {
        cameraId,
      });
      setEvents(list ?? []);
    } catch {
      setEvents([]);
    } finally {
      setEventsLoading(false);
    }
  }, [cameraId]);

  useEffect(() => {
    if (eventsOpen && isConnected && isAwake) void fetchEvents();
  }, [eventsOpen, isConnected, isAwake, fetchEvents]);

  useEffect(() => {
    if (!eventsOpen || !isConnected || !isAwake) return;
    const sseUrl = withAuthTokenQuery(
      `${window.location.origin}/api/events/sse`,
    );
    const es = new EventSource(sseUrl);
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data) as CameraEvent;
        if (payload.cameraId === cameraId) {
          setEvents((prev) => [payload, ...prev].slice(0, 50));
        }
      } catch {
        // ignore
      }
    };
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [eventsOpen, isConnected, isAwake, cameraId]);

  const toggleLight = useCallback(async () => {
    if (!controlsState?.hasFloodlight) return;
    setToggling("light");
    try {
      const next = !controlsState.lightOn;
      await trpcMutation("cameras.setLight", { id: cameraId, on: next });
      setControlsState((s) => (s ? { ...s, lightOn: next } : null));
    } catch {
      // ignore
    } finally {
      setToggling(null);
    }
  }, [cameraId, controlsState]);

  const toggleSiren = useCallback(async () => {
    if (!controlsState?.hasSiren) return;
    setToggling("siren");
    try {
      const next = !controlsState.sirenOn;
      await trpcMutation("cameras.setSiren", { id: cameraId, on: next });
      setControlsState((s) => (s ? { ...s, sirenOn: next } : null));
    } catch {
      // ignore
    } finally {
      setToggling(null);
    }
  }, [cameraId, controlsState]);

  const toggleFloodlightOnMotion = useCallback(async () => {
    if (!controlsState?.hasFloodlight) return;
    setToggling("lightMotion");
    try {
      const next = !controlsState.floodlightOnMotion;
      await trpcMutation("cameras.setFloodlightOnMotion", { id: cameraId, on: next });
      setControlsState((s) => (s ? { ...s, floodlightOnMotion: next } : null));
    } catch {
      // ignore
    } finally {
      setToggling(null);
    }
  }, [cameraId, controlsState]);

  const toggleSirenOnMotion = useCallback(async () => {
    if (!controlsState?.hasSiren) return;
    setToggling("sirenMotion");
    try {
      const next = !controlsState.sirenOnMotion;
      await trpcMutation("cameras.setSirenOnMotion", { id: cameraId, on: next });
      setControlsState((s) => (s ? { ...s, sirenOnMotion: next } : null));
    } catch {
      // ignore
    } finally {
      setToggling(null);
    }
  }, [cameraId, controlsState]);

  const toggleAutotracking = useCallback(async () => {
    if (!controlsState?.hasAutotracking) return;
    setToggling("autotrack");
    try {
      const next = !controlsState.autotrackingOn;
      await trpcMutation("cameras.setAutotracking", { id: cameraId, on: next });
      setControlsState((s) => (s ? { ...s, autotrackingOn: next } : null));
    } catch {
      // ignore
    } finally {
      setToggling(null);
    }
  }, [cameraId, controlsState]);

  const togglePir = useCallback(async () => {
    if (!controlsState?.hasPir) return;
    setToggling("pir");
    try {
      const next = !controlsState.pirOn;
      await trpcMutation("cameras.setPir", { id: cameraId, on: next });
      setControlsState((s) => (s ? { ...s, pirOn: next } : null));
    } catch {
      // ignore
    } finally {
      setToggling(null);
    }
  }, [cameraId, controlsState]);

  const ptzStart = useCallback(
    (cmd: "Up" | "Down" | "Left" | "Right" | "ZoomIn" | "ZoomOut") => {
      void trpcMutation("cameras.ptzControl", {
        id: cameraId,
        command: cmd,
        action: "start",
      });
    },
    [cameraId],
  );

  const ptzStop = useCallback(
    (cmd: "Up" | "Down" | "Left" | "Right" | "ZoomIn" | "ZoomOut") => {
      void trpcMutation("cameras.ptzControl", {
        id: cameraId,
        command: cmd,
        action: "stop",
      });
    },
    [cameraId],
  );

  const gotoPreset = useCallback(
    (presetId: number) => {
      return () => {
        void trpcMutation("cameras.ptzGotoPreset", {
          id: cameraId,
          preset: presetId,
        });
      };
    },
    [cameraId],
  );

  if (!isConnected) return null;

  return (
    <div
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTop: "1px solid var(--border)",
      }}
    >
      <div
        className="row"
        style={{
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          className="btn"
          onClick={() => setEventsOpen(true)}
          style={{ fontSize: 13 }}
        >
          Events
        </button>
        {controlsState?.hasFloodlight && (
          <button
            type="button"
            className={`btn ${
              controlsState.lightOn ? "autostart on" : "autostart off"
            }`}
            onClick={toggleLight}
            disabled={toggling === "light"}
            style={{ fontSize: 13 }}
            title={controlsState.lightOn ? "Turn off light" : "Turn on light"}
          >
            {toggling === "light" ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <>💡 {controlsState.lightOn ? "ON" : "OFF"}</>
            )}
          </button>
        )}
        {controlsState?.hasSiren && (
          <button
            type="button"
            className={`btn ${
              controlsState.sirenOn ? "autostart on" : "autostart off"
            }`}
            onClick={toggleSiren}
            disabled={toggling === "siren"}
            style={{ fontSize: 13 }}
            title={
              controlsState.sirenOn ? "Disable alarm" : "Enable alarm"
            }
          >
            {toggling === "siren" ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <>🔔 {controlsState.sirenOn ? "ON" : "OFF"}</>
            )}
          </button>
        )}
        {controlsState?.hasFloodlight && (
          <button
            type="button"
            className={`btn ${
              controlsState.floodlightOnMotion ? "autostart on" : "autostart off"
            }`}
            onClick={toggleFloodlightOnMotion}
            disabled={toggling === "lightMotion"}
            style={{ fontSize: 13 }}
            title={controlsState.floodlightOnMotion ? "Disable light on motion" : "Enable light on motion"}
          >
            {toggling === "lightMotion" ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <>💡⚡ {controlsState.floodlightOnMotion ? "ON" : "OFF"}</>
            )}
          </button>
        )}
        {controlsState?.hasSiren && (
          <button
            type="button"
            className={`btn ${
              controlsState.sirenOnMotion ? "autostart on" : "autostart off"
            }`}
            onClick={toggleSirenOnMotion}
            disabled={toggling === "sirenMotion"}
            style={{ fontSize: 13 }}
            title={controlsState.sirenOnMotion ? "Disable siren on motion" : "Enable siren on motion"}
          >
            {toggling === "sirenMotion" ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <>🔔⚡ {controlsState.sirenOnMotion ? "ON" : "OFF"}</>
            )}
          </button>
        )}
        {controlsState?.hasAutotracking && (
          <button
            type="button"
            className={`btn ${
              controlsState.autotrackingOn ? "autostart on" : "autostart off"
            }`}
            onClick={toggleAutotracking}
            disabled={toggling === "autotrack"}
            style={{ fontSize: 13 }}
            title={controlsState.autotrackingOn ? "Disable auto-tracking" : "Enable auto-tracking"}
          >
            {toggling === "autotrack" ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <>🎯 {controlsState.autotrackingOn ? "ON" : "OFF"}</>
            )}
          </button>
        )}
        {controlsState?.hasPir && (
          <button
            type="button"
            className={`btn ${
              controlsState.pirOn ? "autostart on" : "autostart off"
            }`}
            onClick={togglePir}
            disabled={toggling === "pir"}
            style={{ fontSize: 13 }}
            title={controlsState.pirOn ? "Disable PIR sensor" : "Enable PIR sensor"}
          >
            {toggling === "pir" ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <>📡 {controlsState.pirOn ? "ON" : "OFF"}</>
            )}
          </button>
        )}
        {(controlsState?.hasPtz || controlsState?.hasPresets) && (
          <button
            type="button"
            className="btn"
            onClick={() => setPtzOpen(true)}
            style={{ fontSize: 13 }}
          >
            PTZ
          </button>
        )}
      </div>

      {eventsOpen && (
        <EventsModal
          cameraName={cameraName}
          events={events}
          loading={eventsLoading}
          onClose={() => setEventsOpen(false)}
        />
      )}

      {ptzOpen && (
        <PtzModal
          cameraName={cameraName}
          controlsState={controlsState}
          onPtzStart={ptzStart}
          onPtzStop={ptzStop}
          onGotoPreset={gotoPreset}
          onClose={() => setPtzOpen(false)}
        />
      )}
    </div>
  );
}
