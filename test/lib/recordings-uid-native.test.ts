/**
 * Native-only recordings need a UID in every FileInfoList request. Until
 * 0.7.8 `ensureUidForRecordings` threw in `nativeOnly` mode unless the caller
 * passed one or the cmd 145 push (NVR only) had arrived — even though a
 * standalone camera answers cmd 114 `GetUid` in one round-trip (7 ms, E1
 * Outdoor PoE v3.1.0.5223, 2026-09-20). Fixtures: the captured cmd 114 reply
 * and the captured FileInfoList exchange.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { dateFromWallClock } from "../../src/reolink/baichuan/utils/wallClock";

const FIX = join(__dirname, "..", "fixtures", "recordings", "standalone");
const read = (name: string): string => readFileSync(join(FIX, name), "utf8");

type XmlCall = { cmdId: number; channel?: number; payloadXml?: string };

function makeApi(): { api: ReolinkBaichuanApi; calls: XmlCall[] } {
  const api = new ReolinkBaichuanApi({
    host: "127.0.0.1",
    port: 65535,
    username: "u",
    password: "p",
    transport: "tcp",
    nativeOnly: true,
  });
  const calls: XmlCall[] = [];
  const page1 = read("fileinfolist-15-page1-response.xml");
  const shortPage = `<?xml version="1.0" encoding="UTF-8" ?><body><FileInfoList version="1.1">${(page1.match(/<FileInfo>[\s\S]*?<\/FileInfo>/g) ?? []).slice(0, 3).join("")}</FileInfoList></body>`;
  (api as unknown as { sendXml: (p: XmlCall) => Promise<string> }).sendXml =
    vi.fn(async (p: XmlCall) => {
      calls.push(p);
      switch (p.cmdId) {
        case 114:
          return read("getuid-114-response.xml");
        case 14:
          return read("fileinfolist-14-open-response.xml");
        case 15:
          return calls.filter((c) => c.cmdId === 15).length === 1
            ? page1
            : shortPage;
        default:
          return "";
      }
    });
  return { api, calls };
}

const ROME = "Europe/Rome";
const start = dateFromWallClock(
  { year: 2026, month: 9, day: 19, hour: 0, minute: 0, second: 0 },
  ROME,
);
const end = dateFromWallClock(
  { year: 2026, month: 9, day: 19, hour: 23, minute: 59, second: 59 },
  ROME,
);

const apis: ReolinkBaichuanApi[] = [];
afterEach(async () => {
  for (const a of apis.splice(0)) await a.close();
});

describe("ensureUidForRecordings in native-only mode", () => {
  it("standalone: discovers the UID with cmd 114 once and lists with it", async () => {
    const { api, calls } = makeApi();
    apis.push(api);
    api.setIsNvr(false);

    const files = await api.getVideoclips({
      channel: 0,
      start,
      end,
      timeZone: ROME,
    });
    expect(files).toHaveLength(40);
    expect(calls.map((c) => c.cmdId)).toEqual([114, 14, 15, 15, 16]);
    expect(calls.find((c) => c.cmdId === 14)?.payloadXml).toContain(
      "<uid>9527000STANDALON</uid>",
    );

    // Second call: the UID is cached, cmd 114 is not repeated.
    await api.getVideoclips({ channel: 0, start, end, timeZone: ROME });
    expect(calls.filter((c) => c.cmdId === 114)).toHaveLength(1);
  });

  it("NVR/Hub: cmd 114 is never used for a child channel; the request is refused", async () => {
    const { api, calls } = makeApi();
    apis.push(api);
    api.setIsNvr(true);

    await expect(
      api.getVideoclips({ channel: 3, start, end, timeZone: ROME }),
    ).rejects.toThrow(/UID is required/);
    expect(calls.map((c) => c.cmdId)).toEqual([]);
  });

  it("an explicit uid wins and cmd 114 is not sent", async () => {
    const { api, calls } = makeApi();
    apis.push(api);
    api.setIsNvr(false);
    await api.getVideoclips({
      channel: 0,
      uid: "9527000EXPLICIT0",
      start,
      end,
      timeZone: ROME,
    });
    expect(calls.map((c) => c.cmdId)).toEqual([14, 15, 15, 16]);
    expect(calls[0]!.payloadXml).toContain("<uid>9527000EXPLICIT0</uid>");
  });

  it("the search window is one CAMERA-local day: `end` is clamped to 23:59:59.999 in the zone", async () => {
    const { api, calls } = makeApi();
    apis.push(api);
    api.setIsNvr(false);
    // Ask for three days in Asia/Kolkata; the request must end on the first day.
    const s = dateFromWallClock(
      { year: 2026, month: 9, day: 19, hour: 6, minute: 0, second: 0 },
      "Asia/Kolkata",
    );
    const e = new Date(s.getTime() + 3 * 86_400_000);
    await api.getVideoclips({
      channel: 0,
      uid: "9527000STANDALON",
      start: s,
      end: e,
      timeZone: "Asia/Kolkata",
    });
    const open =
      calls.find((c) => c.cmdId === 14)?.payloadXml?.replace(/\s+/g, "") ?? "";
    expect(open).toContain(
      "<startTime><year>2026</year><month>9</month><day>19</day><hour>6</hour><minute>0</minute><second>0</second></startTime>",
    );
    expect(open).toContain(
      "<endTime><year>2026</year><month>9</month><day>19</day><hour>23</hour><minute>59</minute><second>59</second></endTime>",
    );
  });
});
