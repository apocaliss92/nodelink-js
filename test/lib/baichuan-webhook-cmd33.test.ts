import { describe, expect, it } from "vitest";
import {
  mapBaichuanWebhookAlarmXmlToSimpleEvents,
  mapBaichuanWebhookParsedToSimpleEvents,
  parseBaichuanWebhookBody,
} from "../../src/baichuanWebhook/index.js";

function alarmXml(params: { status: string; ai: string }): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<AlarmEventList version="1.1">
<AlarmEvent version="1.1">
<channelId>0</channelId>
<status>${params.status}</status>
<AItype>${params.ai}</AItype>
<recording>0</recording>
<timeStamp>0</timeStamp>
</AlarmEvent>
</AlarmEventList>
</body>`;
}

describe("mapBaichuanWebhookAlarmXmlToSimpleEvents (Wired Power / cmd 33)", () => {
  it("maps status=none + AItype=other → motion (doorbell Gen2 wired)", () => {
    expect(
      mapBaichuanWebhookAlarmXmlToSimpleEvents(
        alarmXml({ status: "none", ai: "other" }),
      ),
    ).toEqual(["motion"]);
  });

  it("maps people AI to people (+ motion fan-out left to consumer)", () => {
    expect(
      mapBaichuanWebhookAlarmXmlToSimpleEvents(
        alarmXml({ status: "none", ai: "people" }),
      ),
    ).toEqual(["people"]);
    expect(
      mapBaichuanWebhookAlarmXmlToSimpleEvents(
        alarmXml({ status: "none", ai: "people,other" }),
      ),
    ).toEqual(["people"]);
  });

  it("maps visitor → doorbell", () => {
    expect(
      mapBaichuanWebhookAlarmXmlToSimpleEvents(
        alarmXml({ status: "visitor", ai: "other" }),
      ),
    ).toEqual(["doorbell"]);
    expect(
      mapBaichuanWebhookAlarmXmlToSimpleEvents(
        alarmXml({ status: "visitor", ai: "none" }),
      ),
    ).toEqual(["doorbell"]);
  });

  it("maps idle (none/none) → empty", () => {
    expect(
      mapBaichuanWebhookAlarmXmlToSimpleEvents(
        alarmXml({ status: "none", ai: "none" }),
      ),
    ).toEqual([]);
  });

  it("maps status motion tokens even without AI", () => {
    expect(
      mapBaichuanWebhookAlarmXmlToSimpleEvents(
        alarmXml({ status: "MD", ai: "none" }),
      ),
    ).toEqual(["motion"]);
  });
});

describe("mapBaichuanWebhookParsedToSimpleEvents", () => {
  it("routes cmd 33 bodies from parseBaichuanWebhookBody", () => {
    const parsed = parseBaichuanWebhookBody(
      JSON.stringify({
        uid: "X",
        cmd: 33,
        xml: alarmXml({ status: "none", ai: "other" }),
      }),
    );
    expect(parsed?.kind).toBe("cmd");
    expect(mapBaichuanWebhookParsedToSimpleEvents(parsed!)).toEqual(["motion"]);
  });

  it("keeps wake/pir → motion+awake", () => {
    const parsed = parseBaichuanWebhookBody(
      JSON.stringify({ data: { event: "wake", reason: "pir" } }),
    );
    expect(mapBaichuanWebhookParsedToSimpleEvents(parsed!)).toEqual([
      "motion",
      "awake",
    ]);
  });

  it("ignores test probes and unknown cmds", () => {
    expect(
      mapBaichuanWebhookParsedToSimpleEvents(
        parseBaichuanWebhookBody(
          JSON.stringify({ data: { event: "test" } }),
        )!,
      ),
    ).toEqual([]);
    expect(
      mapBaichuanWebhookParsedToSimpleEvents(
        parseBaichuanWebhookBody(
          JSON.stringify({ cmd: 99, xml: "<body/>" }),
        )!,
      ),
    ).toEqual([]);
  });
});
