import { describe, expect, it } from "vitest";
import { shouldAcceptSleepPushSource } from "../../src/reolink/baichuan/utils/events.js";

describe("shouldAcceptSleepPushSource", () => {
  it("always accepts native baichuan / unknown sources", () => {
    expect(shouldAcceptSleepPushSource("baichuan", "email", true)).toBe(true);
    expect(shouldAcceptSleepPushSource(undefined, "webhook", true)).toBe(true);
  });

  it("auto prefers webhook when supported", () => {
    expect(shouldAcceptSleepPushSource("baichuanWebhook", "auto", true)).toBe(
      true,
    );
    expect(shouldAcceptSleepPushSource("email", "auto", true)).toBe(false);
  });

  it("auto falls back to email when webhook unsupported", () => {
    expect(shouldAcceptSleepPushSource("email", "auto", false)).toBe(true);
    expect(shouldAcceptSleepPushSource("baichuanWebhook", "auto", false)).toBe(
      false,
    );
  });

  it("honours explicit preferences", () => {
    expect(shouldAcceptSleepPushSource("email", "email", true)).toBe(true);
    expect(shouldAcceptSleepPushSource("baichuanWebhook", "email", true)).toBe(
      false,
    );
    expect(shouldAcceptSleepPushSource("baichuanWebhook", "webhook", false)).toBe(
      true,
    );
    expect(shouldAcceptSleepPushSource("email", "webhook", false)).toBe(false);
  });
});
