import { describe, it, expect, vi } from "vitest";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi.js";
import { BC_CMD_ID_SET_PIR_INFO } from "../../src/protocol/constants.js";

const pirReply = (maxAlarmTime: string): string =>
  `<?xml version="1.0" encoding="UTF-8" ?><body><PirInfo version="1.1"><channelId>0</channelId>` +
  `<enable>0</enable><sensiValue>80</sensiValue><reduceFalseAlarm>0</reduceFalseAlarm>` +
  `<interval>5</interval><maxAlarmTime>${maxAlarmTime}</maxAlarmTime>` +
  `<intervalUseRange>1</intervalUseRange><intervalSecMin>5</intervalSecMin>` +
  `<intervalSecMax>120</intervalSecMax></PirInfo></body>`;

async function sentXml(reply: string): Promise<string> {
  const sendXml = vi.fn(async (p: { cmdId: number; payloadXml?: string }) =>
    p.cmdId === BC_CMD_ID_SET_PIR_INFO ? "" : reply,
  );
  const api = Object.create(ReolinkBaichuanApi.prototype);
  api.sendXml = sendXml;
  api.normalizeChannel = (c?: number) => c ?? 0;
  await api.setPirInfo(0, { enable: 1 });
  const call = sendXml.mock.calls.find((c) => c[0].cmdId === BC_CMD_ID_SET_PIR_INFO);
  return call?.[0].payloadXml ?? "";
}

describe("setPirInfo maxAlarmTime", () => {
  it("omits a garbage negative maxAlarmTime and leaves other fields", async () => {
    const xml = await sentXml(pirReply("-1672804292"));
    expect(xml).not.toContain("maxAlarmTime");
    expect(xml).toContain("<enable>1</enable>");
    expect(xml).toContain("<sensiValue>80</sensiValue>");
    expect(xml).toContain("<interval>5</interval>");
    expect(xml).toContain("<intervalUseRange>1</intervalUseRange>");
    expect(xml).toContain("<intervalSecMin>5</intervalSecMin>");
    expect(xml).toContain("<intervalSecMax>120</intervalSecMax>");
  });

  it("keeps a sane maxAlarmTime", async () => {
    const xml = await sentXml(pirReply("30"));
    expect(xml).toContain("<maxAlarmTime>30</maxAlarmTime>");
  });
});
