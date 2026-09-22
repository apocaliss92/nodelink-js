/**
 * cmd 516/517/518 `<findEventLog>` — the Home Hub's cross-channel event list
 * — against the official app captured 2026-09-20 on a Reolink Home Hub
 * v3.3.0.456 (three children), plus the standalone E1 Outdoor PoE
 * (v3.1.0.5223) that answers the open with an EMPTY BODY. Fixtures under
 * `test/fixtures/recordings/{hub,standalone}/findeventlog-51*.xml`.
 *
 * Until now the command ids existed in `src/protocol/constants.ts` with
 * nothing reading them.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFindEventLogCloseXml,
  buildFindEventLogGetXml,
  buildFindEventLogOpenXml,
  DEFAULT_EVENT_LOG_MAX_EVENT_COUNT,
  DEFAULT_EVENT_LOG_SEARCH_ALARM_TYPES,
  DEFAULT_EVENT_LOG_SEARCH_EVENT_ALARM_TYPES,
  parseEventLogPageXml,
  parseFindEventLogOpenXml,
} from "../../src/reolink/baichuan/utils/eventLogSearch";
import { dateFromWallClock } from "../../src/reolink/baichuan/utils/wallClock";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

const FIX = join(__dirname, "..", "fixtures", "recordings");
const read = (topology: "standalone" | "hub", name: string): string =>
  readFileSync(join(FIX, topology, name), "utf8");
const normalise = (xml: string): string => xml.replace(/\s+/g, "");

const TZ = "Europe/Rome";
const at = (
  y: number,
  m: number,
  d: number,
  hh = 0,
  mm = 0,
  ss = 0,
): Date =>
  dateFromWallClock(
    { year: y, month: m, day: d, hour: hh, minute: mm, second: ss },
    TZ,
  );

const THREE_CHILDREN = [
  { uid: "9527000HUBCHILD3" },
  { uid: "9527000HUBCHILD1" },
  { uid: "9527000HUBCHILD0" },
] as const;

describe("buildFindEventLogOpenXml reproduces the app's 516 open", () => {
  it("a three-day window, written BACKWARDS (newest first) with desc left at 0", () => {
    const xml = buildFindEventLogOpenXml({
      // The app wrote the later instant into <startTime>.
      startTime: at(2026, 9, 10, 23, 59, 59),
      endTime: at(2026, 9, 8),
      devices: THREE_CHILDREN,
      timeZone: TZ,
    });
    expect(normalise(xml)).toBe(
      normalise(read("hub", "findeventlog-516-open-request.xml")),
    );
    // What settles it: the ordering is NOT desc — desc is 0 here.
    expect(xml).toContain("<desc>0</desc>");
    // And the channel selection is NOT chnbits — it is <devices>, while
    // chnbits stays 0 with three children selected.
    expect(xml).toContain("<chnbits>0</chnbits>");
    expect(xml.match(/<deviceInfo>/g)).toHaveLength(3);
  });

  it("the app's 'all history' variant ends at the epoch — 1 Jan 1970 01:00 in the hub's zone", () => {
    const xml = buildFindEventLogOpenXml({
      startTime: at(2026, 9, 20, 23, 59, 59),
      endTime: new Date(0),
      devices: THREE_CHILDREN,
      timeZone: TZ,
    });
    expect(normalise(xml)).toBe(
      normalise(read("hub", "findeventlog-516-open-allhistory-request.xml")),
    );
  });

  it("no Extension is involved: the open is a body-only command", () => {
    const xml = buildFindEventLogOpenXml({
      startTime: at(2026, 9, 10, 23, 59, 59),
      endTime: at(2026, 9, 8),
      devices: THREE_CHILDREN,
      timeZone: TZ,
    });
    expect(xml).not.toContain("<Extension");
    expect(xml).not.toContain("<channelId>");
  });

  it("the CSV and the item list hold the same six types in a different order", () => {
    expect(DEFAULT_EVENT_LOG_SEARCH_ALARM_TYPES.split(",")).toEqual([
      "md",
      "people",
      "vehicle",
      "dog_cat",
      "visitor",
      "package",
    ]);
    expect(DEFAULT_EVENT_LOG_SEARCH_EVENT_ALARM_TYPES).toEqual([
      "md",
      "package",
      "people",
      "vehicle",
      "dog_cat",
      "visitor",
    ]);
  });

  it("logicChnBitmap defaults to 3 and can be overridden per device", () => {
    const xml = buildFindEventLogOpenXml({
      startTime: at(2026, 9, 10),
      endTime: at(2026, 9, 8),
      devices: [{ uid: "a" }, { uid: "b", logicChnBitmap: 1 }],
      timeZone: TZ,
    });
    expect(xml).toContain("<uid>a</uid>\n<logicChnBitmap>3</logicChnBitmap>");
    expect(xml).toContain("<uid>b</uid>\n<logicChnBitmap>1</logicChnBitmap>");
  });

  it("refuses an empty device list — the search has nothing to select", () => {
    expect(() =>
      buildFindEventLogOpenXml({
        startTime: at(2026, 9, 10),
        endTime: at(2026, 9, 8),
        devices: [],
      }),
    ).toThrow(RangeError);
  });
});

describe("buildFindEventLogGetXml / CloseXml", () => {
  it("the get carries handle AND maxEventCount, the close only the handle", () => {
    expect(
      normalise(buildFindEventLogGetXml({ handle: 0, maxEventCount: 60 })),
    ).toBe(normalise(read("hub", "findeventlog-517-get-request.xml")));
    expect(normalise(buildFindEventLogCloseXml({ handle: 0 }))).toBe(
      normalise(read("hub", "findeventlog-518-close-request.xml")),
    );
  });
});

describe("parseFindEventLogOpenXml", () => {
  it("the hub answered handle 0 and granted 60 rows a page", () => {
    expect(
      parseFindEventLogOpenXml(
        read("hub", "findeventlog-516-open-response.xml"),
      ),
    ).toEqual({ handle: 0, maxEventCount: DEFAULT_EVENT_LOG_MAX_EVENT_COUNT });
  });

  it("the standalone's EMPTY body is a refusal, not an empty result", () => {
    const body = read("standalone", "findeventlog-516-open-response.xml");
    expect(body).toBe("");
    expect(() => parseFindEventLogOpenXml(body)).toThrow(/Hub-only/);
  });
});

describe("parseEventLogPageXml on the captured reply", () => {
  it("60 rows across three children, newest first, bFinished 0", () => {
    const page = parseEventLogPageXml(
      read("hub", "findeventlog-517-page-response.xml"),
      { timeZone: TZ },
    );
    expect(page.finished).toBe(false);
    expect(page.events).toHaveLength(60);
    // The reply's handle is 1 while the request asked with 0 — recorded,
    // not used for paging (only one get was ever captured).
    expect(page.handle).toBe(1);

    const first = page.events[0]!;
    expect(first).toMatchObject({
      uid: "9527000HUBCHILD1",
      logicChn: 0,
      hasRecFile: true,
      encrypted: false,
      deleted: false,
      alarmType: "people",
    });
    expect(first.startTime).toEqual(at(2026, 9, 10, 21, 0, 2));
    expect(first.endTime).toEqual(at(2026, 9, 10, 21, 0, 22));

    // Descending: every row starts no later than the one before it.
    const starts = page.events.map((e) => e.startTime!.getTime());
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]!).toBeLessThanOrEqual(starts[i - 1]!);
    }
    // And the window the request asked for is respected on both ends.
    expect(Math.max(...starts)).toBeLessThanOrEqual(
      at(2026, 9, 10, 23, 59, 59).getTime(),
    );
    expect(Math.min(...starts)).toBeGreaterThanOrEqual(at(2026, 9, 8).getTime());
  });

  it("one search really does span every child — three UIDs in one page", () => {
    const page = parseEventLogPageXml(
      read("hub", "findeventlog-517-page-response.xml"),
      { timeZone: TZ },
    );
    expect(new Set(page.events.map((e) => e.uid))).toEqual(
      new Set([
        "9527000HUBCHILD0",
        "9527000HUBCHILD1",
        "9527000HUBCHILD3",
      ]),
    );
  });

  it("an event is NOT a promise of a clip: 12 of the 60 rows have no recording file", () => {
    const page = parseEventLogPageXml(
      read("hub", "findeventlog-517-page-response.xml"),
      { timeZone: TZ },
    );
    expect(page.events.filter((e) => !e.hasRecFile)).toHaveLength(12);
  });

  it("every row carries a class — the reason this beats the file listing", () => {
    const page = parseEventLogPageXml(
      read("hub", "findeventlog-517-page-response.xml"),
      { timeZone: TZ },
    );
    expect(page.events.every((e) => e.alarmType.length > 0)).toBe(true);
    expect(new Set(page.events.map((e) => e.alarmType))).toEqual(
      new Set(["md", "people", "dog_cat"]),
    );
  });

  it("alarmType is an OPEN vocabulary", () => {
    const xml = read("hub", "findeventlog-517-page-response.xml").replace(
      "<alarmType>people</alarmType>",
      "<alarmType>forklift</alarmType>",
    );
    const page = parseEventLogPageXml(xml, { timeZone: TZ });
    expect(page.events[0]!.alarmType).toBe("forklift");
    expect(page.events[0]!.alarmTypes).toEqual(["forklift"]);
  });

  it("a reply without the envelope throws instead of reading as an empty page", () => {
    expect(() => parseEventLogPageXml("")).toThrow(/no <eventLogInfo>/);
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

const PAGE = read("hub", "findeventlog-517-page-response.xml");
/**
 * A second page of 60 rows that are genuinely DIFFERENT rows (a child the
 * first page does not carry), so paging is visible through the dedupe the
 * device's repeated rows made necessary.
 */
const pageForChild = (n: number, finished: boolean): string =>
  PAGE.replaceAll(/<uid>9527000HUBCHILD\d<\/uid>/g, `<uid>952700HUBCHILD${n}X</uid>`).replace(
    "<bFinished>0</bFinished>",
    `<bFinished>${finished ? 1 : 0}</bFinished>`,
  );
const LAST_PAGE = pageForChild(7, true);

describe("ReolinkBaichuanApi.searchEventLog", () => {
  it("hub: 516 open → 517 pages until bFinished → 518 close, and the window is written newest-first", async () => {
    let pages = 0;
    const { api, calls } = makeApi((p) => {
      if (p.cmdId === 516)
        return read("hub", "findeventlog-516-open-response.xml");
      if (p.cmdId === 517) {
        pages += 1;
        return pages === 1
          ? read("hub", "findeventlog-517-page-response.xml")
          : LAST_PAGE;
      }
      return "";
    });
    apis.push(api);
    api.setIsNvr(true);

    const events = await api.searchEventLog({
      devices: THREE_CHILDREN,
      // The caller thinks forwards; the wire is written backwards.
      start: at(2026, 9, 8),
      end: at(2026, 9, 10, 23, 59, 59),
      timeZone: TZ,
    });

    expect(calls.map((c) => c.cmdId)).toEqual([516, 517, 517, 518]);
    expect(events).toHaveLength(120);
    expect(normalise(calls[0]!.payloadXml ?? "")).toBe(
      normalise(read("hub", "findeventlog-516-open-request.xml")),
    );
    expect(normalise(calls[1]!.payloadXml ?? "")).toBe(
      normalise(read("hub", "findeventlog-517-get-request.xml")),
    );
    expect(normalise(calls[3]!.payloadXml ?? "")).toBe(
      normalise(read("hub", "findeventlog-518-close-request.xml")),
    );
    // No Extension, and no `channel` — none of the three is channel-scoped.
    expect(
      calls.every(
        (c) => c.extensionXml === undefined && c.channel === undefined,
      ),
    ).toBe(true);
  });

  it("the window is ALWAYS written backwards — a forward one answered 0 rows live", async () => {
    const { api, calls } = makeApi((p) =>
      p.cmdId === 516 ? read("hub", "findeventlog-516-open-response.xml") : "",
    );
    apis.push(api);
    api.setIsNvr(true);
    await api.searchEventLog({
      devices: [{ uid: "9527000HUBCHILD0" }],
      start: at(2026, 9, 8),
      end: at(2026, 9, 10, 23, 59, 59),
      timeZone: TZ,
      maxPages: 0,
    });
    const open = calls[0]!.payloadXml ?? "";
    // <startTime> is the LATER instant the caller passed as `end`.
    expect(open).toContain(
      "<startTime><year>2026</year><month>9</month><day>10</day><hour>23</hour>",
    );
    expect(open).toContain(
      "<endTime><year>2026</year><month>9</month><day>8</day><hour>0</hour>",
    );
  });

  it("rows repeated across a page boundary are deduped, and the device's order is kept", async () => {
    // Measured on the hub: 5 of 1 886 rows came back twice across ~32 page
    // boundaries, and the merge is not perfectly monotonic at a boundary.
    const page = read("hub", "findeventlog-517-page-response.xml");
    let n = 0;
    const { api } = makeApi((p) => {
      if (p.cmdId === 516)
        return read("hub", "findeventlog-516-open-response.xml");
      if (p.cmdId === 517) {
        n += 1;
        // The SAME page twice: every row of the second is a repeat.
        return n === 1 ? page : page.replace("<bFinished>0<", "<bFinished>1<");
      }
      return "";
    });
    apis.push(api);
    api.setIsNvr(true);
    const events = await api.searchEventLog({
      devices: THREE_CHILDREN,
      start: at(2026, 9, 8),
      end: at(2026, 9, 10, 23, 59, 59),
      timeZone: TZ,
    });
    expect(events).toHaveLength(60);
    expect(events[0]!.uid).toBe("9527000HUBCHILD1");
  });

  it("a standalone's empty-body answer is refused by name, and no handle is left open", async () => {
    const { api, calls } = makeApi(() =>
      read("standalone", "findeventlog-516-open-response.xml"),
    );
    apis.push(api);
    api.setIsNvr(false);
    await expect(
      api.searchEventLog({
        devices: [{ uid: "9527000STANDALON" }],
        start: at(2026, 9, 20),
        end: at(2026, 9, 20, 23, 59, 59),
        timeZone: TZ,
      }),
    ).rejects.toThrow(/Hub-only/);
    // Nothing was opened, so nothing is closed.
    expect(calls.map((c) => c.cmdId)).toEqual([516]);
  });

  it("the handle is closed even when a page throws", async () => {
    const { api, calls } = makeApi((p) => {
      if (p.cmdId === 516)
        return read("hub", "findeventlog-516-open-response.xml");
      if (p.cmdId === 517) throw new Error("socket died mid-page");
      return "";
    });
    apis.push(api);
    api.setIsNvr(true);
    await expect(
      api.searchEventLog({
        devices: THREE_CHILDREN,
        start: at(2026, 9, 8),
        end: at(2026, 9, 10, 23, 59, 59),
        timeZone: TZ,
      }),
    ).rejects.toThrow(/socket died/);
    expect(calls.map((c) => c.cmdId)).toEqual([516, 517, 518]);
  });

  it("maxPages bounds a firmware that never sets bFinished 1", async () => {
    let seq = 0;
    const { api, calls } = makeApi((p) => {
      if (p.cmdId === 516)
        return read("hub", "findeventlog-516-open-response.xml");
      if (p.cmdId === 517) {
        seq += 1;
        return pageForChild(seq, false);
      }
      return "";
    });
    apis.push(api);
    api.setIsNvr(true);
    const events = await api.searchEventLog({
      devices: THREE_CHILDREN,
      start: at(2026, 9, 8),
      end: at(2026, 9, 10, 23, 59, 59),
      timeZone: TZ,
      maxPages: 2,
    });
    expect(events).toHaveLength(120);
    expect(calls.filter((c) => c.cmdId === 517)).toHaveLength(2);
  });

  it("maxEventCount is asked for on every page when the caller pins it", async () => {
    const { api, calls } = makeApi((p) => {
      if (p.cmdId === 516)
        return read("hub", "findeventlog-516-open-response.xml");
      if (p.cmdId === 517) return LAST_PAGE;
      return "";
    });
    apis.push(api);
    api.setIsNvr(true);
    await api.searchEventLog({
      devices: THREE_CHILDREN,
      start: at(2026, 9, 8),
      end: at(2026, 9, 10, 23, 59, 59),
      timeZone: TZ,
      maxEventCount: 10,
    });
    expect(calls[1]!.payloadXml).toContain("<maxEventCount>10</maxEventCount>");
  });

  it("with no devices and an empty push cache, nothing is sent at all", async () => {
    const { api, calls } = makeApi(() => "");
    apis.push(api);
    api.setIsNvr(true);
    await expect(
      api.searchEventLog({
        start: at(2026, 9, 8),
        end: at(2026, 9, 10, 23, 59, 59),
        timeZone: TZ,
      }),
    ).rejects.toThrow(/no devices to search/);
    expect(calls).toEqual([]);
  });
});
