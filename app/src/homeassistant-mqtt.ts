/**
 * Home Assistant MQTT integration: forwards camera device state to MQTT
 * for Home Assistant discovery, state updates, and control entities.
 */

import type { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js";
import { getMqttClient, setOnMqttConnected } from "./events-manager.js";
import {
  onApiConnected,
  onApiDisconnected,
  getCameraInfo,
  sanitizeCameraName,
} from "./rtsp-manager.js";
import { getConfig, getSettings } from "./settings-store.js";
import { readAppVersion } from "./app-version.js";
import { createSourceLogger } from "./logger.js";

const logger = createSourceLogger("homeassistant-mqtt");

const BRIDGE_DEVICE_ID = "nodelink_manager";

/** Cameras to poll: cameraId -> api */
const camerasToPoll = new Map<string, ReolinkBaichuanApi>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let mqttSubscribeSetup = false;
let mqttMessageHandlerSetup = false;

interface CameraDeviceState {
  cameraId: string;
  cameraName: string;
  cameraNameSlug: string;
  channel: number;
  timestamp: number;
  info?: Record<string, unknown>;
  batteryInfo?: Record<string, unknown>;
  motionAlarm?: Record<string, unknown>;
  aiState?: Record<string, unknown>;
  whiteLedState?: Record<string, unknown>;
  siren?: Record<string, unknown>;
  ledState?: Record<string, unknown>;
  sleepState?: Record<string, unknown>;
  wifiSignal?: Record<string, unknown>;
  wifi?: Record<string, unknown>;
  networkInfo?: Record<string, unknown>;
  recordCfg?: Record<string, unknown>;
  recordSchedule?: Record<string, unknown>;
  systemGeneral?: Record<string, unknown>;
  pirInfo?: Record<string, unknown>;
  ptzPosition?: Record<string, unknown>;
  zoomFocus?: Record<string, unknown>;
  channelCount?: number;
  channelInfo?: Record<string, unknown>[];
  ptzPresets?: Array<{ id: number; name: string }>;
  error?: string;
}

function getCameraUniqueId(cameraId: string): string {
  return `nodelink_${cameraId.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

async function fetchCameraState(
  cameraId: string,
  api: ReolinkBaichuanApi,
  channel: number,
): Promise<CameraDeviceState> {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  const info = getCameraInfo(cameraId);
  const cameraName = camera?.name ?? info?.name ?? cameraId;
  const cameraNameSlug = sanitizeCameraName(cameraName);

  const state: CameraDeviceState = {
    cameraId,
    cameraName,
    cameraNameSlug,
    channel,
    timestamp: Date.now(),
  };

  const safeCall = async <T>(
    fn: () => Promise<T>,
    key: keyof CameraDeviceState,
  ): Promise<void> => {
    try {
      const result = await fn();
      (state as Record<string, unknown>)[key] =
        result && typeof result === "object"
          ? (result as Record<string, unknown>)
          : result;
    } catch {
      // Omit failed calls
    }
  };

  await safeCall(() => api.getInfo(channel), "info");
  await safeCall(() => api.getChannelCount(), "channelCount");
  await safeCall(() => api.getBatteryInfo(channel), "batteryInfo");
  await safeCall(() => api.getMotionAlarm(channel), "motionAlarm");
  await safeCall(() => api.getAiState(channel), "aiState");
  await safeCall(() => api.getWhiteLedState(channel), "whiteLedState");
  await safeCall(() => api.getSiren(channel), "siren");
  await safeCall(() => api.getLedState(channel), "ledState");
  await safeCall(() => api.getSleepState(channel), "sleepState");
  await safeCall(() => api.getWifiSignal(channel), "wifiSignal");
  await safeCall(() => api.getWifi(channel), "wifi");
  await safeCall(() => api.getNetworkInfo(), "networkInfo");
  await safeCall(() => api.getRecordCfg(channel), "recordCfg");
  await safeCall(() => api.getRecordSchedule(channel), "recordSchedule");
  await safeCall(() => api.getSystemGeneral(), "systemGeneral");
  await safeCall(() => api.getPirInfo(channel), "pirInfo");
  await safeCall(() => api.getPtzPosition(channel), "ptzPosition");
  await safeCall(() => api.getZoomFocus(channel), "zoomFocus");
  await safeCall(() => api.getPtzPresets(channel), "ptzPresets");

  try {
    const channelCount = await api.getChannelCount();
    if (channelCount > 1) {
      const infos: Record<string, unknown>[] = [];
      for (let ch = 0; ch < channelCount; ch++) {
        try {
          const chInfo = await api.getChannelInfo(ch);
          infos.push(chInfo as Record<string, unknown>);
        } catch {
          // skip
        }
      }
      state.channelInfo = infos;
    }
  } catch {
    // skip
  }

  return state;
}

/** Publish bridge device first so via_device references an existing device */
function publishBridgeDiscovery(): void {
  const client = getMqttClient();
  if (!client?.connected) return;

  const settings = getSettings();
  const ha = settings.homeassistant;
  const mqtt = settings.mqtt;
  if (!ha?.enabled || !mqtt?.enabled) return;

  const prefix = ha.discoveryPrefix;
  const statePrefix = ha.stateTopicPrefix ?? mqtt.topicPrefix ?? "nodelink-js";
  const appVersion = readAppVersion() ?? "0.0.0";

  const config = {
    name: "Nodelink Manager",
    unique_id: BRIDGE_DEVICE_ID,
    state_topic: `${statePrefix}/bridge/status`,
    value_template: "{{ value_json.status }}",
    device: {
      identifiers: [BRIDGE_DEVICE_ID],
      name: "Nodelink Manager",
      manufacturer: "Nodelink.js",
      model: "Manager",
      sw_version: appVersion,
    },
    origin: {
      name: "nodelink-js",
      sw: appVersion,
      url: "https://github.com/apocaliss92/nodelink-js",
    },
  };

  client.publish(
    `${prefix}/sensor/${BRIDGE_DEVICE_ID}/config`,
    JSON.stringify(config),
    { qos: mqtt.qos ?? 0, retain: true },
  );

  client.publish(
    `${statePrefix}/bridge/status`,
    JSON.stringify({ status: "online", cameras: camerasToPoll.size }),
    { qos: mqtt.qos ?? 0, retain: true },
  );
  logger.debug("Published bridge discovery");
}

function publishCameraDiscovery(
  cameraId: string,
  cameraNameSlug: string,
  state: CameraDeviceState,
): void {
  const client = getMqttClient();
  if (!client?.connected) return;

  const settings = getSettings();
  const ha = settings.homeassistant;
  const mqtt = settings.mqtt;
  if (!ha?.enabled || !mqtt?.enabled) return;

  const prefix = ha.discoveryPrefix;
  const statePrefix = ha.stateTopicPrefix ?? mqtt.topicPrefix ?? "nodelink-js";
  const cmdPrefix = `${statePrefix}/camera/${cameraNameSlug}/cmd`;
  const uniqueId = getCameraUniqueId(cameraId);
  const stateTopic = `${statePrefix}/camera/${cameraNameSlug}/state`;
  const appVersion = readAppVersion() ?? "0.0.0";

  const device = {
    identifiers: [`nodelink_cam_${cameraId.replace(/[^a-zA-Z0-9]/g, "_")}`],
    name: `Reolink ${cameraNameSlug}`,
    manufacturer: "Nodelink.js",
    model: "Camera",
    sw_version: appVersion,
    via_device: BRIDGE_DEVICE_ID,
  };

  // 1. Online sensor
  client.publish(
    `${prefix}/sensor/${uniqueId}/config`,
    JSON.stringify({
      name: `${cameraNameSlug} status`,
      unique_id: `${uniqueId}_status`,
      state_topic: stateTopic,
      value_template: "{{ 'online' if value_json else 'offline' }}",
      device,
      json_attributes_topic: stateTopic,
      json_attributes_template: "{{ value_json | tojson }}",
    }),
    { qos: mqtt.qos ?? 0, retain: true },
  );

  // 2. Spotlight switch (if whiteLedState available)
  if (state.whiteLedState !== undefined) {
    const cmdTopic = `${cmdPrefix}/spotlight`;
    const switchId = `${uniqueId}_spotlight`;
    client.publish(
      `${prefix}/switch/${switchId}/config`,
      JSON.stringify({
        name: `${cameraNameSlug} spotlight`,
        unique_id: switchId,
        state_topic: stateTopic,
        state_template: "{{ 'ON' if value_json.whiteLedState.enabled else 'OFF' }}",
        command_topic: cmdTopic,
        payload_on: "ON",
        payload_off: "OFF",
        device,
      }),
      { qos: mqtt.qos ?? 0, retain: true },
    );
  }

  // 3. Siren switch (if siren available)
  if (state.siren !== undefined) {
    const cmdTopic = `${cmdPrefix}/siren`;
    const switchId = `${uniqueId}_siren`;
    client.publish(
      `${prefix}/switch/${switchId}/config`,
      JSON.stringify({
        name: `${cameraNameSlug} siren`,
        unique_id: switchId,
        state_topic: stateTopic,
        state_template: "{{ 'ON' if value_json.siren.enabled else 'OFF' }}",
        command_topic: cmdTopic,
        payload_on: "ON",
        payload_off: "OFF",
        device,
      }),
      { qos: mqtt.qos ?? 0, retain: true },
    );
  }

  // 4. PTZ preset select (if ptzPresets available)
  if (
    state.ptzPresets &&
    Array.isArray(state.ptzPresets) &&
    state.ptzPresets.length > 0
  ) {
    const cmdTopic = `${cmdPrefix}/ptz_preset`;
    const selectId = `${uniqueId}_ptz_preset`;
    const options = state.ptzPresets.map((p) => String(p.id));
    client.publish(
      `${prefix}/select/${selectId}/config`,
      JSON.stringify({
        name: `${cameraNameSlug} PTZ preset`,
        unique_id: selectId,
        state_topic: stateTopic,
        state_template: "{{ value_json.ptzPosition.preset | default('') }}",
        command_topic: cmdTopic,
        options,
        device,
      }),
      { qos: mqtt.qos ?? 0, retain: true },
    );
  }

  logger.debug(`Published HA discovery for ${cameraNameSlug}`);
}

function removeCameraDiscovery(cameraId: string, cameraNameSlug: string): void {
  const client = getMqttClient();
  if (!client?.connected) return;

  const settings = getSettings();
  const ha = settings.homeassistant;
  if (!ha?.enabled) return;

  const prefix = ha.discoveryPrefix;
  const uniqueId = getCameraUniqueId(cameraId);

  const entities = [
    `${prefix}/sensor/${uniqueId}/config`,
    `${prefix}/switch/${uniqueId}_spotlight/config`,
    `${prefix}/switch/${uniqueId}_siren/config`,
    `${prefix}/select/${uniqueId}_ptz_preset/config`,
  ];
  for (const topic of entities) {
    client.publish(topic, "", { qos: 0, retain: true });
  }
  logger.debug(`Removed HA discovery for ${cameraId}`);
}

async function handleCommand(
  cameraId: string,
  command: string,
  payload: string,
): Promise<void> {
  const api = camerasToPoll.get(cameraId);
  if (!api) return;

  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  const channel = camera?.rtspChannel ?? 0;

  try {
    if (command === "spotlight") {
      await api.setWhiteLedState(channel, payload === "ON");
    } else if (command === "siren") {
      await api.setSiren(channel, payload === "ON");
    } else if (command === "ptz_preset") {
      const presetId = parseInt(payload, 10);
      if (!Number.isNaN(presetId)) {
        await api.moveToPtzPreset(channel, presetId);
      }
    }
  } catch (e) {
    logger.error(`Command ${command} failed for ${cameraId}: ${e}`);
  }
}

function setupMqttSubscriptions(): void {
  const client = getMqttClient();
  if (!client?.connected || mqttSubscribeSetup) return;

  const settings = getSettings();
  const ha = settings.homeassistant;
  const mqtt = settings.mqtt;
  if (!ha?.enabled || !mqtt?.enabled) return;

  const statePrefix = ha.stateTopicPrefix ?? mqtt.topicPrefix ?? "nodelink-js";
  const topic = `${statePrefix}/camera/+/cmd/#`;
  client.subscribe(topic, (err) => {
    if (err) {
      logger.error(`MQTT subscribe failed: ${err}`);
      return;
    }
    mqttSubscribeSetup = true;
    logger.debug(`Subscribed to ${topic}`);
  });

  if (!mqttMessageHandlerSetup) {
    mqttMessageHandlerSetup = true;
    client.on("message", (topic, payload) => {
      const prefix = settings.homeassistant?.stateTopicPrefix ??
        settings.mqtt?.topicPrefix ?? "nodelink-js";
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = topic.match(
        new RegExp(`^${escaped}/camera/([^/]+)/cmd/([^/]+)$`),
      );
      if (!match) return;
      const [, cameraNameSlug, command] = match;
      const payloadStr = payload.toString();
      const cfg = getConfig();
      const camera = cfg.cameras.find(
        (c) =>
          sanitizeCameraName(c.name) === cameraNameSlug ||
          c.id === cameraNameSlug,
      );
      if (camera) {
        void handleCommand(camera.id, command, payloadStr);
      }
    });
  }
}

async function pollAllCameras(): Promise<void> {
  const client = getMqttClient();
  if (!client?.connected) return;

  const settings = getSettings();
  const ha = settings.homeassistant;
  const mqtt = settings.mqtt;
  if (!ha?.enabled || !mqtt?.enabled) return;

  const statePrefix = ha.stateTopicPrefix ?? mqtt.topicPrefix ?? "nodelink-js";

  for (const [cameraId, api] of camerasToPoll) {
    try {
      const config = getConfig();
      const camera = config.cameras.find((c) => c.id === cameraId);
      const channel = camera?.rtspChannel ?? 0;

      const state = await fetchCameraState(cameraId, api, channel);
      const topic = `${statePrefix}/camera/${state.cameraNameSlug}/state`;
      client.publish(topic, JSON.stringify(state), {
        qos: mqtt.qos ?? 0,
        retain: true,
      });
    } catch (e) {
      logger.error(`Failed to poll camera ${cameraId}: ${e}`);
    }
  }

  client.publish(
    `${statePrefix}/bridge/status`,
    JSON.stringify({ status: "online", cameras: camerasToPoll.size }),
    { qos: mqtt.qos ?? 0, retain: true },
  );
}

function startPolling(): void {
  if (pollTimer) return;

  const settings = getSettings();
  const ha = settings.homeassistant;
  if (!ha?.enabled) return;

  const intervalMs = (ha.pollIntervalSeconds ?? 60) * 1000;
  pollTimer = setInterval(() => void pollAllCameras(), intervalMs);
  logger.info(
    `Home Assistant polling started (interval: ${ha.pollIntervalSeconds}s)`,
  );
  void pollAllCameras();
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info("Home Assistant polling stopped");
  }
}

async function registerCamera(cameraId: string, api: ReolinkBaichuanApi): Promise<void> {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  const info = getCameraInfo(cameraId);
  const cameraName = camera?.name ?? info?.name ?? cameraId;
  const cameraNameSlug = sanitizeCameraName(cameraName);

  camerasToPoll.set(cameraId, api);
  publishBridgeDiscovery();
  setupMqttSubscriptions();

  try {
    const channel = camera?.rtspChannel ?? 0;
    const state = await fetchCameraState(cameraId, api, channel);
    publishCameraDiscovery(cameraId, cameraNameSlug, state);
  } catch (e) {
    logger.error(`Failed to fetch state for discovery ${cameraId}: ${e}`);
    publishCameraDiscovery(cameraId, cameraNameSlug, {
      cameraId,
      cameraName: cameraName,
      cameraNameSlug,
      channel: camera?.rtspChannel ?? 0,
      timestamp: Date.now(),
    });
  }
  logger.info(`Registered camera ${cameraName} for Home Assistant`);
}

function unregisterCamera(cameraId: string): void {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  const info = getCameraInfo(cameraId);
  const cameraNameSlug = sanitizeCameraName(
    camera?.name ?? info?.name ?? cameraId,
  );

  camerasToPoll.delete(cameraId);
  removeCameraDiscovery(cameraId, cameraNameSlug);
  logger.debug(`Unregistered camera ${cameraId} from Home Assistant`);
}

function republishAllDiscovery(): void {
  mqttSubscribeSetup = false;
  publishBridgeDiscovery();
  setupMqttSubscriptions();

  for (const [cameraId, api] of camerasToPoll) {
    const config = getConfig();
    const camera = config.cameras.find((c) => c.id === cameraId);
    const info = getCameraInfo(cameraId);
    const cameraNameSlug = sanitizeCameraName(
      camera?.name ?? info?.name ?? cameraId,
    );
    void fetchCameraState(cameraId, api, camera?.rtspChannel ?? 0).then(
      (state) => publishCameraDiscovery(cameraId, cameraNameSlug, state),
      () =>
        publishCameraDiscovery(cameraId, cameraNameSlug, {
          cameraId,
          cameraName: camera?.name ?? info?.name ?? cameraId,
          cameraNameSlug,
          channel: camera?.rtspChannel ?? 0,
          timestamp: Date.now(),
        }),
    );
  }
}

export function initHomeAssistantMqtt(): void {
  onApiConnected(registerCamera);
  onApiDisconnected(unregisterCamera);
  setOnMqttConnected(republishAllDiscovery);

  const settings = getSettings();
  if (settings.homeassistant?.enabled) {
    startPolling();
  }
  logger.info("Home Assistant MQTT integration initialized");
}

export function updateHomeAssistantPolling(): void {
  const settings = getSettings();
  if (settings.homeassistant?.enabled) {
    stopPolling();
    startPolling();
  } else {
    stopPolling();
  }
}
