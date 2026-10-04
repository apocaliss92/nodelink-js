import { describe, expect, it } from "vitest";
import { shouldAcceptSleepPushSource } from "../../src/reolink/baichuan/utils/events.js";

describe("shouldAcceptSleepPushSource", () => {
  it("always accepts native baichuan / unknown sources", () => {
    expect(
      shouldAcceptSleepPushSource("baichuan", "email", {
        webhookSupported: true,
      }),
    ).toBe(true);
    expect(
      shouldAcceptSleepPushSource(undefined, "webhook", {
        webhookSupported: true,
      }),
    ).toBe(true);
  });

  it("auto keeps email until a real HaCfg delivery has been seen", () => {
    expect(
      shouldAcceptSleepPushSource("email", "auto", {
        webhookSupported: true,
        webhookDeliverySeen: false,
      }),
    ).toBe(true);
    expect(
      shouldAcceptSleepPushSource("baichuanWebhook", "auto", {
        webhookSupported: true,
        webhookDeliverySeen: false,
      }),
    ).toBe(true);
  });

  it("auto drops email after the first real HaCfg delivery", () => {
    expect(
      shouldAcceptSleepPushSource("baichuanWebhook", "auto", {
        webhookSupported: true,
        webhookDeliverySeen: true,
      }),
    ).toBe(true);
    expect(
      shouldAcceptSleepPushSource("email", "auto", {
        webhookSupported: true,
        webhookDeliverySeen: true,
      }),
    ).toBe(false);
  });

  it("auto falls back to email when webhook unsupported", () => {
    expect(
      shouldAcceptSleepPushSource("email", "auto", {
        webhookSupported: false,
      }),
    ).toBe(true);
    expect(
      shouldAcceptSleepPushSource("baichuanWebhook", "auto", {
        webhookSupported: false,
      }),
    ).toBe(false);
  });

  it("honours explicit preferences", () => {
    expect(
      shouldAcceptSleepPushSource("email", "email", {
        webhookSupported: true,
      }),
    ).toBe(true);
    expect(
      shouldAcceptSleepPushSource("baichuanWebhook", "email", {
        webhookSupported: true,
      }),
    ).toBe(false);
    expect(
      shouldAcceptSleepPushSource("baichuanWebhook", "webhook", {
        webhookSupported: false,
      }),
    ).toBe(true);
    expect(
      shouldAcceptSleepPushSource("email", "webhook", {
        webhookSupported: false,
      }),
    ).toBe(false);
  });
});
