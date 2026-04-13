/**
 * Home Assistant device-based MQTT discovery payload builder.
 *
 * One device discovery message per device, posted to:
 *   homeassistant/device/{idPrefix}-{deviceId}/config
 *
 * Containing all entities in a `cmps` (components) object, per the
 * HA device-based discovery spec:
 *   https://www.home-assistant.io/integrations/mqtt/#device-discovery-payload
 */

import type { IHaClient, MqttDeviceInfo, MqttEntity } from "./types.js";
import {
  getDeviceDiscoveryTopic,
  getMqttTopics,
  toKebabCase,
  toSnakeCase,
} from "./topics.js";

export const PAYLOAD_PRESS = "PRESS";
export const PAYLOAD_ON = "true";
export const PAYLOAD_OFF = "false";

/**
 * Stable, slug-safe id used as the key inside the `cmps` object of a
 * device discovery payload. HA requires this to be unique per device.
 */
function toDeviceDiscoveryComponentId(entity: MqttEntity): string {
  const raw = `${entity.domain}-${entity.entity}`;
  const kebab = toKebabCase(raw);
  return kebab.replace(/[^a-zA-Z0-9_-]/g, "_");
}

interface DeviceBlock {
  ids: string[];
  name: string;
  manufacturer?: string;
  model?: string;
  sw_version?: string;
  via_device?: string;
  configuration_url?: string;
}

function buildDeviceBlock(
  deviceInfo: MqttDeviceInfo,
  idPrefix: string,
): DeviceBlock {
  const block: DeviceBlock = {
    ids: [`${idPrefix}-${deviceInfo.id}`],
    name: deviceInfo.name,
  };
  if (deviceInfo.manufacturer) block.manufacturer = deviceInfo.manufacturer;
  if (deviceInfo.model) block.model = deviceInfo.model;
  if (deviceInfo.swVersion) block.sw_version = deviceInfo.swVersion;
  if (deviceInfo.viaDevice) {
    // via_device must reference an existing device's primary identifier.
    // We emit it in the same `${idPrefix}-${id}` form used by ids[].
    block.via_device = `${idPrefix}-${deviceInfo.viaDevice}`;
  }
  if (deviceInfo.configurationUrl) {
    block.configuration_url = deviceInfo.configurationUrl;
  }
  return block;
}

/**
 * Build the per-entity component config that lives inside the
 * device discovery payload's `cmps` map.
 *
 * This is intentionally lean: no `dev` block (factored out) and no
 * `unique_id`/`platform` overlap quirks. The returned object can be
 * dropped directly into `cmps[componentId]`.
 */
export function buildEntityConfig(props: {
  entity: MqttEntity;
  deviceInfo: MqttDeviceInfo;
  idPrefix: string;
}): Record<string, unknown> {
  const { entity, deviceInfo, idPrefix } = props;
  const { stateTopic, commandTopic, infoTopic } = getMqttTopics({
    entity,
    deviceId: deviceInfo.id,
    idPrefix,
  });

  const config: Record<string, unknown> = {
    unique_id: `${idPrefix}-${deviceInfo.id}-${toKebabCase(entity.entity)}`,
    default_entity_id: `${entity.domain}.${toSnakeCase(`${deviceInfo.name} ${entity.name}`.trim())}`,
    name: entity.name,
    platform: entity.domain,
    optimistic: false,
    retain: false,
    qos: 0,
  };

  if (entity.deviceClass) config.device_class = entity.deviceClass;
  if (entity.stateClass) config.state_class = entity.stateClass;
  if (entity.icon) config.icon = entity.icon;
  if (entity.entityCategory) config.entity_category = entity.entityCategory;
  if (entity.unitOfMeasurement)
    config.unit_of_measurement = entity.unitOfMeasurement;
  if (entity.precision != null)
    config.suggested_display_precision = entity.precision;
  if (entity.options) config.options = entity.options;
  if (entity.disabled) config.enabled_by_default = false;

  // Wire up topics by domain.
  switch (entity.domain) {
    case "binary_sensor":
      config.state_topic = stateTopic;
      config.payload_on = PAYLOAD_ON;
      config.payload_off = PAYLOAD_OFF;
      config.json_attributes_topic = infoTopic;
      break;
    case "sensor":
      config.state_topic = stateTopic;
      config.json_attributes_topic = infoTopic;
      break;
    case "image":
      config.image_topic = stateTopic;
      config.image_encoding = "b64";
      break;
    case "switch":
      config.state_topic = stateTopic;
      config.command_topic = commandTopic;
      config.payload_on = PAYLOAD_ON;
      config.payload_off = PAYLOAD_OFF;
      config.json_attributes_topic = infoTopic;
      break;
    case "button":
      config.command_topic = commandTopic;
      config.payload_press = PAYLOAD_PRESS;
      break;
    case "select":
      config.state_topic = stateTopic;
      config.command_topic = commandTopic;
      config.json_attributes_topic = infoTopic;
      break;
  }

  return config;
}

/**
 * Build the full device-based discovery JSON payload.
 *
 *   { dev: {...}, o: {...}, cmps: { <id>: {...}, ... } }
 */
export function buildDeviceDiscoveryPayload(props: {
  deviceInfo: MqttDeviceInfo;
  entities: MqttEntity[];
  idPrefix: string;
  namePrefix: string;
  originUrl: string;
}): {
  dev: DeviceBlock;
  o: { name: string; url: string };
  cmps: Record<string, Record<string, unknown>>;
} {
  const { deviceInfo, entities, idPrefix, namePrefix, originUrl } = props;
  const dev = buildDeviceBlock(deviceInfo, idPrefix);
  const cmps: Record<string, Record<string, unknown>> = {};

  for (const entity of entities) {
    cmps[toDeviceDiscoveryComponentId(entity)] = buildEntityConfig({
      entity,
      deviceInfo,
      idPrefix,
    });
  }

  return {
    dev,
    o: { name: namePrefix, url: originUrl },
    cmps,
  };
}

/**
 * Publish device discovery + initial states + reset command topics.
 *
 * Returns the list of topics that were posted (currently only the
 * device-level discovery topic) so callers can track them for
 * later cleanup via `cleanupAutodiscoveryTopics`.
 */
export async function publishMqttDeviceDiscovery(props: {
  client: IHaClient;
  deviceInfo: MqttDeviceInfo;
  entities: MqttEntity[];
  idPrefix: string;
  namePrefix: string;
  originUrl: string;
  /** Optional override values for entity initial state, keyed by `entity.entity`. */
  initialEntityStates?: Record<string, unknown>;
}): Promise<string[]> {
  const {
    client,
    deviceInfo,
    entities,
    idPrefix,
    namePrefix,
    originUrl,
    initialEntityStates,
  } = props;

  const payload = buildDeviceDiscoveryPayload({
    deviceInfo,
    entities,
    idPrefix,
    namePrefix,
    originUrl,
  });
  const discoveryTopic = getDeviceDiscoveryTopic(deviceInfo.id, idPrefix);
  await client.publish(discoveryTopic, JSON.stringify(payload), true);

  // Seed initial state values (valueToDispatch on entity, optionally overridden).
  for (const entity of entities) {
    const override = initialEntityStates?.[entity.entity];
    const value =
      override !== undefined ? override : entity.valueToDispatch;
    if (value !== undefined) {
      const { stateTopic } = getMqttTopics({
        entity,
        deviceId: deviceInfo.id,
        idPrefix,
      });
      await client.publish(stateTopic, value, entity.retain ?? true);
    }
  }

  // Reset command topics for switch/button entities so HA sees a clean slate.
  for (const entity of entities) {
    if (
      (entity.domain === "switch" || entity.domain === "button") &&
      !entity.skipCommandTopicReset
    ) {
      const { commandTopic } = getMqttTopics({
        entity,
        deviceId: deviceInfo.id,
        idPrefix,
      });
      await client.publish(commandTopic, "", true);
    }
  }

  return [discoveryTopic];
}

/**
 * Clear all retained topics for a device: state, command, info and
 * the device discovery topic itself. This effectively removes the
 * device from Home Assistant.
 */
export async function clearMqttDevice(props: {
  client: IHaClient;
  deviceInfo: MqttDeviceInfo;
  entities: MqttEntity[];
  idPrefix: string;
}): Promise<void> {
  const { client, deviceInfo, entities, idPrefix } = props;

  await client.publish(
    getDeviceDiscoveryTopic(deviceInfo.id, idPrefix),
    "",
    true,
  );

  for (const entity of entities) {
    const { stateTopic, commandTopic, infoTopic } = getMqttTopics({
      entity,
      deviceId: deviceInfo.id,
      idPrefix,
    });
    await client.publish(stateTopic, "", true);
    await client.publish(commandTopic, "", true);
    await client.publish(infoTopic, "", true);
  }
}
