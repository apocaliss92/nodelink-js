import { describe, it, expect } from "vitest";
import {
  parseBaichuanWebhookBody,
  mapBaichuanWebhookToSimpleEvents,
} from "../../src/baichuanWebhook/index.js";

describe("parseBaichuanWebhookBody", () => {
  it("parses wake + pir", () => {
    const parsed = parseBaichuanWebhookBody(
      JSON.stringify({ data: { event: "wake", reason: "pir" } }),
    );
    expect(parsed).toEqual({
      kind: "event",
      event: "wake",
      reason: "pir",
      data: { event: "wake", reason: "pir" },
    });
  });

  it("parses wake + doorbell", () => {
    const parsed = parseBaichuanWebhookBody(
      Buffer.from(
        JSON.stringify({ data: { event: "wake", reason: "doorbell" } }),
      ),
    );
    expect(parsed?.kind).toBe("event");
    if (parsed?.kind === "event") {
      expect(parsed.reason).toBe("doorbell");
    }
  });

  it("parses sleep", () => {
    const parsed = parseBaichuanWebhookBody(
      JSON.stringify({ data: { event: "sleep" } }),
    );
    expect(parsed).toMatchObject({ kind: "event", event: "sleep" });
  });

  it("parses opaque cmd/xml pushes", () => {
    const parsed = parseBaichuanWebhookBody(
      JSON.stringify({
        uid: "9527000ICL1T1MDS",
        cmd: 33,
        xml: "<AlarmEventList/>",
        ext_xml: "<Extension/>",
      }),
    );
    expect(parsed).toEqual({
      kind: "cmd",
      uid: "9527000ICL1T1MDS",
      cmdId: 33,
      xml: "<AlarmEventList/>",
      extXml: "<Extension/>",
    });
  });

  it("returns undefined for garbage", () => {
    expect(parseBaichuanWebhookBody("not-json")).toBeUndefined();
    expect(parseBaichuanWebhookBody("{}")).toBeUndefined();
  });
});

describe("mapBaichuanWebhookToSimpleEvents", () => {
  it("maps wake/pir → motion + awake", () => {
    expect(
      mapBaichuanWebhookToSimpleEvents({ event: "wake", reason: "pir" }),
    ).toEqual(["motion", "awake"]);
  });

  it("maps wake/doorbell → doorbell + awake", () => {
    expect(
      mapBaichuanWebhookToSimpleEvents({ event: "wake", reason: "doorbell" }),
    ).toEqual(["doorbell", "awake"]);
  });

  it("maps sleep → sleeping", () => {
    expect(mapBaichuanWebhookToSimpleEvents({ event: "sleep" })).toEqual([
      "sleeping",
    ]);
  });

  it("maps test → empty", () => {
    expect(mapBaichuanWebhookToSimpleEvents({ event: "test" })).toEqual([]);
  });
});
