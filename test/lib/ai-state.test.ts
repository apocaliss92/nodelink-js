import { describe, it, expect, vi } from "vitest";
import { getAiStateViaGetAiAlarm } from "../../src/reolink/baichuan/utils/aiState";

const populatedAiDetectCfg = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<AiDetectCfg version="1.1">
<chn>0</chn>
<type>people</type>
<sensitivity>60</sensitivity>
<stayTime>0</stayTime>
<area>AAAA</area>
</AiDetectCfg>
</body>`;

describe("getAiStateViaGetAiAlarm — firmware-drift fix", () => {
  it("returns support=1 alarm_state=0 when any AI type response is valid", async () => {
    const sendXml = vi.fn().mockResolvedValue(populatedAiDetectCfg);
    const state = await getAiStateViaGetAiAlarm({ sendXml, channel: 0 });
    expect(state.support).toBe(1);
    expect(state.alarm_state).toBe(0); // push events drive the real state
    expect(state.channel).toBe(0);
    // Stops at the first successful probe
    expect(sendXml).toHaveBeenCalledTimes(1);
  });

  it("falls through all candidate types if every response is empty", async () => {
    const sendXml = vi.fn().mockResolvedValue("");
    await expect(
      getAiStateViaGetAiAlarm({ sendXml, channel: 0 }),
    ).rejects.toThrow();
    // 5 default types × 2 channelId-override attempts (with + without)
    expect(sendXml).toHaveBeenCalledTimes(10);
  });

  it("ignores non-AiDetectCfg responses and treats them as unsupported", async () => {
    const sendXml = vi
      .fn()
      .mockResolvedValueOnce("<?xml version=\"1.0\"?><body><Other/></body>")
      .mockResolvedValueOnce(populatedAiDetectCfg);
    const state = await getAiStateViaGetAiAlarm({
      sendXml,
      channel: 0,
      candidateTypes: ["face", "people"],
    });
    expect(state.support).toBe(1);
    expect(sendXml).toHaveBeenCalledTimes(2);
  });
});
