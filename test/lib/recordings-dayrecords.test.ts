/**
 * cmd 142 `<DayRecords>` — the recording calendar — against the official
 * app captured 2026-09-20 on a standalone E1 Outdoor PoE (v3.1.0.5223) and
 * on a Reolink Home Hub (v3.3.0.456, child channel 0), plus the same call
 * verified live on hub channels 0/1/3, three channels in one request, and a
 * request whose UID and channel disagree. Fixtures under
 * `test/fixtures/recordings/{standalone,hub}/dayrecords-142-*.xml`.
 *
 * Until 0.7.8 the library sent cmd 142 with no body and got
 * `responseCode 400, empty body` on both topologies. The body is a calendar
 * month plus one `<DayRecord>` (channel + uid) per camera.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDayRecordsXml,
  daysInMonth,
  parseDayRecordsXml,
} from "../../src/reolink/baichuan/utils/dayRecords";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

const FIX = join(__dirname, "..", "fixtures", "recordings");
const read = (topology: "standalone" | "hub", name: string): string =>
  readFileSync(join(FIX, topology, name), "utf8");
const normalise = (xml: string): string => xml.replace(/\s+/g, "");
const range = (a: number, b: number): number[] =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe("daysInMonth", () => {
  it("knows month lengths and leap years", () => {
    expect(daysInMonth(2026, 9)).toBe(30);
    expect(daysInMonth(2026, 8)).toBe(31);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
  });
});

describe("buildDayRecordsXml reproduces the app's requests", () => {
  it("standalone, September (30 days)", () => {
    const xml = buildDayRecordsXml({
      year: 2026,
      month: 9,
      entries: [{ channel: 0, uid: "9527000STANDALON" }],
    });
    expect(normalise(xml)).toBe(
      normalise(read("standalone", "dayrecords-142-request.xml")),
    );
  });

  it("standalone, August (31 days) — the calendar's previous month", () => {
    const xml = buildDayRecordsXml({
      year: 2026,
      month: 8,
      entries: [{ channel: 0, uid: "9527000STANDALON" }],
    });
    expect(normalise(xml)).toBe(
      normalise(read("standalone", "dayrecords-142-emptymonth-request.xml")),
    );
  });

  it("hub child channel 0, the child's UID", () => {
    const xml = buildDayRecordsXml({
      year: 2026,
      month: 9,
      entries: [{ channel: 0, uid: "9527000HUBCHILD0" }],
    });
    expect(normalise(xml)).toBe(
      normalise(read("hub", "dayrecords-142-ch0-request.xml")),
    );
  });

  it("three hub channels in one request (verified live)", () => {
    const xml = buildDayRecordsXml({
      year: 2026,
      month: 9,
      entries: [
        { channel: 0, uid: "9527000HUBCHILD0" },
        { channel: 1, uid: "9527000HUBCHILD1" },
        { channel: 3, uid: "9527000HUBCHILD3" },
      ],
    });
    expect(normalise(xml)).toBe(
      normalise(read("hub", "dayrecords-142-batch-request.xml")),
    );
  });

  it("refuses an impossible month or an empty entry list", () => {
    expect(() =>
      buildDayRecordsXml({
        year: 2026,
        month: 13,
        entries: [{ channel: 0, uid: "x" }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      buildDayRecordsXml({ year: 2026, month: 9, entries: [] }),
    ).toThrow(RangeError);
  });
});

describe("parseDayRecordsXml on captured replies", () => {
  it("standalone September: days 2..20 (1 September had nothing)", () => {
    const r = parseDayRecordsXml(
      read("standalone", "dayrecords-142-response.xml"),
    );
    expect(r.year).toBe(2026);
    expect(r.month).toBe(9);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]!.channelId).toBe(0);
    expect(r.records[0]!.days.map((d) => d.day)).toEqual(range(2, 20));
    expect(new Set(r.records[0]!.days.map((d) => d.type))).toEqual(
      new Set(["normal"]),
    );
  });

  it("hub child channel 0 September: days 1..11 and 13..19 (12 September had nothing)", () => {
    const r = parseDayRecordsXml(
      read("hub", "dayrecords-142-ch0-response.xml"),
    );
    expect(r.records[0]!.days.map((d) => d.day)).toEqual([
      ...range(1, 11),
      ...range(13, 19),
    ]);
  });

  it("an empty month is an empty list, not an error", () => {
    const r = parseDayRecordsXml(
      read("standalone", "dayrecords-142-emptymonth-response.xml"),
    );
    expect(r.month).toBe(8);
    expect(r.records).toEqual([{ index: 0, channelId: 0, days: [] }]);
  });

  it("hub child channel 3: a sparse month", () => {
    const r = parseDayRecordsXml(
      read("hub", "dayrecords-142-ch3-response.xml"),
    );
    expect(r.records[0]!.channelId).toBe(3);
    expect(r.records[0]!.days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 7, 9]);
  });

  it("three channels in one reply come back as three records, in request order", () => {
    const r = parseDayRecordsXml(
      read("hub", "dayrecords-142-batch-response.xml"),
    );
    expect(r.records.map((x) => [x.index, x.channelId])).toEqual([
      [0, 0],
      [1, 1],
      [2, 3],
    ]);
    expect(r.records[0]!.days.map((d) => d.day)).toEqual([
      ...range(1, 11),
      ...range(13, 19),
    ]);
    expect(r.records[2]!.days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 7, 9]);
  });

  it("on a hub the UID selects the camera: channel 1 asked with channel 0's UID answers channel 0's days", () => {
    const r = parseDayRecordsXml(
      read("hub", "dayrecords-142-uid-selects-response.xml"),
    );
    expect(r.records[0]!.channelId).toBe(1); // echoed
    expect(r.records[0]!.days.map((d) => d.day)).toEqual([
      ...range(1, 11),
      ...range(13, 19),
    ]); // channel 0's
  });

  it("`type` is an open vocabulary", () => {
    const xml = read(
      "standalone",
      "dayrecords-142-emptymonth-response.xml",
    ).replace(
      /<dayTypeList\s*\/>/,
      "<dayTypeList><dayType><index>4</index><type>alarm</type></dayType><dayType><index>0</index><type>sched</type></dayType></dayTypeList>",
    );
    expect(xml).toContain("<type>alarm</type>");
    expect(parseDayRecordsXml(xml).records[0]!.days).toEqual([
      { day: 1, type: "sched" },
      { day: 5, type: "alarm" },
    ]);
  });

  it("a reply without the envelope (the pre-0.7.8 400) throws instead of reading as an empty month", () => {
    expect(() => parseDayRecordsXml("")).toThrow(/no <DayRecords>/);
  });
});

type XmlCall = {
  cmdId: number;
  channel?: number;
  extensionXml?: string;
  payloadXml?: string;
};

function makeApi(reply: (p: XmlCall) => string): {
  api: ReolinkBaichuanApi;
  calls: XmlCall[];
} {
  const api = new ReolinkBaichuanApi({
    host: "127.0.0.1",
    port: 65535,
    username: "u",
    password: "p",
    transport: "tcp",
    nativeOnly: true,
  });
  const calls: XmlCall[] = [];
  (api as unknown as { sendXml: (p: XmlCall) => Promise<string> }).sendXml =
    vi.fn(async (p: XmlCall) => {
      calls.push(p);
      return reply(p);
    });
  return { api, calls };
}

const apis: ReolinkBaichuanApi[] = [];
afterEach(async () => {
  for (const a of apis.splice(0)) await a.close();
});

describe("ReolinkBaichuanApi.getDayRecords", () => {
  it("standalone: discovers the UID with cmd 114, sends the month body with no channel and no Extension", async () => {
    const { api, calls } = makeApi((p) =>
      p.cmdId === 114
        ? read("standalone", "getuid-114-response.xml")
        : read("standalone", "dayrecords-142-response.xml"),
    );
    apis.push(api);
    api.setIsNvr(false);
    const r = await api.getDayRecords({ year: 2026, month: 9 });
    expect(calls.map((c) => c.cmdId)).toEqual([114, 142]);
    const req = calls[1]!;
    expect(req.channel).toBeUndefined();
    expect(req.extensionXml).toBeUndefined();
    expect(normalise(req.payloadXml ?? "")).toBe(
      normalise(read("standalone", "dayrecords-142-request.xml")),
    );
    expect(r.channelId).toBe(0);
    expect(r.days.map((d) => d.day)).toEqual(range(2, 20));
  });

  it("hub child: an explicit uid is used as given", async () => {
    const { api, calls } = makeApi(() =>
      read("hub", "dayrecords-142-ch3-response.xml"),
    );
    apis.push(api);
    api.setIsNvr(true);
    const r = await api.getDayRecords({
      channel: 3,
      uid: "9527000HUBCHILD3",
      year: 2026,
      month: 9,
    });
    expect(calls.map((c) => c.cmdId)).toEqual([142]);
    expect(calls[0]!.payloadXml).toContain("<uid>9527000HUBCHILD3</uid>");
    expect(r.days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 7, 9]);
  });

  it("hub child without a UID is refused before anything is sent", async () => {
    const { api, calls } = makeApi(() => "");
    apis.push(api);
    api.setIsNvr(true);
    await expect(
      api.getDayRecords({ channel: 3, year: 2026, month: 9 }),
    ).rejects.toThrow(/UID is required/);
    expect(calls).toEqual([]);
  });

  it("getDayRecordsForChannels asks several channels in one request and keys the answer by channel", async () => {
    const { api, calls } = makeApi(() =>
      read("hub", "dayrecords-142-batch-response.xml"),
    );
    apis.push(api);
    api.setIsNvr(true);
    const r = await api.getDayRecordsForChannels({
      year: 2026,
      month: 9,
      entries: [
        { channel: 0, uid: "9527000HUBCHILD0" },
        { channel: 1, uid: "9527000HUBCHILD1" },
        { channel: 3, uid: "9527000HUBCHILD3" },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(normalise(calls[0]!.payloadXml ?? "")).toBe(
      normalise(read("hub", "dayrecords-142-batch-request.xml")),
    );
    expect([...r.keys()]).toEqual([0, 1, 3]);
    expect(r.get(3)!.days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 7, 9]);
  });
});
