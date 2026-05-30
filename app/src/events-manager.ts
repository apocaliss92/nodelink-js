/**
 * Events Manager: collects events from all connected Reolink cameras
 * and emits them via SSE, JSON stream and MQTT.
 */

import type {
  ReolinkSimpleEvent,
  ReolinkDetectionEvent,
} from "@apocaliss92/nodelink-js";
import type { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";
import type { Response } from "express";
import { onApiConnected, onApiDisconnected } from "./rtsp-manager.js";
import { getConfig, getSettings, updateCamera } from "./settings-store.js";
import {
  onEmailPushEvent,
  type EmailPushEvent,
} from "./email-push-server.js";
import { getCameraInfo } from "./rtsp-manager.js";
import { sanitizeCameraName } from "./rtsp-manager.js";
import { createSourceLogger } from "./logger.js";
import { isBatteryCamera } from "./camera-traits.js";

const logger = createSourceLogger("events-manager");

export interface CameraEventPayload {
  /** Camera ID */
  cameraId: string;
  /** Human-readable camera name */
  cameraName: string;
  /** Sanitized name for URLs (e.g. living_room) */
  cameraNameSlug: string;
  /** Event type: motion, doorbell, people, vehicle, animal, face, package, daynight, etc. */
  type: ReolinkSimpleEvent["type"];
  /** Channel (0-based) */
  channel: number;
  /** Unix timestamp ms */
  timestamp: number;
  /** ISO 8601 */
  timestampIso: string;
}

/** System event types (camera/stream lifecycle) */
export type SystemEventType =
  | "camera_connected"
  | "camera_disconnected"
  | "stream_clients";

export interface SystemEventPayload {
  cameraId: string;
  cameraName: string;
  cameraNameSlug: string;
  type: SystemEventType;
  channel: number;
  timestamp: number;
  timestampIso: string;
  /** For stream_clients: mjpeg, hls, webrtc, rtsp */
  streamType?: string;
  /** For stream_clients: main, sub, ext */
  profile?: string;
  /** For stream_clients: number of connected clients */
  clientCount?: number;
}

/** Connected SSE clients */
const sseClients = new Set<Response>();

/** Connected JSON stream clients */
const jsonStreamClients = new Set<Response>();

/**
 * Detection event payload — broadcast on a SEPARATE SSE channel because it
 * fires per-frame (10–30 Hz) vs. the alarm SSE which fires per-event. Keeping
 * them on different endpoints means consumers that only care about state
 * changes don't pay the per-frame bandwidth cost.
 */
export interface DetectionEventPayload {
  cameraId: string;
  cameraName: string;
  cameraNameSlug: string;
  channel: number;
  /** main / sub / ext — the stream profile that produced the boxes. */
  profile: "main" | "sub" | "ext";
  /** Frame timestamp in microseconds (from BcMedia). */
  microseconds: number;
  /** Source frame width in pixels (if reported by InfoV1/V2). */
  frameWidth?: number;
  /** Source frame height in pixels (if reported by InfoV1/V2). */
  frameHeight?: number;
  /** Decoded boxes in normalized [0, 1] coordinates. */
  boxes: ReolinkDetectionEvent["boxes"];
  /** Decoder diagnostic state. */
  decodeState: ReolinkDetectionEvent["decodeState"];
  /** Wall-clock when the frame was processed. */
  timestamp: number;
}

/** Connected SSE clients on the detection firehose. */
const detectionSseClients = new Set<Response>();

/**
 * Last seen AI classification (people/vehicle/animal/face/package) per camera.
 *
 * Used as a *best-effort* label for bounding boxes — the raw additionalHeader
 * doesn't carry the class index in a form we can decode yet, but the
 * `cmd_33 AlarmEventList` push that arrives within ~100ms of a detection DOES
 * include the AItype.
 *
 * IMPORTANT: this label is only reliable when there is exactly ONE box in the
 * frame. With multiple simultaneous detections (e.g. a person AND a vehicle)
 * we have no way to map each box to its class. In that case we omit the label
 * so the consumer doesn't see misleading information.
 */
const lastAiClassByCamera = new Map<
  string,
  { label: string; receivedAtMs: number }
>();
/**
 * Maximum age of the AI-class hint we'll trust as the box label. Kept short
 * (the AI push and the box-bearing frame are emitted within ~100–300ms of
 * each other for in-progress motion).
 */
const AI_LABEL_TTL_MS = 1_500;

/** Reolink `ReolinkSimpleEvent.type` values that act as box labels. */
const LABEL_EVENT_TYPES = new Set([
  "people",
  "vehicle",
  "animal",
  "face",
  "package",
]);

/** Cameras already registered (to avoid duplicate subscriptions) */
const registeredCameras = new Set<string>();

/**
 * Per-camera API handles for cameras with active event subscriptions. Used by
 * the detection-SSE lifecycle to attach `onObjectDetections` on demand: the
 * substream is only opened when at least one detection-SSE client is connected.
 */
const registeredApis = new Map<string, ReolinkBaichuanApi>();
let objectDetectionSubsActive = false;

/** MQTT client (lazy init) */
let mqttClient: import("mqtt").MqttClient | null = null;

/**
 * Per-topic semantic state cache for the raw MQTT publish path.
 * Stores the last published semantic state (the event `type`) per topic
 * so that repeated sleeping/awake events with the same state are skipped.
 * Comparing raw JSON would not work because the payload includes
 * `timestamp: Date.now()` which makes every payload unique.
 *
 * Key:   MQTT topic string
 * Value: last published event type (e.g. "sleeping", "awake")
 *
 * Note: the Home Assistant MQTT path (homeassistant-mqtt.ts) already
 * deduplicates inside MqttHaClient. This cache covers only the generic
 * events-manager publish used for the raw topic stream.
 */
const mqttPublishCache = new Map<string, string>();

/** Union of all event payloads (camera + system) */
export type AnyEventPayload = CameraEventPayload | SystemEventPayload;

/** In-memory buffer of recent events per camera (for UI) */
const RECENT_EVENTS_MAX = 100;
const recentEventsByCamera = new Map<string, AnyEventPayload[]>();

/** Per-camera sleep/wake status (tracked from sleeping/awake events) */
const cameraSleepStatus = new Map<string, "awake" | "sleeping">();

/** Per-camera latest battery info (tracked from battery push events) */
export interface CameraBatteryState {
  percent: number;
  chargeStatus?: string;
  adapterStatus?: string;
}
const cameraBatteryState = new Map<string, CameraBatteryState>();

/** Callback invoked when MQTT client connects (for Home Assistant discovery re-publish) */
let onMqttConnectedCb: (() => void) | null = null;

export function setOnMqttConnected(callback: (() => void) | null): void {
  onMqttConnectedCb = callback;
}

function buildPayload(
  cameraId: string,
  event: ReolinkSimpleEvent,
): CameraEventPayload {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  const info = getCameraInfo(cameraId);
  const cameraName = camera?.name ?? info?.name ?? cameraId;

  return {
    cameraId,
    cameraName,
    cameraNameSlug: sanitizeCameraName(cameraName),
    type: event.type,
    channel: event.channel,
    timestamp: event.timestamp ?? Date.now(),
    timestampIso: new Date(event.timestamp ?? Date.now()).toISOString(),
  };
}

function pushToRecentBuffer(payload: AnyEventPayload): void {
  let list = recentEventsByCamera.get(payload.cameraId);
  if (!list) {
    list = [];
    recentEventsByCamera.set(payload.cameraId, list);
  }
  list.unshift(payload);
  if (list.length > RECENT_EVENTS_MAX) list.length = RECENT_EVENTS_MAX;
}

function broadcastEventPayload(payload: AnyEventPayload): void {
  pushToRecentBuffer(payload);
  const json = JSON.stringify(payload);

  // SSE: send to all connected clients
  for (const res of sseClients) {
    try {
      if (!res.writableEnded) {
        res.write(`data: ${json}\n\n`);
      }
    } catch (e) {
      sseClients.delete(res);
    }
  }

  // JSON stream: send NDJSON line to all clients
  for (const res of jsonStreamClients) {
    try {
      if (!res.writableEnded) {
        res.write(json + "\n");
      }
    } catch (e) {
      jsonStreamClients.delete(res);
    }
  }

  // MQTT: publish to broker if configured
  if (mqttClient?.connected) {
    const settings = getSettings();
    const mqtt = settings.mqtt;
    if (mqtt?.enabled && mqtt?.topicPrefix) {
      const topic = `${mqtt.topicPrefix}/${payload.cameraNameSlug}/${payload.type}`;

      // State-based events (sleeping, awake) carry no new information when
      // the camera is already in that state. Skip the publish if the last
      // emitted type on this topic is identical. Compare the event TYPE
      // rather than the full JSON because payload.timestamp makes every
      // JSON naturally unique — a JSON compare would never hit the cache.
      // Transient trigger events (motion, people, …) always publish because
      // each occurrence is a distinct detection.
      const isStateEvent =
        payload.type === "sleeping" ||
        payload.type === "awake";

      const lastType = isStateEvent ? mqttPublishCache.get(topic) : undefined;
      if (!isStateEvent || lastType !== payload.type) {
        if (isStateEvent) mqttPublishCache.set(topic, payload.type);
        mqttClient.publish(topic, json, { qos: mqtt.qos ?? 0 });
      }

      // Generic all-events topic: always publish (consumers rely on the
      // event stream being complete regardless of deduplication above)
      mqttClient.publish(`${mqtt.topicPrefix}/all`, json, { qos: mqtt.qos ?? 0 });
    }
  }
}

/**
 * Handle a ReolinkSimpleEvent from a camera subscription.
 *
 * For `sleeping`/`awake` events this applies state-change deduplication:
 * the underlying UDP sleep inference (ReolinkBaichuanApi.startUdpSleepInference)
 * can flap between states as non-waking traffic ages in/out of its 10s
 * observation window, producing rapid `awake → sleeping → awake → …`
 * bursts even when the camera has had no actual interaction. Those flaps
 * must not be broadcast downstream (SSE/JSON-stream/MQTT) or they flood
 * Home Assistant automations and integrations with phantom state changes.
 *
 * Exported for unit testing.
 */
export function handleCameraEvent(
  cameraId: string,
  event: ReolinkSimpleEvent,
): void {
  const payload = buildPayload(cameraId, event);
  // [issue-8 debug] elevated to info with full payload so we can verify the
  // AI/battery events are reaching the events-manager after the sleep-
  // inference fix. Remove once HA pipeline is confirmed healthy.
  logger.info(
    `[issue-8] Event: ${payload.cameraName} ch${event.channel} ${event.type} payload=${JSON.stringify(event).slice(0, 200)}`,
  );

  // Cache the most recent AI classification so subsequent single-box
  // detection events can carry a human-readable label.
  if (LABEL_EVENT_TYPES.has(event.type)) {
    lastAiClassByCamera.set(cameraId, {
      label: event.type,
      receivedAtMs: Date.now(),
    });
  }

  // Track sleep/wake status for battery cameras — and dedupe repeats
  if (event.type === "sleeping" || event.type === "awake") {
    const newStatus = event.type === "sleeping" ? "sleeping" : "awake";
    const previousStatus = cameraSleepStatus.get(cameraId);

    // The legacy auto-mark heuristic ("set isBattery: true on first
    // sleeping/awake event") was removed in 0.4.21: battery-ness is now
    // derived from `transport === "udp"` and persisted by the
    // "Persisted resolved transport" hook in `initEventsManager`. The
    // hook fires inside `onApiConnected`, i.e. well before any
    // sleeping/awake event can reach this handler, so by the time we get
    // here the transport is already correct.

    // Dedupe: skip broadcast when the state hasn't actually changed.
    // This guards against UDP sleep-inference flapping described above.
    if (previousStatus === newStatus) {
      logger.debug(
        `Deduped duplicate ${event.type} event for ${payload.cameraName} (already ${newStatus})`,
      );
      return;
    }

    cameraSleepStatus.set(cameraId, newStatus);
  }

  // Track latest battery level from push events
  if (event.type === "battery" && event.battery) {
    const { batteryPercent, chargeStatus, adapterStatus } = event.battery as {
      batteryPercent?: number;
      chargeStatus?: string;
      adapterStatus?: string;
    };
    if (batteryPercent !== undefined) {
      cameraBatteryState.set(cameraId, {
        percent: batteryPercent,
        chargeStatus,
        adapterStatus,
      });
    }
  }

  broadcastEventPayload(payload);
}

function buildSystemPayload(
  cameraId: string,
  type: SystemEventType,
  extra?: { streamType?: string; profile?: string; clientCount?: number },
): SystemEventPayload {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  const info = getCameraInfo(cameraId);
  const cameraName = camera?.name ?? info?.name ?? cameraId;
  const now = Date.now();
  return {
    cameraId,
    cameraName,
    cameraNameSlug: sanitizeCameraName(cameraName),
    type,
    channel: 0,
    timestamp: now,
    timestampIso: new Date(now).toISOString(),
    ...extra,
  };
}

/**
 * Emit a system event (camera connected/disconnected, stream clients changed).
 * Broadcasts to SSE, JSON stream, and MQTT.
 */
export function emitSystemEvent(
  cameraId: string,
  type: SystemEventType,
  extra?: { streamType?: string; profile?: string; clientCount?: number },
): void {
  const payload = buildSystemPayload(cameraId, type, extra);
  logger.debug(`System event: ${payload.cameraName} ${type}`, extra);
  broadcastEventPayload(payload);
}

/**
 * Emit stream_clients event when the number of clients for a stream changes.
 */
export function emitStreamClientsChanged(
  cameraId: string,
  streamType: "mjpeg" | "hls" | "webrtc" | "rtsp",
  profile: "main" | "sub" | "ext",
  clientCount: number,
): void {
  emitSystemEvent(cameraId, "stream_clients", {
    streamType,
    profile,
    clientCount,
  });
}

function registerCameraEvents(cameraId: string, api: ReolinkBaichuanApi): void {
  // Allow re-registration after reconnection: the old API is dead,
  // so we must subscribe on the new one even if cameraId was already registered.
  registeredCameras.add(cameraId);
  registeredApis.set(cameraId, api);

  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  const cameraChannel = camera?.rtspChannel ?? 0;
  const isNvrChild = !!camera?.nvrId;

  // If a detection-SSE client is already connected when this camera comes
  // online, attach `onObjectDetections` so its substream starts immediately.
  // Pass the camera's channel explicitly — NVR children live on non-zero
  // channels and would otherwise get no AI boxes.
  if (objectDetectionSubsActive) {
    void api
      .onObjectDetections(
        (event) => {
          handleDetectionEvent(cameraId, event);
        },
        { channel: cameraChannel },
      )
      .catch((e: unknown) => {
        logger.warn(
          `onObjectDetections subscribe failed for ${cameraId}: ${(e as Error)?.message ?? e}`,
        );
      });
  }

  api.onSimpleEvent((event) => {
    // For NVR children, only process events for this camera's channel
    if (isNvrChild && event.channel !== undefined && event.channel !== cameraChannel) {
      return;
    }
    handleCameraEvent(cameraId, event);
  });

  // Detection events fire per-frame from the BcMedia overlay channel. We
  // always register the listener (it's cheap) but the broadcast short-circuits
  // when no SSE client is subscribed to the detection firehose.
  api.onDetection((event) => {
    if (isNvrChild && event.channel !== cameraChannel) return;
    handleDetectionEvent(cameraId, event);
  });

  logger.info(`Subscribed to events for camera ${cameraId}${isNvrChild ? ` (ch${cameraChannel})` : ""}`);
}

/**
 * Forward a detection event to any active SSE clients on the detection
 * firehose. Returns early if nobody's listening to keep the cost negligible
 * for the streaming hot path.
 */
function handleDetectionEvent(
  cameraId: string,
  event: ReolinkDetectionEvent,
): void {
  if (detectionSseClients.size === 0) return;

  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  if (!camera) return;
  const name = camera.name || camera.host;
  const slug = sanitizeCameraName(name);

  // The library decoder now resolves the AI class directly from the SDK's
  // static TLV map, so `b.label` is already set per box (people / vehicle /
  // animal / face). We retain the cmd_33 cache as a *fallback*: if a frame
  // arrives with boxes but no label (e.g. an unknown class for a firmware we
  // haven't mapped yet) AND there's exactly one box AND a recent AItype is
  // cached, we copy it.
  let fallbackLabel: string | undefined;
  if (event.boxes.length === 1 && !event.boxes[0]?.label) {
    const cached = lastAiClassByCamera.get(cameraId);
    if (cached && Date.now() - cached.receivedAtMs <= AI_LABEL_TTL_MS) {
      fallbackLabel = cached.label;
    }
  }
  const boxes = fallbackLabel
    ? event.boxes.map((b) => ({ ...b, label: b.label ?? fallbackLabel }))
    : event.boxes;

  const payload: DetectionEventPayload = {
    cameraId,
    cameraName: name,
    cameraNameSlug: slug,
    channel: event.channel,
    profile: event.profile,
    microseconds: event.microseconds,
    ...(event.frameWidth !== undefined ? { frameWidth: event.frameWidth } : {}),
    ...(event.frameHeight !== undefined ? { frameHeight: event.frameHeight } : {}),
    boxes,
    decodeState: event.decodeState,
    timestamp: Date.now(),
  };
  const json = JSON.stringify(payload);

  for (const res of detectionSseClients) {
    try {
      if (!res.writableEnded) {
        res.write(`data: ${json}\n\n`);
      }
    } catch {
      detectionSseClients.delete(res);
    }
  }
}

/**
 * Initialize the events manager: registers to API connections and
 * starts collecting events from all connected cameras.
 */
export function initEventsManager(): void {
  onApiConnected((cameraId, api) => {
    registerCameraEvents(cameraId, api);
    emitSystemEvent(cameraId, "camera_connected");

    const config = getConfig();
    const camera = config.cameras.find((c) => c.id === cameraId);

    // Persist the resolved transport when `auto` lands on UDP. Without this
    // every reconnect (e.g. after `idle_disconnect`, or after a manager
    // restart) pays the 4s TCP timeout before falling back to UDP — and
    // logs a noisy `ECONNREFUSED` for each cycle on battery cameras that
    // don't expose port 9000 over TCP. Once we know UDP is the working
    // transport, write it back so the next `new ReolinkBaichuanApi({...})`
    // skips the TCP attempt entirely.
    if (camera) {
      const resolved = api.client.getTransport?.();
      if (resolved === "udp" && camera.transport !== "udp") {
        updateCamera(cameraId, { transport: "udp" });
        logger.info(
          `Persisted resolved transport=udp for camera ${cameraId} (was ${camera.transport ?? "auto"}); future reconnects will skip the TCP probe`,
        );
      }
    }

    // For battery cameras: do a one-time battery query right after connect
    // while the camera is still awake, to seed the initial % before it sleeps.
    // getBatteryStatus() has a built-in sleeping guard and won't wake a camera
    // that already went to sleep before this runs.
    if (isBatteryCamera(camera)) {
      const ch = camera!.rtspChannel ?? 0;
      void api.getBatteryStatus(ch).then((battery) => {
        if (battery.batteryPercent !== undefined) {
          seedCameraBatteryState(cameraId, {
            percent: battery.batteryPercent,
            chargeStatus: battery.chargeStatus,
            adapterStatus: battery.adapterStatus,
          });
          logger.debug(`Seeded battery state for ${cameraId}: ${battery.batteryPercent}%`);
        }
      }).catch(() => {
        // best-effort — camera may have already gone to sleep
      });
    }
  });
  onApiDisconnected((cameraId) => {
    emitSystemEvent(cameraId, "camera_disconnected");
    registeredCameras.delete(cameraId);
    registeredApis.delete(cameraId);
    recentEventsByCamera.delete(cameraId);
    cameraSleepStatus.delete(cameraId);
    lastAiClassByCamera.delete(cameraId);
    logger.debug(`Unregistered events for camera ${cameraId}`);
  });

  // Forward email-push notifications (from battery cameras that can't keep
  // a TCP/ONVIF push subscription alive) as synthetic motion events.
  onEmailPushEvent((event: EmailPushEvent) => {
    const mappedType = mapEmailPushType(event.inferredType);
    const channel = inferChannelForCamera(event.cameraId);
    handleCameraEvent(event.cameraId, {
      type: mappedType,
      channel,
      timestamp: event.receivedAtMs,
    });
    // When the email carries an AI class, also fire a generic "motion" so
    // motion-only consumers (Frigate bridge, basic SSE listeners) still see
    // it — mirrors how native Baichuan push delivers both events.
    if (mappedType !== "motion" && mappedType !== "doorbell") {
      handleCameraEvent(event.cameraId, {
        type: "motion",
        channel,
        timestamp: event.receivedAtMs,
      });
    }
  });

  logger.info("Events manager initialized");
}

function mapEmailPushType(
  inferred: EmailPushEvent["inferredType"],
): ReolinkSimpleEvent["type"] {
  switch (inferred) {
    case "people":
      return "people";
    case "vehicle":
      return "vehicle";
    case "animal":
      return "animal";
    case "face":
      return "face";
    case "package":
      return "package";
    case "doorbell":
      return "doorbell";
    case "motion":
    case "other":
    default:
      return "motion";
  }
}

function inferChannelForCamera(cameraId: string): number {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  return camera?.rtspChannel ?? 0;
}

/**
 * Add an SSE client. The Response must be configured for streaming.
 */
export function addSseClient(res: Response): void {
  sseClients.add(res);
  res.on("close", () => sseClients.delete(res));
  res.on("error", () => sseClients.delete(res));
}

/**
 * Add a JSON stream client (NDJSON).
 */
export function addJsonStreamClient(res: Response): void {
  jsonStreamClients.add(res);
  res.on("close", () => jsonStreamClients.delete(res));
  res.on("error", () => jsonStreamClients.delete(res));
}

/**
 * Add an SSE client to the high-frequency detection firehose. Box overlays
 * subscribe here. Separate from the regular SSE channel because the rate is
 * orders of magnitude higher (per-frame vs per-event).
 */
export function addDetectionSseClient(res: Response): void {
  const wasEmpty = detectionSseClients.size === 0;
  detectionSseClients.add(res);
  if (wasEmpty) {
    void activateObjectDetectionSubs();
  }
  const onLeave = (): void => {
    if (!detectionSseClients.delete(res)) return;
    if (detectionSseClients.size === 0) {
      void deactivateObjectDetectionSubs();
    }
  };
  res.on("close", onLeave);
  res.on("error", onLeave);
}

/**
 * Attach `onObjectDetections` to every registered camera so AI detection boxes
 * start flowing even when no video player is open. Called when the first
 * detection-SSE client connects. Idempotent.
 */
async function activateObjectDetectionSubs(): Promise<void> {
  if (objectDetectionSubsActive) return;
  objectDetectionSubsActive = true;
  const config = getConfig();
  await Promise.allSettled(
    [...registeredApis.entries()].map(async ([cameraId, api]) => {
      const camera = config.cameras.find((c) => c.id === cameraId);
      const cameraChannel = camera?.rtspChannel ?? 0;
      try {
        await api.onObjectDetections(
          (event) => {
            handleDetectionEvent(cameraId, event);
          },
          { channel: cameraChannel },
        );
      } catch (e) {
        logger.warn(
          `onObjectDetections activate failed for ${cameraId}: ${(e as Error)?.message ?? e}`,
        );
      }
    }),
  );
  logger.info(
    `Detection SSE: activated onObjectDetections on ${registeredApis.size} camera(s)`,
  );
}

/**
 * Detach `onObjectDetections` from every registered camera. Called when the
 * last detection-SSE client disconnects. Idempotent.
 */
async function deactivateObjectDetectionSubs(): Promise<void> {
  if (!objectDetectionSubsActive) return;
  objectDetectionSubsActive = false;
  const config = getConfig();
  await Promise.allSettled(
    [...registeredApis.entries()].map(async ([cameraId, api]) => {
      const camera = config.cameras.find((c) => c.id === cameraId);
      const cameraChannel = camera?.rtspChannel ?? 0;
      try {
        // Per-channel teardown: an NVR `api` may be shared by several child
        // cameras, so we only clear listeners for *this* camera's channel.
        await api.offObjectDetections(undefined, { channel: cameraChannel });
      } catch (e) {
        logger.warn(
          `offObjectDetections failed: ${(e as Error)?.message ?? e}`,
        );
      }
    }),
  );
  logger.info(`Detection SSE: deactivated onObjectDetections`);
}

/** Number of currently connected detection SSE clients. */
export function getDetectionClientCount(): number {
  return detectionSseClients.size;
}

/**
 * Return the count of connected SSE and JSON stream clients.
 */
export function getEventsManagerStatus(): {
  sseClients: number;
  jsonStreamClients: number;
  mqttConnected: boolean;
  registeredCameras: number;
} {
  return {
    sseClients: sseClients.size,
    jsonStreamClients: jsonStreamClients.size,
    mqttConnected: mqttClient?.connected ?? false,
    registeredCameras: registeredCameras.size,
  };
}

/**
 * Connect the MQTT client and start publishing events.
 * Requires mqtt.enabled and mqtt.brokerUrl to be configured in settings.
 */
export async function connectMqtt(): Promise<boolean> {
  const settings = getSettings();
  const mqtt = settings.mqtt;
  if (!mqtt?.enabled || !mqtt?.brokerUrl) {
    return false;
  }

  if (mqttClient?.connected) {
    return true;
  }

  try {
    const mqttModule = await import("mqtt");
    mqttClient = mqttModule.connect(mqtt.brokerUrl, {
      username: mqtt.username,
      password: mqtt.password,
      clientId: mqtt.clientId ?? `nodelink-manager-${Date.now()}`,
      reconnectPeriod: mqtt.reconnectPeriod ?? 5000,
    });

    mqttClient.on("connect", () => {
      logger.info("MQTT client connected");
      onMqttConnectedCb?.();
    });

    mqttClient.on("error", (err) => {
      const msg =
        err?.message ||
        err?.toString?.() ||
        (typeof err === "string" ? err : "Unknown error");
      const code =
        err && "code" in err && err.code != null ? ` [${err.code}]` : "";
      const broker = mqtt.brokerUrl ? ` (broker: ${mqtt.brokerUrl})` : "";
      logger.error(`MQTT error: ${msg}${code}${broker}`);
    });

    mqttClient.on("close", () => {
      logger.info("MQTT client disconnected");
    });

    return true;
  } catch (e) {
    logger.error(`Failed to connect MQTT: ${e}`);
    return false;
  }
}

/**
 * Disconnect the MQTT client.
 */
export async function disconnectMqtt(): Promise<void> {
  if (mqttClient) {
    mqttClient.end();
    mqttClient = null;
    logger.info("MQTT client disconnected");
  }
}

/**
 * Get the MQTT client instance (for Home Assistant and other modules).
 * Returns null if MQTT is not connected.
 */
export function getMqttClient(): import("mqtt").MqttClient | null {
  return mqttClient;
}

/**
 * Get the sleep/wake status of a camera.
 * Returns undefined if no sleeping/awake event has been received yet.
 */
/**
 * Reset all in-memory event state. Test-only helper — callers in production
 * code should not need this.
 */
export function _resetEventsStateForTests(): void {
  cameraSleepStatus.clear();
  cameraBatteryState.clear();
  mqttPublishCache.clear();
  recentEventsByCamera.clear();
  sseClients.clear();
  jsonStreamClients.clear();
  registeredCameras.clear();
}

export function getCameraSleepStatus(cameraId: string): "awake" | "sleeping" | undefined {
  return cameraSleepStatus.get(cameraId);
}

/**
 * Get the latest battery state of a camera.
 * Returns undefined if no battery push event has been received yet.
 */
export function getCameraBatteryState(cameraId: string): CameraBatteryState | undefined {
  return cameraBatteryState.get(cameraId);
}

/**
 * Seed the battery state for a camera from a one-time query (e.g. at connect time).
 * Only updates if the new value is more informative (has a percent).
 * Existing push-event data takes precedence over a polled seed.
 */
export function seedCameraBatteryState(
  cameraId: string,
  state: CameraBatteryState,
): void {
  // Don't overwrite a value already populated by a push event
  if (cameraBatteryState.has(cameraId)) return;
  if (state.percent === undefined) return;
  cameraBatteryState.set(cameraId, state);
}

/**
 * Get recent events for a camera or all cameras.
 * Used by the UI to display the latest events.
 */
export function getRecentEvents(cameraId?: string): AnyEventPayload[] {
  if (cameraId) {
    const list = recentEventsByCamera.get(cameraId) ?? [];
    return [...list];
  }
  const all: AnyEventPayload[] = [];
  for (const list of recentEventsByCamera.values()) {
    all.push(...list);
  }
  all.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  return all.slice(0, RECENT_EVENTS_MAX);
}
