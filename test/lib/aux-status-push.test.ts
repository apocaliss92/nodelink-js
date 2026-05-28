import { describe, it, expect } from "vitest";
import { parseFloodlightStatusListPushXml } from "../../src/reolink/baichuan/utils/whiteLedStatusPush";
import { parseSirenStatusListPushXml } from "../../src/reolink/baichuan/utils/sirenStatusPush";

describe("parseFloodlightStatusListPushXml (cmd 291)", () => {
  it("parses a single-channel ON push", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<FloodlightStatusList>
<channel>0</channel>
<status>1</status>
</FloodlightStatusList>
</body>`;
    expect(parseFloodlightStatusListPushXml(xml)).toEqual([
      { channel: 0, status: 1 },
    ]);
  });

  it("parses OFF transition", () => {
    const xml = `<FloodlightStatusList><channel>0</channel><status>0</status></FloodlightStatusList>`;
    expect(parseFloodlightStatusListPushXml(xml)).toEqual([
      { channel: 0, status: 0 },
    ]);
  });

  it("parses multi-channel payload (NVR)", () => {
    const xml = `<FloodlightStatusList>
<item><channel>0</channel><status>1</status></item>
<item><channel>1</channel><status>0</status></item>
<item><channel>2</channel><status>1</status></item>
</FloodlightStatusList>`;
    expect(parseFloodlightStatusListPushXml(xml)).toEqual([
      { channel: 0, status: 1 },
      { channel: 1, status: 0 },
      { channel: 2, status: 1 },
    ]);
  });

  it("returns empty array for unrelated XML", () => {
    expect(parseFloodlightStatusListPushXml("<other/>")).toEqual([]);
    expect(parseFloodlightStatusListPushXml("")).toEqual([]);
  });
});

describe("parseSirenStatusListPushXml (cmd 547)", () => {
  it("parses a single-channel ON push with channelId", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<SirenStatusList>
<channelId>0</channelId>
<status>1</status>
<playing>1</playing>
</SirenStatusList>
</body>`;
    expect(parseSirenStatusListPushXml(xml)).toEqual([
      { channel: 0, status: 1, playing: 1 },
    ]);
  });

  it("parses OFF transition without playing tag", () => {
    const xml = `<SirenStatusList><channelId>0</channelId><status>0</status></SirenStatusList>`;
    expect(parseSirenStatusListPushXml(xml)).toEqual([
      { channel: 0, status: 0 },
    ]);
  });

  it("tolerates legacy <channel> tag", () => {
    const xml = `<SirenStatusList><channel>1</channel><status>1</status></SirenStatusList>`;
    expect(parseSirenStatusListPushXml(xml)).toEqual([
      { channel: 1, status: 1 },
    ]);
  });

  it("parses multi-channel payload", () => {
    const xml = `<SirenStatusList>
<item><channelId>0</channelId><status>1</status><playing>1</playing></item>
<item><channelId>1</channelId><status>0</status><playing>0</playing></item>
</SirenStatusList>`;
    expect(parseSirenStatusListPushXml(xml)).toEqual([
      { channel: 0, status: 1, playing: 1 },
      { channel: 1, status: 0, playing: 0 },
    ]);
  });

  it("returns empty array for unrelated XML", () => {
    expect(parseSirenStatusListPushXml("<other/>")).toEqual([]);
    expect(parseSirenStatusListPushXml("")).toEqual([]);
  });
});
