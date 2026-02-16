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
}: {
  cameraId: string;
  cameraName: string;
  sanitizedName: string;
  isConnected: boolean;
}) {
  const [controlsState, setControlsState] = useState<ControlsState>(null);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [ptzOpen, setPtzOpen] = useState(false);
  const [events, setEvents] = useState<CameraEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [toggling, setToggling] = useState<"light" | "siren" | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const fetchControlsState = useCallback(async () => {
    if (!isConnected) return;
    try {
      const st = await trpcQuery<ControlsState>("cameras.getControlsState", {
        id: cameraId,
      });
      setControlsState(st ?? null);
    } catch {
      setControlsState(null);
    }
  }, [cameraId, isConnected]);

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
    if (eventsOpen && isConnected) void fetchEvents();
  }, [eventsOpen, isConnected, fetchEvents]);

  useEffect(() => {
    if (!eventsOpen || !isConnected) return;
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
  }, [eventsOpen, isConnected, cameraId]);

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
