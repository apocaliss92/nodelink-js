/**
 * Standalone MQTT/Home Assistant discovery library.
 *
 * Re-exports everything from the sub-modules so callers can use a
 * single import path (`./mqtt-ha`).
 */

export * from "./types.js";
export * from "./topics.js";
export * from "./discovery.js";
export * from "./entities.js";
export { default as MqttClient, getMqttBasicClient } from "./client.js";
export type { MqttClientOptions } from "./client.js";
