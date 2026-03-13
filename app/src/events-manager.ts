/**
 * Events Manager: collects events from all connected Reolink cameras
 * and emits them via SSE, JSON stream and MQTT.
 */

import type { ReolinkSimpleEvent } from "@apocaliss92/nodelink-js";
import type { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";
import type { Response } from "express";
import { onApiConnected, onApiDisconnected } from "./rtsp-manager.js";
import { getConfig, getSettings } from "./settings-store.js";
import { getCameraInfo } from "./rtsp-manager.js";
import { sanitizeCameraName } from "./rtsp-manager.js";
import { createSourceLogger } from "./logger.js";

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

/** Cameras already registered (to avoid duplicate subscriptions) */
const registeredCameras = new Set<string>();

/** MQTT client (lazy init) */
let mqttClient: import("mqtt").MqttClient | null = null;

/** Union of all event payloads (camera + system) */
export type AnyEventPayload = CameraEventPayload | SystemEventPayload;

/** In-memory buffer of recent events per camera (for UI) */
const RECENT_EVENTS_MAX = 100;
const recentEventsByCamera = new Map<string, AnyEventPayload[]>();

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
      mqttClient.publish(topic, json, { qos: mqtt.qos ?? 0 });
      // Generic topic for all events
      mqttClient.publish(`${mqtt.topicPrefix}/all`, json, { qos: mqtt.qos ?? 0 });
    }
  }
}

function handleCameraEvent(cameraId: string, event: ReolinkSimpleEvent): void {
  const payload = buildPayload(cameraId, event);
  logger.debug(
    `Event: ${payload.cameraName} ch${event.channel} ${event.type}`,
  );
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

  api.onSimpleEvent((event) => handleCameraEvent(cameraId, event));
  logger.info(`Subscribed to events for camera ${cameraId}`);
}

/**
 * Initialize the events manager: registers to API connections and
 * starts collecting events from all connected cameras.
 */
export function initEventsManager(): void {
  onApiConnected((cameraId, api) => {
    registerCameraEvents(cameraId, api);
    emitSystemEvent(cameraId, "camera_connected");
  });
  onApiDisconnected((cameraId) => {
    emitSystemEvent(cameraId, "camera_disconnected");
    registeredCameras.delete(cameraId);
    recentEventsByCamera.delete(cameraId);
    logger.debug(`Unregistered events for camera ${cameraId}`);
  });
  logger.info("Events manager initialized");
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
