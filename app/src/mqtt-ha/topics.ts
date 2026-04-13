/**
 * Topic builders and casing helpers for the MQTT/HA discovery library.
 *
 * Topic structure (matches scrypted-advanced-notifier convention):
 *   state    : {idPrefix}/{idPrefix}-{deviceId}/{entity}
 *   command  : {idPrefix}/{idPrefix}-{deviceId}/{entity}/set
 *   info     : {idPrefix}/{idPrefix}-{deviceId}/{entity}/info
 *   discovery: homeassistant/{domain}/{idPrefix}-{deviceId}/{entity}/config
 *   device   : homeassistant/device/{idPrefix}-{deviceId}/config
 */

import type { MqttEntity } from "./types.js";

export function toSnakeCase(str: string): string {
  return str
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

export function toKebabCase(str: string): string {
  return str
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export function toTitleCase(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface MqttTopicSet {
  stateTopic: string;
  commandTopic: string;
  infoTopic: string;
  discoveryTopic: string;
}

export interface GetMqttTopicsProps {
  entity: MqttEntity;
  deviceId: string;
  idPrefix: string;
}

export function getMqttTopics(props: GetMqttTopicsProps): MqttTopicSet {
  const { entity, deviceId, idPrefix } = props;
  const base = `${idPrefix}/${idPrefix}-${deviceId}/${entity.entity}`;
  return {
    stateTopic: base,
    commandTopic: `${base}/set`,
    infoTopic: `${base}/info`,
    discoveryTopic: `homeassistant/${entity.domain}/${idPrefix}-${deviceId}/${entity.entity}/config`,
  };
}

export function getDeviceDiscoveryTopic(
  deviceId: string,
  idPrefix: string,
): string {
  return `homeassistant/device/${idPrefix}-${deviceId}/config`;
}
