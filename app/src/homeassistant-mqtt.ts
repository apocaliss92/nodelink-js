/**
 * Home Assistant MQTT integration for Reolink cameras.
 *
 * Architecture:
 *   - One state topic per entity (no Jinja2 templating).
 *   - Device-based MQTT discovery: a single retained message per camera
 *     at `homeassistant/device/nodelink-js-{cameraId}/config` carrying
 *     all entities under `cmps`.
 *   - Event-driven: camera events are forwarded to per-entity state
 *     topics as they happen (motion, visitor, battery, sleeping, ...).
 *   - Minimal polling: control state (floodlight/siren/PIR/autotracking)
 *     is fetched once at connect time to seed initial switch states.
 *
 * The standalone discovery primitives live in `./mqtt-ha/`. This file
 * is the application-specific glue between Reolink APIs and that
 * library.
 */

import type {
  ReolinkBaichuanApi,
  ReolinkSimpleEvent,
  DeviceCapabilities,
} from "@apocaliss92/nodelink-js";

import {
  onApiConnected,
  onApiDisconnected,
  getCameraInfo,
} from "./rtsp-manager.js";
import { getConfig, getSettings } from "./settings-store.js";
import { readAppVersion } from "./app-version.js";
import { createSourceLogger } from "./logger.js";

import {
  MqttClient as HaMqttClient,
  publishMqttDeviceDiscovery,
  clearMqttDevice,
  getMqttTopics,
  getControlEntities,
  getDetectionEntities,
  getStatusEntities,
  getBatteryEntities,
  getWifiEntities,
  PAYLOAD_ON,
  PAYLOAD_OFF,
  type MqttDeviceInfo,
  type MqttEntity,
  type IHaClient,
} from "./mqtt-ha/index.js";

const logger = createSourceLogger("homeassistant-mqtt");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ID_PREFIX = "nodelink-js";
const NAME_PREFIX = "Nodelink.js";
const ORIGIN_URL = "https://github.com/apocaliss92/nodelink-js";
const BRIDGE_DEVICE_ID = "nodelink-manager";

/** How long a momentary detection event stays "on" before auto-resetting. */
const DETECTION_RESET_MS = 30_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let haClient: IHaClient | undefined;
let bridgePublished = false;

interface RegisteredCamera {
  cameraId: string;
  api: ReolinkBaichuanApi;
  channel: number;
  entities: MqttEntity[];
  deviceInfo: MqttDeviceInfo;
  /** Topics currently subscribed (for cleanup on disconnect). */
  commandTopics: Set<string>;
  /** Pending detection-reset timers, keyed by entity name. */
  detectionResetTimers: Map<string, NodeJS.Timeout>;
  /** Listener registered with `api.onSimpleEvent` — kept for `offSimpleEvent`. */
  eventListener?: (event: ReolinkSimpleEvent) => void;
}

const cameras = new Map<string, RegisteredCamera>();

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

interface HaConnectionContext {
  brokerUrl: string;
  username?: string;
  password?: string;
  clientId?: string;
}

function getHaContext(): HaConnectionContext | null {
  const settings = getSettings();
  const ha = settings.homeassistant;
  const mqtt = settings.mqtt;
  if (!ha?.enabled || !mqtt?.enabled) return null;
  if (!mqtt.brokerUrl) return null;
  return {
    brokerUrl: mqtt.brokerUrl,
    username: mqtt.username,
    password: mqtt.password,
    clientId: mqtt.clientId
      ? `${mqtt.clientId}-ha`
      : `nodelink-ha-${Date.now()}`,
  };
}

function isEnabled(): boolean {
  return getHaContext() !== null;
}

// ---------------------------------------------------------------------------
// Device builders
// ---------------------------------------------------------------------------

function buildBridgeDevice(appVersion: string): MqttDeviceInfo {
  return {
    id: BRIDGE_DEVICE_ID,
    name: "Nodelink Manager",
    manufacturer: NAME_PREFIX,
    model: "Manager",
    swVersion: appVersion,
  };
}

function buildCameraDevice(
  cameraId: string,
  cameraName: string,
  appVersion: string,
  cameraInfo?: ReturnType<typeof getCameraInfo>,
): MqttDeviceInfo {
  const model =
    cameraInfo?.deviceInfo?.model ??
    cameraInfo?.deviceInfo?.hubModel ??
    cameraInfo?.name ??
    "Camera";
  return {
    id: cameraId,
    name: cameraName,
    manufacturer: "Reolink",
    model,
    swVersion: appVersion,
    viaDevice: BRIDGE_DEVICE_ID,
  };
}

// ---------------------------------------------------------------------------
// Bridge device
// ---------------------------------------------------------------------------

async function publishBridgeDiscovery(): Promise<void> {
  if (!haClient || !isEnabled()) return;

  const appVersion = readAppVersion() ?? "0.0.0";
  const deviceInfo = buildBridgeDevice(appVersion);

  // The bridge currently exposes no entities — its only purpose is to be
  // referenced as `via_device` from camera devices. HA still requires us
  // to publish at least one component, so we expose an "online" diagnostic
  // binary sensor.
  const entities: MqttEntity[] = [
    {
      entity: "online",
      domain: "binary_sensor",
      name: "Online",
      deviceClass: "connectivity",
      entityCategory: "diagnostic",
      retain: true,
      valueToDispatch: PAYLOAD_ON,
    },
  ];

  await publishMqttDeviceDiscovery({
    client: haClient,
    deviceInfo,
    entities,
    idPrefix: ID_PREFIX,
    namePrefix: NAME_PREFIX,
    originUrl: ORIGIN_URL,
  });

  bridgePublished = true;
  logger.info("Published bridge discovery");
}

// ---------------------------------------------------------------------------
// Camera entity assembly
// ---------------------------------------------------------------------------

async function buildCameraEntities(
  api: ReolinkBaichuanApi,
  channel: number,
  isBatteryCamera: boolean,
): Promise<{ entities: MqttEntity[]; capabilities?: DeviceCapabilities }> {
  let capabilities: DeviceCapabilities | undefined;
  try {
    const result = await api.getDeviceCapabilities(channel);
    capabilities = result.capabilities;
  } catch (e) {
    logger.debug(
      `Failed to fetch capabilities (continuing with defaults): ${e}`,
    );
  }

  const controlCaps = {
    hasFloodlight: capabilities?.hasFloodlight ?? false,
    hasSiren: capabilities?.hasSiren ?? false,
    hasPir: capabilities?.hasPir ?? false,
    hasAutotracking: capabilities?.hasAutotracking ?? false,
    hasPresets: capabilities?.hasPtz ?? false,
  };

  const entities: MqttEntity[] = [
    ...getDetectionEntities(),
    ...getStatusEntities(),
    ...getWifiEntities(),
    ...getControlEntities(controlCaps),
  ];

  if (isBatteryCamera || (capabilities?.hasBattery ?? false)) {
    entities.push(...getBatteryEntities());
  }

  // PTZ presets: replace the empty `options: []` with the real list.
  if (controlCaps.hasPresets) {
    try {
      const presets = await api.getPtzPresets(channel);
      const presetEntity = entities.find((e) => e.entity === "ptz_preset");
      if (presetEntity && presets.length > 0) {
        presetEntity.options = presets.map((p) => p.name);
      }
    } catch (e) {
      logger.debug(`Failed to fetch PTZ presets: ${e}`);
    }
  }

  return { entities, capabilities };
}

// ---------------------------------------------------------------------------
// Per-entity publish helper
// ---------------------------------------------------------------------------

async function publishEntityState(
  cameraId: string,
  entityName: string,
  value: unknown,
  retainOverride?: boolean,
): Promise<void> {
  const cam = cameras.get(cameraId);
  if (!cam || !haClient || !isEnabled()) return;

  const entity = cam.entities.find((e) => e.entity === entityName);
  if (!entity) {
    logger.debug(
      `Entity ${entityName} not registered for camera ${cameraId}, skipping publish`,
    );
    return;
  }

  const { stateTopic } = getMqttTopics({
    entity,
    deviceId: cameraId,
    idPrefix: ID_PREFIX,
  });

  const retain = retainOverride ?? entity.retain ?? true;
  await haClient.publish(stateTopic, value, retain);
}

// ---------------------------------------------------------------------------
// Initial control state seeding
// ---------------------------------------------------------------------------

async function seedControlStates(cam: RegisteredCamera): Promise<void> {
  const { api, channel, cameraId, entities } = cam;
  const has = (name: string) => entities.some((e) => e.entity === name);

  if (has("floodlight")) {
    try {
      const state = await api.getWhiteLedState(channel);
      const enabled =
        ((state as unknown as { enabled?: boolean | number }).enabled ??
          false) === true ||
        Number((state as unknown as { enabled?: number }).enabled ?? 0) === 1;
      await publishEntityState(
        cameraId,
        "floodlight",
        enabled ? PAYLOAD_ON : PAYLOAD_OFF,
      );
    } catch (e) {
      logger.debug(`Seed floodlight failed for ${cameraId}: ${e}`);
    }
  }

  if (has("floodlight_on_motion")) {
    try {
      const state = await api.getFloodlightOnMotion(channel);
      await publishEntityState(
        cameraId,
        "floodlight_on_motion",
        state.floodlightOnMotion ? PAYLOAD_ON : PAYLOAD_OFF,
      );
    } catch (e) {
      logger.debug(`Seed floodlight_on_motion failed for ${cameraId}: ${e}`);
    }
  }

  if (has("siren")) {
    try {
      const state = await api.getSiren(channel);
      await publishEntityState(
        cameraId,
        "siren",
        state.enabled ? PAYLOAD_ON : PAYLOAD_OFF,
      );
    } catch (e) {
      logger.debug(`Seed siren failed for ${cameraId}: ${e}`);
    }
  }

  if (has("pir")) {
    try {
      const state = await api.getPirInfo(channel);
      const enabled =
        Number(
          (state as unknown as { enable?: number; enabled?: boolean }).enable ??
            ((state as unknown as { enabled?: boolean }).enabled ? 1 : 0),
        ) === 1;
      await publishEntityState(
        cameraId,
        "pir",
        enabled ? PAYLOAD_ON : PAYLOAD_OFF,
      );
    } catch (e) {
      logger.debug(`Seed pir failed for ${cameraId}: ${e}`);
    }
  }

  if (has("autotracking")) {
    try {
      const state = await api.getAutotracking(channel);
      await publishEntityState(
        cameraId,
        "autotracking",
        state.enabled ? PAYLOAD_ON : PAYLOAD_OFF,
      );
    } catch (e) {
      logger.debug(`Seed autotracking failed for ${cameraId}: ${e}`);
    }
  }

  if (has("wifi_signal")) {
    try {
      const wifi = await api.getWifiSignal(channel);
      if (wifi.signal != null) {
        await publishEntityState(cameraId, "wifi_signal", wifi.signal);
      }
    } catch (e) {
      logger.debug(`Seed wifi_signal failed for ${cameraId}: ${e}`);
    }
  }

  // Online + sleeping defaults.
  await publishEntityState(cameraId, "online", PAYLOAD_ON);
  await publishEntityState(cameraId, "sleeping", PAYLOAD_OFF);
}

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

async function handleCommand(
  cam: RegisteredCamera,
  entityName: string,
  payload: string,
): Promise<void> {
  const { api, channel, cameraId } = cam;
  const isOn = payload === PAYLOAD_ON;
  logger.debug(`Command ${entityName} for ${cameraId}: ${payload}`);

  try {
    // Battery cameras may be in idle-disconnect when an MQTT command arrives.
    // Reconnect before issuing any command so sendXml doesn't timeout.
    if (!api.isReady && !api.isClosed) {
      await api.ensureConnected();
    }

    switch (entityName) {
      case "floodlight":
        await api.setWhiteLedState(channel, isOn);
        await publishEntityState(
          cameraId,
          "floodlight",
          isOn ? PAYLOAD_ON : PAYLOAD_OFF,
        );
        break;

      case "floodlight_on_motion":
        await api.setFloodlightOnMotion(isOn, channel);
        await publishEntityState(
          cameraId,
          "floodlight_on_motion",
          isOn ? PAYLOAD_ON : PAYLOAD_OFF,
        );
        break;

      case "siren":
        await api.setSiren(channel, isOn);
        await publishEntityState(
          cameraId,
          "siren",
          isOn ? PAYLOAD_ON : PAYLOAD_OFF,
        );
        break;

      case "siren_on_motion":
        await api.setSirenOnMotion({ enable: isOn ? 1 : 0 }, channel);
        await publishEntityState(
          cameraId,
          "siren_on_motion",
          isOn ? PAYLOAD_ON : PAYLOAD_OFF,
        );
        break;

      case "pir":
        await api.setPirInfo(channel, { enable: isOn ? 1 : 0 });
        await publishEntityState(
          cameraId,
          "pir",
          isOn ? PAYLOAD_ON : PAYLOAD_OFF,
        );
        break;

      case "autotracking":
        await api.setAutotracking(isOn, channel);
        await publishEntityState(
          cameraId,
          "autotracking",
          isOn ? PAYLOAD_ON : PAYLOAD_OFF,
        );
        break;

      case "ptz_preset": {
        const presets = await api.getPtzPresets(channel);
        const preset =
          presets.find((p) => p.name === payload) ??
          presets.find((p) => String(p.id) === payload);
        if (preset) {
          await api.moveToPtzPreset(channel, preset.id);
          await publishEntityState(cameraId, "ptz_preset", preset.name);
        } else {
          logger.warn(
            `PTZ preset "${payload}" not found for camera ${cameraId}`,
          );
        }
        break;
      }

      case "reboot":
        await api.reboot();
        break;

      default:
        logger.debug(`Unhandled command ${entityName} for ${cameraId}`);
    }
  } catch (e) {
    logger.error(`Command ${entityName} failed for ${cameraId}: ${e}`);
  }
}

async function subscribeCommandTopics(cam: RegisteredCamera): Promise<void> {
  if (!haClient) return;

  const commandableDomains = new Set(["switch", "button", "select"]);
  const topics: string[] = [];

  for (const entity of cam.entities) {
    if (!commandableDomains.has(entity.domain)) continue;
    const { commandTopic } = getMqttTopics({
      entity,
      deviceId: cam.cameraId,
      idPrefix: ID_PREFIX,
    });
    topics.push(commandTopic);
    cam.commandTopics.add(commandTopic);
  }

  if (topics.length === 0) return;

  await haClient.subscribe(topics, async (topic, message) => {
    if (!message) return; // ignore retained reset publishes
    const entity = cam.entities.find((e) => {
      const { commandTopic } = getMqttTopics({
        entity: e,
        deviceId: cam.cameraId,
        idPrefix: ID_PREFIX,
      });
      return commandTopic === topic;
    });
    if (!entity) return;
    await handleCommand(cam, entity.entity, message);
  });
}

async function unsubscribeCommandTopics(cam: RegisteredCamera): Promise<void> {
  if (!haClient || cam.commandTopics.size === 0) return;
  await haClient.unsubscribe(Array.from(cam.commandTopics));
  cam.commandTopics.clear();
}

// ---------------------------------------------------------------------------
// Camera event handling
// ---------------------------------------------------------------------------

/** Map a Reolink event type to a state-topic entity name (or undefined). */
const EVENT_TO_ENTITY: Partial<Record<ReolinkSimpleEvent["type"], string>> = {
  motion: "motion",
  doorbell: "visitor",
  people: "people",
  vehicle: "vehicle",
  animal: "animal",
  face: "face",
  package: "package",
};

function scheduleDetectionReset(
  cam: RegisteredCamera,
  entityName: string,
): void {
  const existing = cam.detectionResetTimers.get(entityName);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    cam.detectionResetTimers.delete(entityName);
    void publishEntityState(cam.cameraId, entityName, PAYLOAD_OFF, false);
  }, DETECTION_RESET_MS);
  cam.detectionResetTimers.set(entityName, timer);
}

function handleSimpleEvent(
  cam: RegisteredCamera,
  event: ReolinkSimpleEvent,
): void {
  // Filter NVR cross-channel events.
  if (event.channel !== undefined && event.channel !== cam.channel) return;

  // [issue-8 debug] trace every event that reaches HA MQTT with its payload
  // so we can verify the AI/battery pipeline after the sleep-inference fix.
  logger.info(
    `[issue-8] handleSimpleEvent ${event.type} cameraId=${cam.cameraId} channel=${event.channel ?? "?"} payload=${JSON.stringify(event).slice(0, 200)}`,
  );

  if (event.type === "sleeping") {
    void publishEntityState(cam.cameraId, "sleeping", PAYLOAD_ON);
    return;
  }
  if (event.type === "awake") {
    void publishEntityState(cam.cameraId, "sleeping", PAYLOAD_OFF);
    return;
  }
  if (event.type === "battery" && event.battery) {
    const { batteryPercent, chargeStatus, adapterStatus } = event.battery;
    if (batteryPercent != null) {
      void publishEntityState(cam.cameraId, "battery", batteryPercent);
    }
    // Charger state: prefer adapterStatus ("charge" | "none" | ...) when present,
    // otherwise fall back to chargeStatus.
    const charging =
      adapterStatus === "charge" ||
      adapterStatus === "charging" ||
      chargeStatus === "chargeComplete" ||
      chargeStatus === "charging";
    void publishEntityState(
      cam.cameraId,
      "charger",
      charging ? PAYLOAD_ON : PAYLOAD_OFF,
    );
    return;
  }

  const entityName = EVENT_TO_ENTITY[event.type];
  if (!entityName) return;
  void publishEntityState(cam.cameraId, entityName, PAYLOAD_ON, false);
  scheduleDetectionReset(cam, entityName);
}

// ---------------------------------------------------------------------------
// Camera registration / cleanup
// ---------------------------------------------------------------------------

async function registerCamera(
  cameraId: string,
  api: ReolinkBaichuanApi,
): Promise<void> {
  if (!isEnabled()) return;
  await ensureClient();
  if (!haClient) return;
  if (!bridgePublished) await publishBridgeDiscovery();

  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  const info = getCameraInfo(cameraId);
  const cameraName = camera?.name ?? info?.name ?? cameraId;
  const channel = camera?.rtspChannel ?? 0;
  const isBattery = camera?.isBattery ?? false;
  const appVersion = readAppVersion() ?? "0.0.0";

  // Tear down any previous registration (e.g. after a reconnect).
  await unregisterCamera(cameraId);

  const { entities } = await buildCameraEntities(api, channel, isBattery);
  const deviceInfo = buildCameraDevice(cameraId, cameraName, appVersion, info);

  const cam: RegisteredCamera = {
    cameraId,
    api,
    channel,
    entities,
    deviceInfo,
    commandTopics: new Set(),
    detectionResetTimers: new Map(),
  };
  cameras.set(cameraId, cam);

  await publishMqttDeviceDiscovery({
    client: haClient,
    deviceInfo,
    entities,
    idPrefix: ID_PREFIX,
    namePrefix: NAME_PREFIX,
    originUrl: ORIGIN_URL,
  });

  await subscribeCommandTopics(cam);
  await seedControlStates(cam);

  const listener = (event: ReolinkSimpleEvent): void => {
    handleSimpleEvent(cam, event);
  };
  cam.eventListener = listener;
  void api.onSimpleEvent(listener);

  logger.info(
    `Registered camera ${cameraName} (${cameraId}) for Home Assistant: ${entities.length} entities`,
  );
}

async function unregisterCamera(cameraId: string): Promise<void> {
  const cam = cameras.get(cameraId);
  if (!cam) return;
  cameras.delete(cameraId);

  for (const t of cam.detectionResetTimers.values()) clearTimeout(t);
  cam.detectionResetTimers.clear();

  if (cam.eventListener) {
    void cam.api.offSimpleEvent(cam.eventListener).catch(() => {});
    delete cam.eventListener;
  }

  await unsubscribeCommandTopics(cam).catch(() => {});

  if (haClient && isEnabled()) {
    // Mark the camera offline rather than deleting the device entirely:
    // HA users may want to keep history, and the camera will rediscover
    // automatically on next connect.
    await publishEntityState(cameraId, "online", PAYLOAD_OFF).catch(() => {});
  }
}

async function handleCameraDisconnected(cameraId: string): Promise<void> {
  const cam = cameras.get(cameraId);
  if (!cam) return;
  // Keep entities/discovery in place but mark offline + tear down event sub.
  for (const t of cam.detectionResetTimers.values()) clearTimeout(t);
  cam.detectionResetTimers.clear();
  if (cam.eventListener) {
    void cam.api.offSimpleEvent(cam.eventListener).catch(() => {});
    delete cam.eventListener;
  }
  await publishEntityState(cameraId, "online", PAYLOAD_OFF).catch(() => {});
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function ensureClient(): Promise<void> {
  if (haClient) return;
  const ctx = getHaContext();
  if (!ctx) return;

  haClient = new HaMqttClient({
    host: ctx.brokerUrl,
    username: ctx.username,
    password: ctx.password,
    clientId: ctx.clientId,
    logger: console,
    configTopicPattern: "homeassistant/device/+/config",
    cache: true,
    cacheTtlMs: 60_000,
  });

  // Force the connection to establish so subsequent publishes don't race.
  try {
    await (haClient as HaMqttClient).getMqttClient();
  } catch (e) {
    logger.error(`HA MQTT client failed to connect: ${e}`);
  }
}

async function rediscoverAll(): Promise<void> {
  bridgePublished = false;
  if (!isEnabled()) return;
  await ensureClient();
  if (!haClient) return;
  await publishBridgeDiscovery();
  for (const cam of cameras.values()) {
    try {
      await publishMqttDeviceDiscovery({
        client: haClient,
        deviceInfo: cam.deviceInfo,
        entities: cam.entities,
        idPrefix: ID_PREFIX,
        namePrefix: NAME_PREFIX,
        originUrl: ORIGIN_URL,
      });
      await seedControlStates(cam);
    } catch (e) {
      logger.error(`Rediscovery failed for ${cam.cameraId}: ${e}`);
    }
  }
}

/**
 * Initialize Home Assistant MQTT discovery integration. Safe to call
 * once at startup; further calls re-trigger discovery.
 */
export function initHomeAssistantMqtt(): void {
  onApiConnected((cameraId, api) => {
    void registerCamera(cameraId, api).catch((e) =>
      logger.error(`registerCamera(${cameraId}) failed: ${e}`),
    );
  });
  onApiDisconnected((cameraId) => {
    void handleCameraDisconnected(cameraId).catch((e) =>
      logger.error(`handleCameraDisconnected(${cameraId}) failed: ${e}`),
    );
  });
  logger.info("Home Assistant MQTT integration initialized");
}

/**
 * Called by the settings router when HA-related settings change.
 * Reconnects the client if needed and re-publishes discovery.
 */
export function updateHomeAssistantPolling(): void {
  if (!isEnabled()) {
    void shutdown();
    return;
  }
  void rediscoverAll();
}

async function shutdown(): Promise<void> {
  for (const cameraId of Array.from(cameras.keys())) {
    const cam = cameras.get(cameraId);
    if (!cam) continue;
    if (haClient) {
      // Publish offline + clear discovery so HA hides the device cleanly.
      await publishEntityState(cameraId, "online", PAYLOAD_OFF).catch(() => {});
      await clearMqttDevice({
        client: haClient,
        deviceInfo: cam.deviceInfo,
        entities: cam.entities,
        idPrefix: ID_PREFIX,
      }).catch(() => {});
    }
    cameras.delete(cameraId);
  }
  if (haClient) {
    try {
      await haClient.disconnect();
    } catch {
      // ignore
    }
    haClient = undefined;
    bridgePublished = false;
  }
}
