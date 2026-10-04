import { describe, expect, it } from "vitest";
import { classifyEmailPushMessage } from "../../src/emailPush/classify.js";

describe("classifyEmailPushMessage", () => {
  it("does not treat Motion Detected from Doorbell as a doorbell press", () => {
    expect(
      classifyEmailPushMessage({
        subject: "Motion Detected from Doorbell at 14:30:00",
        text: "A motion was detected.",
      }),
    ).toBe("motion");
  });

  it("still classifies clear doorbell / visitor subjects", () => {
    expect(
      classifyEmailPushMessage({
        subject: "Someone rang the doorbell",
        text: "",
      }),
    ).toBe("doorbell");
    expect(
      classifyEmailPushMessage({
        subject: "Visitor at the door",
        text: "Ring button pressed",
      }),
    ).toBe("doorbell");
  });

  it("keeps AI classifiers ahead of motion", () => {
    expect(
      classifyEmailPushMessage({
        subject: "Person Detected from Front",
        text: "",
      }),
    ).toBe("people");
  });
});
