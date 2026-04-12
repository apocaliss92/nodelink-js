/**
 * Home Assistant MQTT integration: forwards camera device state to MQTT
 * for Home Assistant discovery, state updates, and control entities.
 * Uses getDeviceCapabilities to determine which entities to expose.
 */

import type {
  ReolinkBaichuanApi,
  DeviceCapabilities,
  DeviceCapabilitiesResult,
} from "@apocaliss92/nodelink-js";
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
  capabilities?: DeviceCapabilities;
  info?: Record<string, unknown>;
  batteryInfo?: Record<string, unknown>;
  motionAlarm?: Record<string, unknown>;
  aiState?: Record<string, unknown>;
  /** Per-type AI detection state: { people: { enabled: 1 }, vehicle: { enabled: 0 }, ... } */
  aiStatePerType?: Record<string, { enabled: number }>;
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
  currentPresetName?: string;
  /** AudioTask: body.AudioTask.enable (0/1) */
  sirenOnMotion?: Record<string, unknown>;
  floodlightOnMotion?: { floodlightOnMotion: boolean; enabled?: boolean };
  autotracking?: {
    enabled: boolean;
    smartTrackType?: string;
    smartTrackObjectStopDelay?: number;
    smartTrackObjectDisappearDelay?: number;
  };
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
      const stateRecord = state as unknown as Record<string, unknown>;
      stateRecord[key as string] =
        result && typeof result === "object"
          ? (result as Record<string, unknown>)
          : result;
    } catch {
      // Omit failed calls
    }
  };

  // Get device capabilities first to guide which APIs to call
  let capsResult: DeviceCapabilitiesResult | undefined;
  try {
    capsResult = await api.getDeviceCapabilities(channel);
    state.capabilities = capsResult.capabilities;
  } catch {
    // Continue without capabilities - will expose entities based on data availability
  }

  await safeCall(() => api.getInfo(channel), "info");
  await safeCall(() => api.getChannelCount(), "channelCount");
  await safeCall(async () => {
    const raw = await api.getBatteryInfo(channel);
    if (!raw || typeof raw !== "object") return raw;
    // Strip large binary fields (valueTable is a 96×64 base64 grid, body is raw frame data)
    // that cause Home Assistant "Value error while updating state" when serialized.
    const { valueTable: _vt, body: _body, ...sanitized } = raw as Record<string, unknown>;
    return sanitized;
  }, "batteryInfo");
  await safeCall(async () => {
    const raw = await api.getMotionAlarm(channel);
    // Strip the 96×64 base64 sensitivity grid — large binary, not useful in HA.
    const scope = (raw as any)?.body?.MD?.scope;
    if (scope && typeof scope === "object" && "valueTable" in scope) {
      const { valueTable: _vt, ...scopeWithout } = scope as Record<string, unknown>;
      (raw as any).body.MD.scope = scopeWithout;
    }
    return raw;
  }, "motionAlarm");
  await safeCall(() => api.getAiState(channel), "aiState");

  // Fetch AI state per detection type (people, vehicle, dog_cat, face, package)
  try {
    const aiTypes =
      capsResult?.objects ??
      (await api.getAiDetectTypes(channel, { timeoutMs: 1500 })) ??
      ["people", "vehicle", "dog_cat", "face", "package"];
    const aiStatePerType: Record<string, { enabled: number }> = {};
    for (const type of aiTypes) {
      try {
        const raw = await api.getAiAlarmRaw(channel, type, { timeoutMs: 2000 });
        const enabled = raw?.body?.AiAlarm?.enabled;
        if (enabled !== undefined) {
          aiStatePerType[type] = { enabled: Number(enabled) };
        }
      } catch {
        // Skip unsupported types
      }
    }
    if (Object.keys(aiStatePerType).length > 0) {
      state.aiStatePerType = aiStatePerType;
    }
  } catch {
    // Omit if all fail
  }

  await safeCall(() => api.getWhiteLedState(channel), "whiteLedState");
  await safeCall(() => api.getSiren(channel), "siren");
  await safeCall(() => api.getLedState(channel), "ledState");
  await safeCall(() => api.getSleepState(channel), "sleepState");
  await safeCall(() => api.getWifiSignal(channel), "wifiSignal");
  await safeCall(() => api.getWifi(channel), "wifi");
  await safeCall(() => api.getNetworkInfo(), "networkInfo");
  await safeCall(() => api.getRecordCfg(channel), "recordCfg");
  await safeCall(async () => {
    const raw = await api.getRecordSchedule(channel);
    // Strip valueTable (base64 schedule grid) from each schedule type entry.
    if (Array.isArray(raw?.typeScheduleList)) {
      return {
        ...raw,
        typeScheduleList: raw.typeScheduleList.map(({ valueTable: _vt, ...rest }) => rest),
      };
    }
    return raw;
  }, "recordSchedule");
  await safeCall(() => api.getSystemGeneral(), "systemGeneral");
  await safeCall(() => api.getPirInfo(channel), "pirInfo");
  await safeCall(() => api.getPtzPosition(channel), "ptzPosition");
  await safeCall(() => api.getZoomFocus(channel), "zoomFocus");
  await safeCall(() => api.getPtzPresets(channel), "ptzPresets");

  // Siren on motion (when hasSiren)
  if (state.capabilities?.hasSiren) {
    await safeCall(async () => {
      const raw = await api.getSirenOnMotion(channel);
      // Strip valueTable (base64 schedule grids) from AudioTask schedule items.
      const items = raw?.body?.AudioTask?.typeScheduleList?.item;
      if (Array.isArray(items)) {
        (raw as any).body.AudioTask.typeScheduleList.item = items.map(
          ({ valueTable: _vt, ...rest }: Record<string, unknown>) => rest,
        );
      }
      return raw;
    }, "sirenOnMotion");
  }
  // Floodlight on motion (when hasFloodlight)
  if (state.capabilities?.hasFloodlight) {
    await safeCall(() => api.getFloodlightOnMotion(channel), "floodlightOnMotion");
  }
  // Autotracking (when hasAutotracking)
  if (state.capabilities?.hasAutotracking) {
    try {
      const at = await api.getAutotracking(channel, { timeoutMs: 2000 });
      const raw = (at as unknown as { raw?: Record<string, unknown> }).raw;
      const body = raw?.body as Record<string, unknown> | undefined;
      const cfg =
        body?.AiCfg ?? (raw as Record<string, unknown>)?.AiCfg ?? {};
      const cfgObj = cfg as Record<string, unknown>;
      state.autotracking = {
        enabled: at.enabled,
        smartTrackType: (at.smartTrackType ?? cfgObj.smartTrackType) as
          | string
          | undefined,
        smartTrackObjectStopDelay:
          cfgObj.smartTrackObjectStopDelay != null
            ? Number(cfgObj.smartTrackObjectStopDelay)
            : undefined,
        smartTrackObjectDisappearDelay:
          cfgObj.smartTrackObjectDisappearDelay != null
            ? Number(cfgObj.smartTrackObjectDisappearDelay)
            : undefined,
      };
    } catch {
      // Omit if unsupported
    }
  }

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

  // Compute current preset name for PTZ select state
  if (
    state.ptzPresets?.length &&
    state.ptzPosition &&
    (state.ptzPosition as Record<string, unknown>).preset !== undefined
  ) {
    const presetId = (state.ptzPosition as Record<string, unknown>).preset;
    const preset = state.ptzPresets.find(
      (p) => p.id === presetId || String(p.id) === String(presetId),
    );
    state.currentPresetName = preset?.name ?? "";
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
    icon: "mdi:server",
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
  const caps = state.capabilities;

  const device = {
    identifiers: [`nodelink_cam_${cameraId.replace(/[^a-zA-Z0-9]/g, "_")}`],
    name: `Reolink ${cameraNameSlug}`,
    manufacturer: "Nodelink.js",
    model: "Camera",
    sw_version: appVersion,
    via_device: BRIDGE_DEVICE_ID,
  };

  const publish = (entityType: string, entityId: string, config: object) => {
    client.publish(
      `${prefix}/${entityType}/${entityId}/config`,
      JSON.stringify(config),
      { qos: mqtt.qos ?? 0, retain: true },
    );
  };

  // 1. Online sensor (always)
  publish(
    "sensor",
    `${uniqueId}_status`,
    {
      name: "Status",
      object_id: "status",
      unique_id: `${uniqueId}_status`,
      icon: "mdi:connection",
      state_topic: stateTopic,
      value_template: "{{ 'online' if value_json else 'offline' }}",
      device,
      json_attributes_topic: stateTopic,
      json_attributes_template: "{{ value_json | tojson }}",
    },
  );

  // 2. Spotlight switch (when hasFloodlight capability or whiteLedState data)
  const showSpotlight =
    (caps?.hasFloodlight ?? false) || state.whiteLedState !== undefined;
  if (showSpotlight && state.whiteLedState !== undefined) {
    publish(
      "switch",
      `${uniqueId}_spotlight`,
      {
        name: "Spotlight",
        object_id: "spotlight",
        unique_id: `${uniqueId}_spotlight`,
        icon: "mdi:light-flood-down",
        state_topic: stateTopic,
        state_template:
          "{{ 'ON' if value_json.whiteLedState and value_json.whiteLedState.enabled else 'OFF' }}",
        command_topic: `${cmdPrefix}/spotlight`,
        payload_on: "ON",
        payload_off: "OFF",
        device,
      },
    );
  }

  // 3. Siren switch (when hasSiren capability or siren data)
  const showSiren =
    (caps?.hasSiren ?? false) || state.siren !== undefined;
  if (showSiren && state.siren !== undefined) {
    publish(
      "switch",
      `${uniqueId}_siren`,
      {
        name: "Siren",
        object_id: "siren",
        unique_id: `${uniqueId}_siren`,
        icon: "mdi:alarm-light",
        state_topic: stateTopic,
        state_template:
          "{{ 'ON' if value_json.siren and value_json.siren.enabled else 'OFF' }}",
        command_topic: `${cmdPrefix}/siren`,
        payload_on: "ON",
        payload_off: "OFF",
        device,
      },
    );
  }

  // 3b. Siren on motion switch (when hasSiren and sirenOnMotion data)
  const showSirenOnMotion =
    (caps?.hasSiren ?? false) && state.sirenOnMotion !== undefined;
  if (showSirenOnMotion) {
    publish(
      "switch",
      `${uniqueId}_siren_on_motion`,
      {
        name: "Siren on motion",
        object_id: "siren_on_motion",
        unique_id: `${uniqueId}_siren_on_motion`,
        icon: "mdi:alarm-light-outline",
        state_topic: stateTopic,
        state_template:
          "{{ 'ON' if (value_json.sirenOnMotion or {}).get('body', {}).get('AudioTask', {}).get('enable', 0) == 1 else 'OFF' }}",
        command_topic: `${cmdPrefix}/siren_on_motion`,
        payload_on: "ON",
        payload_off: "OFF",
        device,
      },
    );
  }

  // 3c. Light on motion switch (when hasFloodlight and floodlightOnMotion data)
  const showLightOnMotion =
    (caps?.hasFloodlight ?? false) && state.floodlightOnMotion !== undefined;
  if (showLightOnMotion) {
    publish(
      "switch",
      `${uniqueId}_light_on_motion`,
      {
        name: "Light on motion",
        object_id: "light_on_motion",
        unique_id: `${uniqueId}_light_on_motion`,
        icon: "mdi:light-flood-down",
        state_topic: stateTopic,
        state_template:
          "{{ 'ON' if value_json.floodlightOnMotion and value_json.floodlightOnMotion.floodlightOnMotion else 'OFF' }}",
        command_topic: `${cmdPrefix}/light_on_motion`,
        payload_on: "ON",
        payload_off: "OFF",
        device,
      },
    );
  }

  // 3d. Autotracking switch (when hasAutotracking and autotracking data)
  const showAutotracking =
    (caps?.hasAutotracking ?? false) && state.autotracking !== undefined;
  if (showAutotracking) {
    publish(
      "switch",
      `${uniqueId}_autotracking`,
      {
        name: "Autotracking",
        object_id: "autotracking",
        unique_id: `${uniqueId}_autotracking`,
        icon: "mdi:radar",
        state_topic: stateTopic,
        state_template:
          "{{ 'ON' if value_json.autotracking and value_json.autotracking.enabled else 'OFF' }}",
        command_topic: `${cmdPrefix}/autotracking`,
        payload_on: "ON",
        payload_off: "OFF",
        device,
      },
    );
  }

  // 3e. Autotracking config: sensor for type, number entities for delays
  if (showAutotracking && state.autotracking) {
    if (
      state.autotracking.smartTrackType !== undefined &&
      state.autotracking.smartTrackType !== ""
    ) {
      publish(
        "sensor",
        `${uniqueId}_autotracking_type`,
        {
          name: "Autotracking type",
          object_id: "autotracking_type",
          unique_id: `${uniqueId}_autotracking_type`,
          icon: "mdi:target",
          state_topic: stateTopic,
          value_template:
            "{{ value_json.autotracking.smartTrackType | default('') }}",
          device,
        },
      );
    }
    // Stop delay: show when we have autotracking (use default 20 if not in response)
    publish(
      "number",
      `${uniqueId}_autotracking_stop_delay`,
      {
        name: "Autotracking stop delay",
        object_id: "autotracking_stop_delay",
        unique_id: `${uniqueId}_autotracking_stop_delay`,
        icon: "mdi:timer-sand",
        state_topic: stateTopic,
        value_template:
          "{{ value_json.autotracking.smartTrackObjectStopDelay | default(20) }}",
        command_topic: `${cmdPrefix}/autotracking_stop_delay`,
        unit_of_measurement: "s",
        min: 0,
        max: 120,
        step: 1,
        device,
      },
    );
    // Disappear delay: show when we have autotracking (use default 10 if not in response)
    publish(
      "number",
      `${uniqueId}_autotracking_disappear_delay`,
      {
        name: "Autotracking disappear delay",
        object_id: "autotracking_disappear_delay",
        unique_id: `${uniqueId}_autotracking_disappear_delay`,
        icon: "mdi:timer-sand-empty",
        state_topic: stateTopic,
        value_template:
          "{{ value_json.autotracking.smartTrackObjectDisappearDelay | default(10) }}",
        command_topic: `${cmdPrefix}/autotracking_disappear_delay`,
        unit_of_measurement: "s",
        min: 0,
        max: 60,
        step: 1,
        device,
      },
    );
  }

  // 4. PTZ preset select (preset names in options)
  if (
    state.ptzPresets &&
    Array.isArray(state.ptzPresets) &&
    state.ptzPresets.length > 0
  ) {
    const options = state.ptzPresets.map((p) => p.name);
    publish(
      "select",
      `${uniqueId}_ptz_preset`,
      {
        name: "PTZ preset",
        object_id: "ptz_preset",
        unique_id: `${uniqueId}_ptz_preset`,
        icon: "mdi:view-dashboard",
        state_topic: stateTopic,
        state_template:
          "{{ value_json.currentPresetName | default('') }}",
        command_topic: `${cmdPrefix}/ptz_preset`,
        options,
        device,
      },
    );
  }

  // 5. Battery sensor (when hasBattery or batteryInfo)
  const showBattery =
    (caps?.hasBattery ?? false) || state.batteryInfo !== undefined;
  if (showBattery && state.batteryInfo !== undefined) {
    const bat = state.batteryInfo as Record<string, unknown>;
    publish(
      "sensor",
      `${uniqueId}_battery`,
      {
        name: "Battery",
        object_id: "battery",
        unique_id: `${uniqueId}_battery`,
        icon: "mdi:battery",
        state_topic: stateTopic,
        value_template:
          "{{ value_json.batteryInfo.battery | default(value_json.batteryInfo.percent) | default('unknown') }}",
        device_class: "battery",
        unit_of_measurement: "%",
        device,
        json_attributes_topic: stateTopic,
        json_attributes_template:
          "{{ value_json.batteryInfo | tojson }}",
      },
    );
  }

  // 6. Motion sensor
  if (state.motionAlarm !== undefined) {
    publish(
      "sensor",
      `${uniqueId}_motion`,
      {
        name: "Motion",
        object_id: "motion",
        unique_id: `${uniqueId}_motion`,
        icon: "mdi:motion-sensor",
        state_topic: stateTopic,
        value_template:
          "{{ 'on' if value_json.motionAlarm and value_json.motionAlarm.enable == 1 else 'off' }}",
        device,
        json_attributes_topic: stateTopic,
        json_attributes_template:
          "{{ value_json.motionAlarm | tojson }}",
      },
    );
  }

  // 7. AI detection binary_sensors (one per supported type)
  const aiTypeLabels: Record<string, string> = {
    people: "Person",
    vehicle: "Vehicle",
    dog_cat: "Pet",
    face: "Face",
    package: "Package",
    other: "Other",
  };
  if (state.aiStatePerType && Object.keys(state.aiStatePerType).length > 0) {
    for (const [aiType, data] of Object.entries(state.aiStatePerType)) {
      const label = aiTypeLabels[aiType] ?? aiType;
      const safeType = aiType.replace(/[^a-zA-Z0-9]/g, "_");
      publish(
        "binary_sensor",
        `${uniqueId}_ai_${safeType}`,
        {
          name: `AI ${label}`,
          object_id: `ai_${safeType}`,
          unique_id: `${uniqueId}_ai_${safeType}`,
          icon: "mdi:robot",
          state_topic: stateTopic,
          payload_on: "on",
          payload_off: "off",
          value_template: `{{ 'on' if ((value_json.aiStatePerType | default({}))['${aiType}'] | default({})).enabled | default(0) == 1 else 'off' }}`,
          device,
          json_attributes_topic: stateTopic,
          json_attributes_template:
            "{{ value_json.aiStatePerType | tojson }}",
        },
      );
    }
  }

  // 8. WiFi signal sensor
  if (state.wifiSignal !== undefined) {
    publish(
      "sensor",
      `${uniqueId}_wifi_signal`,
      {
        name: "WiFi signal",
        object_id: "wifi_signal",
        unique_id: `${uniqueId}_wifi_signal`,
        icon: "mdi:wifi",
        state_topic: stateTopic,
        value_template:
          "{{ value_json.wifiSignal.signal | default(value_json.wifiSignal.rssi) | default('unknown') }}",
        device_class: "signal_strength",
        unit_of_measurement: "dBm",
        device,
        json_attributes_topic: stateTopic,
        json_attributes_template:
          "{{ value_json.wifiSignal | tojson }}",
      },
    );
  }

  // 9. Network sensor
  if (state.networkInfo !== undefined) {
    publish(
      "sensor",
      `${uniqueId}_network`,
      {
        name: "Network",
        object_id: "network",
        unique_id: `${uniqueId}_network`,
        icon: "mdi:lan",
        state_topic: stateTopic,
        value_template:
          "{{ value_json.networkInfo.ip | default(value_json.networkInfo.mac) | default('unknown') }}",
        device,
        json_attributes_topic: stateTopic,
        json_attributes_template:
          "{{ value_json.networkInfo | tojson }}",
      },
    );
  }

  // 10. PTZ position sensor (when hasPtz)
  const showPtz = (caps?.hasPtz ?? false) || state.ptzPosition !== undefined;
  if (showPtz && state.ptzPosition !== undefined) {
    publish(
      "sensor",
      `${uniqueId}_ptz_position`,
      {
        name: "PTZ position",
        object_id: "ptz_position",
        unique_id: `${uniqueId}_ptz_position`,
        icon: "mdi:axis-arrow",
        state_topic: stateTopic,
        value_template:
          "{{ value_json.ptzPosition.pan | default(0) }},{{ value_json.ptzPosition.tilt | default(0) }}",
        device,
        json_attributes_topic: stateTopic,
        json_attributes_template:
          "{{ value_json.ptzPosition | tojson }}",
      },
    );
  }

  // 11. Zoom/focus sensor (when hasZoom)
  const showZoom = (caps?.hasZoom ?? false) || state.zoomFocus !== undefined;
  if (showZoom && state.zoomFocus !== undefined) {
    publish(
      "sensor",
      `${uniqueId}_zoom_focus`,
      {
        name: "Zoom",
        object_id: "zoom_focus",
        unique_id: `${uniqueId}_zoom_focus`,
        icon: "mdi:magnify",
        state_topic: stateTopic,
        value_template:
          "{{ value_json.zoomFocus.zoom.curPos if value_json.zoomFocus and value_json.zoomFocus.zoom else 'unknown' }}",
        device,
        json_attributes_topic: stateTopic,
        json_attributes_template:
          "{{ value_json.zoomFocus | tojson }}",
      },
    );
  }

  // 12. Record sensor
  if (state.recordCfg !== undefined || state.recordSchedule !== undefined) {
    publish(
      "sensor",
      `${uniqueId}_record`,
      {
        name: "Recording",
        object_id: "record",
        unique_id: `${uniqueId}_record`,
        icon: "mdi:record-circle",
        state_topic: stateTopic,
        value_template:
          "{{ 'on' if value_json.recordCfg and value_json.recordCfg.record != 0 else 'off' }}",
        device,
        json_attributes_topic: stateTopic,
        json_attributes_template:
          "{{ {'recordCfg': value_json.recordCfg, 'recordSchedule': value_json.recordSchedule} | tojson }}",
      },
    );
  }

  // 13. LED sensor (power/IR LED)
  if (state.ledState !== undefined) {
    publish(
      "sensor",
      `${uniqueId}_led`,
      {
        name: "LED",
        object_id: "led",
        unique_id: `${uniqueId}_led`,
        icon: "mdi:led-on",
        state_topic: stateTopic,
        value_template:
          "{{ value_json.ledState.mode | default(value_json.ledState.state) | default('unknown') }}",
        device,
        json_attributes_topic: stateTopic,
        json_attributes_template:
          "{{ value_json.ledState | tojson }}",
      },
    );
  }

  // 14. Sleep sensor (battery cameras)
  const showSleep =
    (caps?.hasBattery ?? false) || state.sleepState !== undefined;
  if (showSleep && state.sleepState !== undefined) {
    publish(
      "sensor",
      `${uniqueId}_sleep`,
      {
        name: "Sleep",
        object_id: "sleep",
        unique_id: `${uniqueId}_sleep`,
        icon: "mdi:sleep",
        state_topic: stateTopic,
        value_template:
          "{{ 'awake' if value_json.sleepState and value_json.sleepState.state == 0 else 'sleep' }}",
        device,
        json_attributes_topic: stateTopic,
        json_attributes_template:
          "{{ value_json.sleepState | tojson }}",
      },
    );
  }

  // 15. PIR sensor
  const showPir = (caps?.hasPir ?? false) || state.pirInfo !== undefined;
  if (showPir && state.pirInfo !== undefined) {
    publish(
      "sensor",
      `${uniqueId}_pir`,
      {
        name: "PIR",
        object_id: "pir",
        unique_id: `${uniqueId}_pir`,
        icon: "mdi:motion-sensor",
        state_topic: stateTopic,
        value_template:
          "{{ 'on' if value_json.pirInfo and value_json.pirInfo.enable == 1 else 'off' }}",
        device,
        json_attributes_topic: stateTopic,
        json_attributes_template:
          "{{ value_json.pirInfo | tojson }}",
      },
    );
  }

  // 16. Device info sensor
  if (state.info !== undefined) {
    publish(
      "sensor",
      `${uniqueId}_info`,
      {
        name: "Device info",
        object_id: "info",
        unique_id: `${uniqueId}_info`,
        icon: "mdi:information",
        state_topic: stateTopic,
        value_template:
          "{{ value_json.info.model | default(value_json.info.name) | default('unknown') }}",
        device,
        json_attributes_topic: stateTopic,
        json_attributes_template:
          "{{ value_json.info | tojson }}",
      },
    );
  }

  // 17. Channel count sensor
  if (state.channelCount !== undefined) {
    publish(
      "sensor",
      `${uniqueId}_channel_count`,
      {
        name: "Channels",
        object_id: "channel_count",
        unique_id: `${uniqueId}_channel_count`,
        icon: "mdi:view-grid",
        state_topic: stateTopic,
        value_template:
          "{{ value_json.channelCount | default(1) }}",
        device,
      },
    );
  }

  // 18. Channel info sensor (NVR multi-channel)
  if (state.channelInfo && state.channelInfo.length > 0) {
    publish(
      "sensor",
      `${uniqueId}_channel_info`,
      {
        name: "Channel info",
        object_id: "channel_info",
        unique_id: `${uniqueId}_channel_info`,
        icon: "mdi:view-list",
        state_topic: stateTopic,
        value_template:
          "{{ value_json.channelInfo | length }}",
        device,
        json_attributes_topic: stateTopic,
        json_attributes_template:
          "{{ value_json.channelInfo | tojson }}",
      },
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

  const aiTypes = ["people", "vehicle", "dog_cat", "face", "package", "other"];
  const entityIds = [
    `${uniqueId}_status`,
    `${uniqueId}_spotlight`,
    `${uniqueId}_siren`,
    `${uniqueId}_siren_on_motion`,
    `${uniqueId}_light_on_motion`,
    `${uniqueId}_autotracking`,
    `${uniqueId}_autotracking_type`,
    `${uniqueId}_autotracking_stop_delay`,
    `${uniqueId}_autotracking_disappear_delay`,
    `${uniqueId}_ptz_preset`,
    `${uniqueId}_battery`,
    `${uniqueId}_motion`,
    ...aiTypes.map((t) => `${uniqueId}_ai_${t.replace(/[^a-zA-Z0-9]/g, "_")}`),
    `${uniqueId}_wifi_signal`,
    `${uniqueId}_network`,
    `${uniqueId}_ptz_position`,
    `${uniqueId}_zoom_focus`,
    `${uniqueId}_record`,
    `${uniqueId}_led`,
    `${uniqueId}_sleep`,
    `${uniqueId}_pir`,
    `${uniqueId}_info`,
    `${uniqueId}_channel_count`,
    `${uniqueId}_channel_info`,
  ];

  for (const eid of entityIds) {
    const isSwitch =
      eid.includes("spotlight") ||
      eid.includes("siren") ||
      eid.includes("light_on_motion") ||
      (eid.includes("autotracking") &&
        !eid.includes("autotracking_type") &&
        !eid.includes("autotracking_stop") &&
        !eid.includes("autotracking_disappear"));
    const isNumber =
      eid.includes("autotracking_stop_delay") ||
      eid.includes("autotracking_disappear_delay");
    const type = isSwitch
      ? "switch"
      : eid.includes("ptz_preset")
        ? "select"
        : eid.includes("_ai_")
          ? "binary_sensor"
          : isNumber
            ? "number"
            : "sensor";
    client.publish(`${prefix}/${type}/${eid}/config`, "", {
      qos: 0,
      retain: true,
    });
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
    } else if (command === "siren_on_motion") {
      await api.setSirenOnMotion({ enable: payload === "ON" ? 1 : 0 }, channel);
    } else if (command === "light_on_motion") {
      await api.setFloodlightOnMotion(payload === "ON", channel);
    } else if (command === "autotracking") {
      await api.setAutotracking(payload === "ON", channel);
    } else if (command === "autotracking_stop_delay") {
      const val = parseInt(payload, 10);
      if (!Number.isNaN(val) && val >= 0 && val <= 120) {
        await api.setAutotrackingSettings(channel, {
          smartTrackObjectStopDelay: val,
        });
      }
    } else if (command === "autotracking_disappear_delay") {
      const val = parseInt(payload, 10);
      if (!Number.isNaN(val) && val >= 0 && val <= 60) {
        await api.setAutotrackingSettings(channel, {
          smartTrackObjectDisappearDelay: val,
        });
      }
    } else if (command === "ptz_preset") {
      // Payload is preset name - resolve to id
      const presets = await api.getPtzPresets(channel);
      const preset = presets.find(
        (p) => p.name === payload || String(p.id) === payload,
      );
      if (preset) {
        await api.moveToPtzPreset(channel, preset.id);
      } else {
        const presetId = parseInt(payload, 10);
        if (!Number.isNaN(presetId)) {
          await api.moveToPtzPreset(channel, presetId);
        }
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

async function registerCamera(
  cameraId: string,
  api: ReolinkBaichuanApi,
): Promise<void> {
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
