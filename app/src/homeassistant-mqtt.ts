/**
 * Home Assistant MQTT integration: forwards camera device state to MQTT
 * for Home Assistant discovery and regular state updates.
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

/** Cameras to poll: cameraId -> api */
const camerasToPoll = new Map<string, ReolinkBaichuanApi>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

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
  error?: string;
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
    } catch (e) {
      // Omit failed calls; state will lack that key
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

function publishDiscovery(cameraId: string, cameraNameSlug: string): void {
  const client = getMqttClient();
  if (!client?.connected) return;

  const settings = getSettings();
  const ha = settings.homeassistant;
  const mqtt = settings.mqtt;
  if (!ha?.enabled || !mqtt?.enabled) return;

  const prefix = ha.discoveryPrefix;
  const statePrefix = ha.stateTopicPrefix ?? mqtt.topicPrefix ?? "nodelink-js";
  const uniqueId = `nodelink_${cameraId.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const stateTopic = `${statePrefix}/camera/${cameraNameSlug}/state`;

  const appVersion = readAppVersion() ?? "0.0.0";

  const config: Record<string, unknown> = {
    name: `Reolink ${cameraNameSlug}`,
    unique_id: uniqueId,
    state_topic: stateTopic,
    value_template: "{{ 'online' if value_json else 'offline' }}",
    device: {
      identifiers: [cameraId],
      name: `Reolink ${cameraNameSlug}`,
      manufacturer: "Nodelink.js",
      model: "Camera",
      sw_version: appVersion,
      via_device: "nodelink-manager",
    },
    origin: {
      name: "nodelink-js",
      sw: appVersion,
      url: "https://github.com/apocaliss92/nodelink-js",
    },
    json_attributes_topic: stateTopic,
    json_attributes_template: "{{ value_json | tojson }}",
  };

  const topic = `${prefix}/sensor/${uniqueId}/config`;
  client.publish(
    topic,
    JSON.stringify(config),
    { qos: mqtt.qos ?? 0, retain: true },
  );
  logger.debug(`Published HA discovery for ${cameraNameSlug}`);
}

function removeDiscovery(cameraId: string): void {
  const client = getMqttClient();
  if (!client?.connected) return;

  const settings = getSettings();
  const ha = settings.homeassistant;
  if (!ha?.enabled) return;

  const prefix = ha.discoveryPrefix;
  const uniqueId = `nodelink_${cameraId.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const topic = `${prefix}/sensor/${uniqueId}/config`;
  client.publish(topic, "", { qos: 0, retain: true });
  logger.debug(`Removed HA discovery for ${cameraId}`);
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

function registerCamera(cameraId: string, api: ReolinkBaichuanApi): void {
  const config = getConfig();
  const camera = config.cameras.find((c) => c.id === cameraId);
  const info = getCameraInfo(cameraId);
  const cameraName = camera?.name ?? info?.name ?? cameraId;
  const cameraNameSlug = sanitizeCameraName(cameraName);

  camerasToPoll.set(cameraId, api);
  publishDiscovery(cameraId, cameraNameSlug);
  logger.info(`Registered camera ${cameraName} for Home Assistant`);
}

function unregisterCamera(cameraId: string): void {
  camerasToPoll.delete(cameraId);
  removeDiscovery(cameraId);
  logger.debug(`Unregistered camera ${cameraId} from Home Assistant`);
}

/** Re-publish discovery for all registered cameras (e.g. after MQTT reconnect) */
function republishAllDiscovery(): void {
  for (const [cameraId] of camerasToPoll) {
    const config = getConfig();
    const camera = config.cameras.find((c) => c.id === cameraId);
    const info = getCameraInfo(cameraId);
    const cameraName = camera?.name ?? info?.name ?? cameraId;
    const cameraNameSlug = sanitizeCameraName(cameraName);
    publishDiscovery(cameraId, cameraNameSlug);
  }
}

/**
 * Initialize Home Assistant MQTT integration.
 */
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

/**
 * Start or stop Home Assistant polling based on settings.
 */
export function updateHomeAssistantPolling(): void {
  const settings = getSettings();
  if (settings.homeassistant?.enabled) {
    stopPolling();
    startPolling();
  } else {
    stopPolling();
  }
}
