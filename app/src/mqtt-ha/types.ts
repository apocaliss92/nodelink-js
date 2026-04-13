/**
 * MQTT/Home Assistant discovery library — type definitions.
 *
 * This module is intentionally framework-agnostic and has zero
 * application-specific imports. It can be extracted into a standalone
 * npm package without modification.
 */

export type HaMessageCb = (topic: string, message: string) => Promise<void>;

export type MqttDomain =
  | "sensor"
  | "binary_sensor"
  | "image"
  | "switch"
  | "button"
  | "select";

/**
 * Minimal client surface used by the discovery helpers.
 *
 * Implementations must be safe to call concurrently and should
 * handle reconnects internally.
 */
export interface IHaClient {
  publish(topic: string, value: unknown, retain?: boolean): Promise<void>;
  subscribe(topics: string[], cb: HaMessageCb): Promise<void>;
  unsubscribe(topics: string[]): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Publish an empty payload (clear retained message) to every
   * tracked autodiscovery topic that is no longer in `activeTopics`.
   */
  cleanupAutodiscoveryTopics(activeTopics: string[]): Promise<void>;
}

/**
 * Declarative description of a single Home Assistant entity.
 *
 * The discovery layer turns this into the `cmps` entry of a
 * device-based MQTT discovery payload.
 */
export interface MqttEntity {
  /** Stable, slug-safe entity id (e.g. "battery", "ptz_preset"). */
  entity: string;
  /** HA MQTT discovery domain. */
  domain: MqttDomain;
  /** Human-readable entity name shown in HA. */
  name: string;
  /** Optional HA `device_class`. */
  deviceClass?: string;
  /** Optional `mdi:*` icon. */
  icon?: string;
  /** HA `entity_category`. */
  entityCategory?: "diagnostic" | "config";
  /** Initial value to publish to the state topic right after discovery. */
  valueToDispatch?: unknown;
  /** Optional unit (e.g. "%", "dBm"). */
  unitOfMeasurement?: string;
  /** When true, publish `enabled_by_default: false`. */
  disabled?: boolean;
  /** Optional HA `state_class`. */
  stateClass?: string;
  /** Suggested display precision for sensors. */
  precision?: number;
  /** Options for `select` domain. */
  options?: string[];
  /**
   * Whether the state topic should be published with the MQTT retain flag.
   * Defaults to `true` for stable values (battery, online, etc.) and is
   * usually `false` for momentary events (motion).
   */
  retain?: boolean;
  /**
   * If true, do not publish an empty string to the command topic after
   * discovery. Used for `select` entities where an empty payload would
   * be interpreted as "no selection" by HA.
   */
  skipCommandTopicReset?: boolean;
}

/**
 * Lightweight device descriptor — the bits HA needs for the
 * discovery payload's `dev` block. Intentionally without any
 * Scrypted (or other framework) coupling.
 */
export interface MqttDeviceInfo {
  /** Slug-safe device id. */
  id: string;
  /** Display name. */
  name: string;
  manufacturer?: string;
  model?: string;
  swVersion?: string;
  /**
   * Identifier of the parent device (the bridge/manager).
   * Should match an existing `MqttDeviceInfo.id`.
   */
  viaDevice?: string;
  /** URL HA should open when the user clicks "Visit device". */
  configurationUrl?: string;
}

/** Cache entry: last value published and its TTL expiration timestamp. */
export interface MqttTopicCacheEntry {
  value: string | Buffer;
  expiresAt: number;
}
