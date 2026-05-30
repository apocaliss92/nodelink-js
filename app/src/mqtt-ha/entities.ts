/**
 * Reolink camera entity definitions for the MQTT/HA discovery library.
 *
 * Each builder returns plain `MqttEntity` objects without any side
 * effects, so they can be combined freely based on per-camera
 * capability flags.
 */

import { PAYLOAD_OFF } from "./discovery.js";
import type { MqttEntity } from "./types.js";

/** Detection (event) entities — one binary sensor per AI/event class. */
export function getDetectionEntities(): MqttEntity[] {
  return [
    {
      entity: "motion",
      domain: "binary_sensor",
      name: "Motion",
      deviceClass: "motion",
      valueToDispatch: PAYLOAD_OFF,
      retain: false,
    },
    {
      entity: "visitor",
      domain: "binary_sensor",
      name: "Visitor",
      deviceClass: "occupancy",
      icon: "mdi:doorbell",
      valueToDispatch: PAYLOAD_OFF,
      retain: false,
    },
    {
      entity: "people",
      domain: "binary_sensor",
      name: "People",
      deviceClass: "motion",
      icon: "mdi:walk",
      valueToDispatch: PAYLOAD_OFF,
      retain: false,
    },
    {
      entity: "vehicle",
      domain: "binary_sensor",
      name: "Vehicle",
      deviceClass: "motion",
      icon: "mdi:car",
      valueToDispatch: PAYLOAD_OFF,
      retain: false,
    },
    {
      entity: "animal",
      domain: "binary_sensor",
      name: "Animal",
      deviceClass: "motion",
      icon: "mdi:dog-side",
      valueToDispatch: PAYLOAD_OFF,
      retain: false,
    },
    {
      entity: "face",
      domain: "binary_sensor",
      name: "Face",
      deviceClass: "motion",
      icon: "mdi:face-recognition",
      valueToDispatch: PAYLOAD_OFF,
      retain: false,
    },
    {
      entity: "package",
      domain: "binary_sensor",
      name: "Package",
      deviceClass: "motion",
      icon: "mdi:package-variant",
      valueToDispatch: PAYLOAD_OFF,
      retain: false,
    },
  ];
}

/**
 * Snapshot entity — exposes a Home Assistant `image` entity that updates
 * on every detection event. The integration captures a fresh JPEG from
 * the camera (cmd_id 109) and republishes it as base64 on the entity's
 * state topic. The discovery builder maps `domain: "image"` to
 * `image_topic` + `image_encoding: "b64"` automatically.
 */
export function getSnapshotEntity(): MqttEntity {
  return {
    entity: "snapshot",
    domain: "image",
    name: "Snapshot",
    icon: "mdi:image",
    retain: false,
  };
}

/** Lifecycle/status entities present on every camera. */
export function getStatusEntities(): MqttEntity[] {
  return [
    {
      entity: "online",
      domain: "binary_sensor",
      name: "Online",
      deviceClass: "connectivity",
      entityCategory: "diagnostic",
      retain: true,
    },
    {
      entity: "sleeping",
      domain: "binary_sensor",
      name: "Sleeping",
      entityCategory: "diagnostic",
      retain: true,
      icon: "mdi:sleep",
    },
  ];
}

/** Battery-related entities (only for `isBattery` cameras). */
export function getBatteryEntities(): MqttEntity[] {
  return [
    {
      entity: "battery",
      domain: "sensor",
      name: "Battery",
      deviceClass: "battery",
      stateClass: "measurement",
      unitOfMeasurement: "%",
      entityCategory: "diagnostic",
      retain: true,
    },
    {
      entity: "charger",
      domain: "binary_sensor",
      name: "Charger",
      deviceClass: "battery_charging",
      entityCategory: "diagnostic",
      retain: true,
      icon: "mdi:battery-charging",
    },
  ];
}

/** WiFi entities — emitted unconditionally; values only published when known. */
export function getWifiEntities(): MqttEntity[] {
  return [
    {
      entity: "wifi_signal",
      domain: "sensor",
      name: "WiFi signal",
      deviceClass: "signal_strength",
      stateClass: "measurement",
      unitOfMeasurement: "dBm",
      entityCategory: "diagnostic",
      retain: true,
    },
  ];
}

export interface ControlCapabilities {
  hasFloodlight?: boolean;
  hasSiren?: boolean;
  hasPir?: boolean;
  hasAutotracking?: boolean;
  hasPresets?: boolean;
}

/** Build the set of control entities matching the camera's capabilities. */
export function getControlEntities(caps: ControlCapabilities): MqttEntity[] {
  const entities: MqttEntity[] = [];

  if (caps.hasFloodlight) {
    entities.push({
      entity: "floodlight",
      domain: "switch",
      name: "Floodlight",
      icon: "mdi:light-flood-down",
      retain: false,
    });
    entities.push({
      entity: "floodlight_on_motion",
      domain: "switch",
      name: "Floodlight on motion",
      icon: "mdi:light-flood-down",
      entityCategory: "config",
      retain: false,
    });
  }

  if (caps.hasSiren) {
    entities.push({
      entity: "siren",
      domain: "switch",
      name: "Siren",
      icon: "mdi:alarm-light",
      retain: false,
    });
    entities.push({
      entity: "siren_on_motion",
      domain: "switch",
      name: "Siren on motion",
      icon: "mdi:alarm-light-outline",
      entityCategory: "config",
      retain: false,
    });
  }

  if (caps.hasPir) {
    entities.push({
      entity: "pir",
      domain: "switch",
      name: "PIR",
      icon: "mdi:motion-sensor",
      entityCategory: "config",
      retain: false,
    });
  }

  if (caps.hasAutotracking) {
    entities.push({
      entity: "autotracking",
      domain: "switch",
      name: "Autotracking",
      icon: "mdi:radar",
      entityCategory: "config",
      retain: false,
    });
  }

  if (caps.hasPresets) {
    entities.push({
      entity: "ptz_preset",
      domain: "select",
      name: "PTZ preset",
      options: [],
      skipCommandTopicReset: true,
    });
  }

  // Reboot button is always present.
  entities.push({
    entity: "reboot",
    domain: "button",
    name: "Reboot",
    deviceClass: "restart",
  });

  return entities;
}
