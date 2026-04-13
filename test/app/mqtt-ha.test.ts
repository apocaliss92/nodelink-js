import { describe, it, expect } from "vitest";
import {
  buildDeviceDiscoveryPayload,
  buildEntityConfig,
  PAYLOAD_OFF,
  PAYLOAD_ON,
} from "../../app/src/mqtt-ha/discovery.js";
import {
  getControlEntities,
  getDetectionEntities,
  getStatusEntities,
} from "../../app/src/mqtt-ha/entities.js";
import {
  getDeviceDiscoveryTopic,
  getMqttTopics,
  toKebabCase,
  toSnakeCase,
  toTitleCase,
} from "../../app/src/mqtt-ha/topics.js";
import type { MqttDeviceInfo, MqttEntity } from "../../app/src/mqtt-ha/types.js";

const ID_PREFIX = "nodelink-js";
const NAME_PREFIX = "Nodelink.js";
const ORIGIN_URL = "https://example.com/nodelink";

const sampleDevice: MqttDeviceInfo = {
  id: "cam1",
  name: "Front Door",
  manufacturer: "Reolink",
  model: "RLC-810A",
  swVersion: "1.0.0",
  viaDevice: "nodelink-manager",
};

describe("mqtt-ha topics", () => {
  it("builds canonical topic set for an entity", () => {
    const entity: MqttEntity = {
      entity: "battery",
      domain: "sensor",
      name: "Battery",
    };
    const topics = getMqttTopics({
      entity,
      deviceId: "cam1",
      idPrefix: ID_PREFIX,
    });
    expect(topics.stateTopic).toBe("nodelink-js/nodelink-js-cam1/battery");
    expect(topics.commandTopic).toBe(
      "nodelink-js/nodelink-js-cam1/battery/set",
    );
    expect(topics.infoTopic).toBe("nodelink-js/nodelink-js-cam1/battery/info");
    expect(topics.discoveryTopic).toBe(
      "homeassistant/sensor/nodelink-js-cam1/battery/config",
    );
  });

  it("builds device-level discovery topic", () => {
    expect(getDeviceDiscoveryTopic("cam1", ID_PREFIX)).toBe(
      "homeassistant/device/nodelink-js-cam1/config",
    );
  });

  it("casing helpers normalize input", () => {
    expect(toSnakeCase("PTZ Preset")).toBe("ptz_preset");
    expect(toKebabCase("Floodlight On Motion")).toBe("floodlight-on-motion");
    expect(toTitleCase("hello world")).toBe("Hello World");
  });
});

describe("mqtt-ha entity catalog", () => {
  it("detection entities default to PAYLOAD_OFF", () => {
    const entities = getDetectionEntities();
    expect(entities.length).toBeGreaterThan(0);
    for (const e of entities) {
      expect(e.domain).toBe("binary_sensor");
      expect(e.valueToDispatch).toBe(PAYLOAD_OFF);
      expect(e.retain).toBe(false);
    }
    const names = entities.map((e) => e.entity);
    expect(names).toEqual(
      expect.arrayContaining([
        "motion",
        "visitor",
        "people",
        "vehicle",
        "animal",
        "face",
        "package",
      ]),
    );
  });

  it("status entities are diagnostic and retained", () => {
    const entities = getStatusEntities();
    const online = entities.find((e) => e.entity === "online")!;
    expect(online.deviceClass).toBe("connectivity");
    expect(online.entityCategory).toBe("diagnostic");
    expect(online.retain).toBe(true);
  });

  it("control entities respect capability flags", () => {
    const allOff = getControlEntities({});
    // Only the always-on reboot button.
    expect(allOff.find((e) => e.entity === "reboot")).toBeDefined();
    expect(allOff.find((e) => e.entity === "floodlight")).toBeUndefined();

    const all = getControlEntities({
      hasFloodlight: true,
      hasSiren: true,
      hasPir: true,
      hasAutotracking: true,
      hasPresets: true,
    });
    const names = all.map((e) => e.entity);
    expect(names).toEqual(
      expect.arrayContaining([
        "floodlight",
        "floodlight_on_motion",
        "siren",
        "siren_on_motion",
        "pir",
        "autotracking",
        "ptz_preset",
        "reboot",
      ]),
    );

    const ptz = all.find((e) => e.entity === "ptz_preset")!;
    expect(ptz.skipCommandTopicReset).toBe(true);
    expect(ptz.options).toEqual([]);
  });
});

describe("mqtt-ha discovery payload", () => {
  it("builds per-entity config wired to correct domain topics", () => {
    const sw: MqttEntity = {
      entity: "floodlight",
      domain: "switch",
      name: "Floodlight",
      retain: false,
    };
    const cfg = buildEntityConfig({
      entity: sw,
      deviceInfo: sampleDevice,
      idPrefix: ID_PREFIX,
    });
    expect(cfg.platform).toBe("switch");
    expect(cfg.command_topic).toBe(
      "nodelink-js/nodelink-js-cam1/floodlight/set",
    );
    expect(cfg.state_topic).toBe("nodelink-js/nodelink-js-cam1/floodlight");
    expect(cfg.payload_on).toBe(PAYLOAD_ON);
    expect(cfg.payload_off).toBe(PAYLOAD_OFF);
    expect(cfg.unique_id).toBe("nodelink-js-cam1-floodlight");
  });

  it("builds device-based discovery payload with cmps map", () => {
    const entities: MqttEntity[] = [
      ...getStatusEntities(),
      ...getControlEntities({ hasSiren: true }),
    ];

    const payload = buildDeviceDiscoveryPayload({
      deviceInfo: sampleDevice,
      entities,
      idPrefix: ID_PREFIX,
      namePrefix: NAME_PREFIX,
      originUrl: ORIGIN_URL,
    });

    expect(payload.dev.ids).toEqual(["nodelink-js-cam1"]);
    expect(payload.dev.name).toBe("Front Door");
    expect(payload.dev.manufacturer).toBe("Reolink");
    expect(payload.dev.via_device).toBe("nodelink-js-nodelink-manager");
    expect(payload.o.name).toBe(NAME_PREFIX);
    expect(payload.o.url).toBe(ORIGIN_URL);

    // Components are keyed by `domain-entity` (kebab-cased).
    const keys = Object.keys(payload.cmps);
    expect(keys).toEqual(
      expect.arrayContaining([
        "binary-sensor-online",
        "binary-sensor-sleeping",
        "switch-siren",
        "switch-siren-on-motion",
        "button-reboot",
      ]),
    );

    const sirenCfg = payload.cmps["switch-siren"]!;
    expect(sirenCfg.command_topic).toBe(
      "nodelink-js/nodelink-js-cam1/siren/set",
    );
  });

  it("device block omits via_device when not provided (bridge case)", () => {
    const bridge: MqttDeviceInfo = {
      id: "nodelink-manager",
      name: "Nodelink Manager",
      manufacturer: "Nodelink.js",
      model: "Manager",
      swVersion: "1.0.0",
    };
    const payload = buildDeviceDiscoveryPayload({
      deviceInfo: bridge,
      entities: [],
      idPrefix: ID_PREFIX,
      namePrefix: NAME_PREFIX,
      originUrl: ORIGIN_URL,
    });
    expect(payload.dev.via_device).toBeUndefined();
    expect(payload.dev.ids).toEqual(["nodelink-js-nodelink-manager"]);
  });
});
