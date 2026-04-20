/**
 * MQTT client implementing IHaClient.
 *
 * Adapted from scrypted-apocaliss-base/src/mqtt-client.ts but with all
 * Scrypted SDK dependencies removed so this file can live in any
 * Node.js project.
 *
 * Features:
 *   - Lazy connection (connect on first publish/subscribe).
 *   - Auto-reconnect on transient failures.
 *   - Per-topic publish cache with TTL (skip publishing identical values).
 *   - Wildcard pattern matching for subscribe callbacks (`+`, `#`).
 *   - Tracking of `homeassistant/.../config` topics so they can be
 *     cleaned up when entities are removed.
 */

import {
  connectAsync,
  type MqttClient as Client,
  type IPublishPacket,
} from "mqtt";

import type { HaMessageCb, IHaClient, MqttTopicCacheEntry } from "./types.js";

export type MqttMessageCb = (
  topic: string,
  message: string,
  data?: IPublishPacket,
) => Promise<void>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Returns true when an MQTT topic matches a (possibly wildcarded)
 * subscription pattern. Supports `+` (single level) and `#` (multi level).
 */
function topicMatches(pattern: string, topic: string): boolean {
  const patternLevels = pattern.split("/");
  const topicLevels = topic.split("/");

  for (let i = 0; i < patternLevels.length; i++) {
    if (patternLevels[i] === "#") return true;
    if (patternLevels[i] === "+") continue;
    if (patternLevels[i] !== topicLevels[i]) return false;
  }

  return patternLevels.length === topicLevels.length;
}

export interface MqttClientOptions {
  /** MQTT broker URL (e.g. `mqtt://localhost:1883`). */
  host: string;
  username?: string;
  password?: string;
  logger?: Console;
  clientId?: string;
  /**
   * Optional pattern subscribed at connect time so we can track
   * existing autodiscovery topics and later clean them up.
   * Typical value: `homeassistant/+/+/+/config` or `homeassistant/device/+/config`.
   */
  configTopicPattern?: string;
  /** Enable per-topic publish cache (skips identical retained publishes). */
  cache?: boolean;
  /** TTL for cache entries in ms. Default 60_000. */
  cacheTtlMs?: number;
}

export default class MqttClient implements IHaClient {
  private mqttClient: Client | undefined;
  private mqttPathname = "";
  private readonly host: string;
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly clientId: string | undefined;
  private readonly logger: Console;
  private readonly configTopicPattern: string | undefined;
  private readonly cache: boolean;
  private readonly cacheTtlMs: number;

  /** Map topic -> { value, expiresAt }. Used when cache is enabled. */
  private topicCache: Record<string, MqttTopicCacheEntry> = {};
  private topicCbMap: Record<string, HaMessageCb[]> = {};
  private connecting = false;
  private currentAutodiscoveryTopics: string[] = [];

  constructor(opts: MqttClientOptions) {
    this.host = opts.host;
    this.username = opts.username;
    this.password = opts.password;
    this.logger = opts.logger ?? console;
    this.clientId = opts.clientId;
    this.configTopicPattern = opts.configTopicPattern;
    this.cache = opts.cache ?? true;
    this.cacheTtlMs = opts.cacheTtlMs ?? 60 * 1000;
  }

  /** Returns the underlying mqtt.js client, connecting if necessary. */
  async getMqttClient(forceReconnect = false): Promise<Client | undefined> {
    if (this.connecting) {
      return this.mqttClient;
    }

    const _connect = async (): Promise<void> => {
      try {
        this.connecting = true;
        const client = await connectAsync(
          this.mqttPathname,
          {
            rejectUnauthorized: false,
            username: this.username,
            password: this.password,
            clientId: this.clientId,
            reschedulePings: true,
          },
          true,
        );

        if (this.configTopicPattern) {
          await client.subscribeAsync([this.configTopicPattern]);
        }

        client.on("message", async (messageTopic, message) => {
          const cbs: HaMessageCb[] = [];
          for (const [key] of Object.entries(this.topicCbMap)) {
            if (topicMatches(key, messageTopic)) {
              cbs.push(...this.topicCbMap[key]!);
            }
          }
          const messageString = message.toString();

          if (cbs.length > 0) {
            this.logger.debug(
              `Topic ${messageTopic} for ${cbs.length} cbs sent with data ${messageString}`,
            );
            for (const cb of cbs) {
              cb(messageTopic, messageString).catch((e) =>
                this.logger.log("MQTT cb error", e),
              );
            }
          }

          if (
            this.configTopicPattern &&
            message.length > 0 &&
            messageTopic.endsWith("/config") &&
            !this.currentAutodiscoveryTopics.includes(messageTopic)
          ) {
            this.currentAutodiscoveryTopics.push(messageTopic);
          }
        });

        client.on("disconnect", (p) => {
          this.logger.info(`MQTT client disconnecting: ${JSON.stringify(p)}`);
        });
        client.on("reconnect", () => {
          this.logger.info("MQTT client reconnecting");
        });

        client.setMaxListeners(Infinity);

        this.logger.log(
          "Connected to MQTT",
          this.mqttPathname,
          this.username,
          this.clientId,
        );
        this.mqttClient = client;
      } catch (e) {
        this.logger.log(
          "Error connecting to mqtt. Waiting before trying again. Client id is ",
          this.clientId,
          e,
        );
        await this.mqttClient?.endAsync(true).catch(() => {});
        await sleep(5000);
      } finally {
        this.connecting = false;
      }
    };

    if (!this.mqttClient || forceReconnect) {
      if (forceReconnect && this.mqttClient) {
        try {
          await this.mqttClient.endAsync();
        } catch {
          // ignore
        }
      }
      const url = new URL(this.host);
      url.pathname = "";

      this.mqttPathname = url.toString();
      if (!this.mqttPathname.endsWith("/")) {
        this.mqttPathname = `${this.mqttPathname}/`;
      }
      this.logger.log(
        "Starting MQTT connection",
        this.mqttPathname,
        this.username,
        this.clientId,
      );

      await _connect();
      return this.mqttClient;
    }

    return this.mqttClient;
  }

  async publish(topic: string, inputValue: unknown, retain = true): Promise<void> {
    if (inputValue === undefined || inputValue === null) {
      this.logger.debug(
        `Skipping publish, value is undefined or null: ${JSON.stringify({ topic })}`,
      );
      return;
    }

    let value: string | Buffer;
    try {
      if (Buffer.isBuffer(inputValue)) {
        value = inputValue;
      } else if (typeof inputValue === "object") {
        value = JSON.stringify(inputValue);
      } else {
        value = String(inputValue);
      }
    } catch (e) {
      this.logger.log(`Error parsing publish values for topic ${topic}`, e);
      return;
    }

    const entry = this.topicCache[topic];
    const cacheValid =
      entry &&
      entry.value === value &&
      (!this.cacheTtlMs || Date.now() <= entry.expiresAt);
    const valueForLog = Buffer.isBuffer(value)
      ? `<buf ${value.length}B>`
      : value.length > 120
        ? `${value.slice(0, 120)}…`
        : value;
    if (this.cache && cacheValid) {
      this.logger.debug(
        `Skipping publish (cache hit) for ${topic} value=${valueForLog}`,
      );
      return;
    }

    this.logger.debug(`Publishing ${topic} value=${valueForLog}`);
    const client = await this.getMqttClient();
    if (!client) return;

    try {
      await client.publishAsync(topic, value, { retain });
    } catch (e) {
      this.logger.log(`Error publishing to MQTT, reconnecting (${topic})`, e);
      await this.getMqttClient(true);
      await client
        .publishAsync(topic, value, { retain })
        .catch((err) =>
          this.logger.log(`Error publish retry for ${topic}`, err),
        );
    } finally {
      if (this.cache) {
        this.topicCache[topic] = {
          value,
          expiresAt: this.cacheTtlMs
            ? Date.now() + this.cacheTtlMs
            : Number.MAX_SAFE_INTEGER,
        };
      }
    }
  }

  async subscribe(topics: string[], cb: HaMessageCb): Promise<void> {
    const client = await this.getMqttClient();
    if (!client) return;

    await client.subscribeAsync(topics);
    for (const topic of topics) {
      if (!this.topicCbMap[topic]) {
        this.topicCbMap[topic] = [];
      }
      this.topicCbMap[topic]!.push(cb);
    }
  }

  async unsubscribe(topics: string[]): Promise<void> {
    const client = await this.getMqttClient();
    if (!client) return;

    await client.unsubscribeAsync(topics);
    for (const topic of topics) {
      delete this.topicCbMap[topic];
    }
  }

  async cleanupAutodiscoveryTopics(activeTopics: string[]): Promise<void> {
    const topicsToDelete = this.currentAutodiscoveryTopics.filter(
      (topic) => !activeTopics.includes(topic),
    );
    if (topicsToDelete.length > 0) {
      for (const topic of topicsToDelete) {
        await this.publish(topic, "", true);
      }
      this.logger.log(
        `${topicsToDelete.length} stale autodiscovery topics cleared: ${topicsToDelete.join(", ")}`,
      );
    }
  }

  async disconnect(): Promise<void> {
    if (this.mqttClient) {
      try {
        this.logger.log("Disconnecting MQTT client");
        await this.mqttClient.endAsync(true);
      } catch (e) {
        this.logger.log("Error closing MQTT connection", e);
      } finally {
        this.mqttClient = undefined;
      }
    }
  }

  /** True when the underlying client is currently connected. */
  isConnected(): boolean {
    return this.mqttClient?.connected ?? false;
  }
}

/**
 * Convenience factory: build and immediately connect a client.
 * Returns undefined if connection fails.
 */
export async function getMqttBasicClient(
  opts: MqttClientOptions,
): Promise<MqttClient | undefined> {
  const client = new MqttClient(opts);
  const underlying = await client.getMqttClient();
  if (!underlying) return undefined;
  return client;
}
