/**
 * cmd 272/273/274 `<findAlarmVideo>` — the alarm WINDOWS inside a camera's
 * recordings — against the official app captured 2026-09-20 on a standalone
 * E1 Outdoor PoE (v3.1.0.5223) and on a Reolink Home Hub (v3.3.0.456, child
 * channel 0). Fixtures under
 * `test/fixtures/recordings/{standalone,hub}/findalarmvideo-27*.xml`.
 *
 * Until now the command ids existed in `src/protocol/constants.ts` with
 * nothing reading them.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFindAlarmVideoExtensionXml,
  buildFindAlarmVideoOpenXml,
  buildFindAlarmVideoPageXml,
  DEFAULT_ALARM_VIDEO_SEARCH_ALARM_TYPES,
  DEFAULT_ALARM_VIDEO_SEARCH_EVENT_ALARM_TYPES,
  parseAlarmVideoPageXml,
  parseFindAlarmVideoHandle,
} from "../../src/reolink/baichuan/utils/alarmVideoSearch";
import {
  BC_CMD_ID_FIND_ALARM_VIDEO_CLOSE,
  BC_CMD_ID_FIND_ALARM_VIDEO_GET,
  BC_CMD_ID_FIND_ALARM_VIDEO_OPEN,
  BC_CMD_ID_FIND_EVENT_LOG_CLOSE,
  BC_CMD_ID_FIND_EVENT_LOG_GET,
  BC_CMD_ID_FIND_EVENT_LOG_OPEN,
  BC_CMD_ID_FIND_REC_VIDEO_CLOSE,
  BC_CMD_ID_FIND_REC_VIDEO_GET,
  BC_CMD_ID_FIND_REC_VIDEO_OPEN,
} from "../../src/protocol/constants";
import { dateFromWallClock } from "../../src/reolink/baichuan/utils/wallClock";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

const FIX = join(__dirname, "..", "fixtures", "recordings");
const read = (topology: "standalone" | "hub", name: string): string =>
  readFileSync(join(FIX, topology, name), "utf8");
const normalise = (xml: string): string => xml.replace(/\s+/g, "");

const TZ = "Europe/Rome";
const dayStart = (y: number, m: number, d: number): Date =>
  dateFromWallClock(
    { year: y, month: m, day: d, hour: 0, minute: 0, second: 0 },
    TZ,
  );
const dayEnd = (y: number, m: number, d: number): Date =>
  dateFromWallClock(
    { year: y, month: m, day: d, hour: 23, minute: 59, second: 59 },
    TZ,
  );

describe("buildFindAlarmVideoOpenXml reproduces the app's 272 open", () => {
  it("standalone, one local day — Extension and body both byte-identical", () => {
    const sent =
      buildFindAlarmVideoExtensionXml(0) +
      "\n" +
      buildFindAlarmVideoOpenXml({
        channel: 0,
        uid: "9527000STANDALON",
        start: dayStart(2026, 9, 20),
        end: dayEnd(2026, 9, 20),
        timeZone: TZ,
      });
    expect(normalise(sent)).toBe(
      normalise(read("standalone", "findalarmvideo-272-open-request.xml")),
    );
  });

  it("hub child channel 0, the child's UID", () => {
    const sent =
      buildFindAlarmVideoExtensionXml(0) +
      "\n" +
      buildFindAlarmVideoOpenXml({
        channel: 0,
        uid: "9527000HUBCHILD0",
        start: dayStart(2026, 9, 16),
        end: dayEnd(2026, 9, 16),
        timeZone: TZ,
      });
    expect(normalise(sent)).toBe(
      normalise(read("hub", "findalarmvideo-272-open-request.xml")),
    );
  });

  it("the two default filters are NOT the same set — the CSV has package, the item list has not", () => {
    const csv = DEFAULT_ALARM_VIDEO_SEARCH_ALARM_TYPES.split(",").map((t) =>
      t.trim(),
    );
    expect(csv).toHaveLength(17);
    expect(csv).toContain("package");
    expect(DEFAULT_ALARM_VIDEO_SEARCH_EVENT_ALARM_TYPES).toHaveLength(19);
    expect(DEFAULT_ALARM_VIDEO_SEARCH_EVENT_ALARM_TYPES).not.toContain(
      "package",
    );
    expect(DEFAULT_ALARM_VIDEO_SEARCH_EVENT_ALARM_TYPES).toContain(
      "nonmotorveh",
    );
  });

  it("an empty item list omits the element; a custom CSV is sent verbatim", () => {
    const xml = buildFindAlarmVideoOpenXml({
      channel: 1,
      uid: "u",
      start: dayStart(2026, 9, 20),
      end: dayEnd(2026, 9, 20),
      timeZone: TZ,
      alarmType: "people",
      eventAlarmTypes: [],
    });
    expect(xml).not.toContain("<eventAlarmType>");
    expect(xml).toContain("<alarmType>people</alarmType>");
    expect(xml).toContain("<channelId>1</channelId>");
  });

  it("streamType is numeric here, not the FileInfoList string", () => {
    const xml = buildFindAlarmVideoOpenXml({
      channel: 0,
      uid: "u",
      start: dayStart(2026, 9, 20),
      end: dayEnd(2026, 9, 20),
      timeZone: TZ,
      streamType: 1,
    });
    expect(xml).toContain("<streamType>1</streamType>");
    expect(xml).not.toContain("subStream");
  });
});

describe("buildFindAlarmVideoPageXml reproduces the 273 get AND the 274 close", () => {
  it("both requests are the same bytes in the capture", () => {
    const sent =
      buildFindAlarmVideoExtensionXml(0) +
      "\n" +
      buildFindAlarmVideoPageXml({ channel: 0, fileHandle: 2 });
    expect(normalise(sent)).toBe(
      normalise(read("standalone", "findalarmvideo-273-get-request.xml")),
    );
    expect(normalise(sent)).toBe(
      normalise(read("standalone", "findalarmvideo-274-close-request.xml")),
    );
  });
});

describe("parseFindAlarmVideoHandle", () => {
  it("standalone open answered fileHandle 2, hub open answered 4", () => {
    expect(
      parseFindAlarmVideoHandle(
        read("standalone", "findalarmvideo-272-open-response.xml"),
      ),
    ).toEqual({ channelId: 0, fileHandle: 2 });
    expect(
      parseFindAlarmVideoHandle(
        read("hub", "findalarmvideo-272-open-response.xml"),
      ),
    ).toEqual({ channelId: 0, fileHandle: 4 });
  });

  it("an empty body throws instead of reading as handle 0", () => {
    expect(() => parseFindAlarmVideoHandle("")).toThrow(/no <findAlarmVideo>/);
  });
});

describe("parseAlarmVideoPageXml on captured replies", () => {
  it("standalone first page: 30 windows, bFinished 0", () => {
    const page = parseAlarmVideoPageXml(
      read("standalone", "findalarmvideo-273-page1-response.xml"),
      { timeZone: TZ },
    );
    expect(page.channelId).toBe(0);
    expect(page.fileHandle).toBe(2);
    expect(page.finished).toBe(false);
    expect(page.windows).toHaveLength(30);
    const first = page.windows[0]!;
    expect(first.fileName).toBe("0120260920001819");
    expect(first.alarmType).toBe("md");
    expect(first.alarmTypes).toEqual(["md"]);
    expect(first.encrypted).toBe(false);
    expect(first.fileId).toBe("");
    expect(first.startTime).toEqual(
      dateFromWallClock(
        { year: 2026, month: 9, day: 20, hour: 0, minute: 18, second: 24 },
        TZ,
      ),
    );
    expect(first.endTime).toEqual(
      dateFromWallClock(
        { year: 2026, month: 9, day: 20, hour: 0, minute: 18, second: 34 },
        TZ,
      ),
    );
    // Standalone rows carry no per-child fields at all.
    expect(first.uid).toBeUndefined();
    expect(first.hasRecFile).toBeUndefined();
    expect(first.deleted).toBeUndefined();
  });

  it("standalone last page: 27 windows, bFinished 1", () => {
    const page = parseAlarmVideoPageXml(
      read("standalone", "findalarmvideo-273-lastpage-response.xml"),
      { timeZone: TZ },
    );
    expect(page.finished).toBe(true);
    expect(page.windows).toHaveLength(27);
  });

  it("several windows can name the SAME file — this is not a file listing", () => {
    const page = parseAlarmVideoPageXml(
      read("standalone", "findalarmvideo-273-page1-response.xml"),
      { timeZone: TZ },
    );
    const names = page.windows.map((w) => w.fileName);
    expect(new Set(names).size).toBeLessThan(names.length);
  });

  it("every window starts no earlier than it ends", () => {
    for (const name of [
      "findalarmvideo-273-page1-response.xml",
      "findalarmvideo-273-lastpage-response.xml",
    ]) {
      for (const w of parseAlarmVideoPageXml(read("standalone", name), {
        timeZone: TZ,
      }).windows) {
        expect(w.startTime!.getTime()).toBeLessThanOrEqual(
          w.endTime!.getTime(),
        );
      }
    }
  });

  it("fileName is the FileInfoList join key, and the window starts at or after the file does", () => {
    // `<fileName>` here has the same shape as a FileInfoList `<name>`
    // (`01` + YYYYMMDD + HHMMSS = the FILE's start), so the two surfaces
    // join on it. The window is inside the file, never before it.
    for (const w of parseAlarmVideoPageXml(
      read("standalone", "findalarmvideo-273-page1-response.xml"),
      { timeZone: TZ },
    ).windows) {
      expect(w.fileName).toMatch(/^\d{16}$/);
      const fileStart = dateFromWallClock(
        {
          year: Number(w.fileName.slice(2, 6)),
          month: Number(w.fileName.slice(6, 8)),
          day: Number(w.fileName.slice(8, 10)),
          hour: Number(w.fileName.slice(10, 12)),
          minute: Number(w.fileName.slice(12, 14)),
          second: Number(w.fileName.slice(14, 16)),
        },
        TZ,
      );
      expect(w.startTime!.getTime()).toBeGreaterThanOrEqual(
        fileStart.getTime(),
      );
    }
  });

  it("hub page carries the child's uid, logicChn, bHasRecFile and bDeleted", () => {
    const page = parseAlarmVideoPageXml(
      read("hub", "findalarmvideo-273-page-response.xml"),
      { timeZone: TZ },
    );
    expect(page.fileHandle).toBe(4);
    expect(page.finished).toBe(true);
    expect(page.windows).toHaveLength(29);
    const first = page.windows[0]!;
    expect(first.uid).toBe("9527000HUBCHILD0");
    expect(first.logicChn).toBe(0);
    expect(first.hasRecFile).toBe(true);
    expect(first.deleted).toBe(false);
    expect(first.alarmType).toBe("other");
  });

  it("alarmType is an OPEN vocabulary — a type no firmware has shipped comes through as itself", () => {
    const xml = read(
      "hub",
      "findalarmvideo-273-page-response.xml",
    ).replace("<alarmType>other</alarmType>", "<alarmType>forklift</alarmType>");
    const page = parseAlarmVideoPageXml(xml, { timeZone: TZ });
    expect(page.windows[0]!.alarmType).toBe("forklift");
    expect(page.windows[0]!.alarmTypes).toEqual(["forklift"]);
  });

  it("a comma-separated alarmType splits, and still keeps the raw string", () => {
    const xml = read(
      "hub",
      "findalarmvideo-273-page-response.xml",
    ).replace(
      "<alarmType>other</alarmType>",
      "<alarmType>people, dog_cat</alarmType>",
    );
    const w = parseAlarmVideoPageXml(xml, { timeZone: TZ }).windows[0]!;
    expect(w.alarmType).toBe("people, dog_cat");
    expect(w.alarmTypes).toEqual(["people", "dog_cat"]);
  });

  it("a reply without the envelope throws instead of reading as an empty page", () => {
    expect(() => parseAlarmVideoPageXml("")).toThrow(/no <alarmVideoInfo>/);
  });
});

type XmlCall = {
  cmdId: number;
  channel?: number;
  extensionXml?: string;
  payloadXml?: string;
};

function makeApi(reply: (p: XmlCall, nth: number) => string): {
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
      return reply(p, calls.length - 1);
    });
  return { api, calls };
}

const apis: ReolinkBaichuanApi[] = [];
afterEach(async () => {
  for (const a of apis.splice(0)) await a.close();
});

describe("ReolinkBaichuanApi.searchAlarmVideos", () => {
  it("standalone: 114 → 272 open → 273 pages until bFinished → 274 close, 57 windows", async () => {
    let pages = 0;
    const { api, calls } = makeApi((p) => {
      if (p.cmdId === 114) return read("standalone", "getuid-114-response.xml");
      if (p.cmdId === 272)
        return read("standalone", "findalarmvideo-272-open-response.xml");
      if (p.cmdId === 273) {
        pages += 1;
        return read(
          "standalone",
          pages === 1
            ? "findalarmvideo-273-page1-response.xml"
            : "findalarmvideo-273-lastpage-response.xml",
        );
      }
      return "";
    });
    apis.push(api);
    api.setIsNvr(false);

    const windows = await api.searchAlarmVideos({
      start: dayStart(2026, 9, 20),
      end: dayEnd(2026, 9, 20),
      timeZone: TZ,
    });

    expect(calls.map((c) => c.cmdId)).toEqual([114, 272, 273, 273, 274]);
    expect(windows).toHaveLength(57);
    // The open reproduces the app's request, Extension included.
    expect(
      normalise((calls[1]!.extensionXml ?? "") + (calls[1]!.payloadXml ?? "")),
    ).toBe(
      normalise(read("standalone", "findalarmvideo-272-open-request.xml")),
    );
    // Get and close carry the SAME body, and the handle the open returned.
    for (const i of [2, 3, 4]) {
      expect(
        normalise(
          (calls[i]!.extensionXml ?? "") + (calls[i]!.payloadXml ?? ""),
        ),
      ).toBe(
        normalise(read("standalone", "findalarmvideo-273-get-request.xml")),
      );
    }
    // The channel travels in the Extension and the body, never as `channel`
    // (which would rewrite the frame header to channel+1).
    expect(calls.every((c) => c.channel === undefined)).toBe(true);
  });

  it("a window wider than one camera-local day is clamped to the start day", async () => {
    // Measured 2026-09-20: an 18→19 September window answered 462 windows,
    // ALL dated 18 September, on the standalone and on a hub child. The
    // firmware drops the rest, so the clamp happens where it is visible.
    const { api, calls } = makeApi((p) => {
      if (p.cmdId === 114) return read("standalone", "getuid-114-response.xml");
      if (p.cmdId === 272)
        return read("standalone", "findalarmvideo-272-open-response.xml");
      if (p.cmdId === 273)
        return read("standalone", "findalarmvideo-273-lastpage-response.xml");
      return "";
    });
    apis.push(api);
    api.setIsNvr(false);
    await api.searchAlarmVideos({
      start: dayStart(2026, 9, 18),
      end: dayEnd(2026, 9, 19),
      timeZone: TZ,
    });
    const open = calls[1]!.payloadXml ?? "";
    expect(open).toContain(
      "<startTime><year>2026</year><month>9</month><day>18</day><hour>0</hour>",
    );
    expect(open).toContain(
      "<endTime><year>2026</year><month>9</month><day>18</day><hour>23</hour><minute>59</minute><second>59</second>",
    );
  });

  it("the handle is closed even when a page throws", async () => {
    const { api, calls } = makeApi((p) => {
      if (p.cmdId === 114) return read("standalone", "getuid-114-response.xml");
      if (p.cmdId === 272)
        return read("standalone", "findalarmvideo-272-open-response.xml");
      if (p.cmdId === 273) throw new Error("socket died mid-page");
      return "";
    });
    apis.push(api);
    api.setIsNvr(false);
    await expect(
      api.searchAlarmVideos({
        start: dayStart(2026, 9, 20),
        end: dayEnd(2026, 9, 20),
        timeZone: TZ,
      }),
    ).rejects.toThrow(/socket died/);
    expect(calls.map((c) => c.cmdId)).toEqual([114, 272, 273, 274]);
  });

  it("a 400-with-empty-body on a page ends the search instead of failing it", async () => {
    const { api, calls } = makeApi((p) => {
      if (p.cmdId === 114) return read("standalone", "getuid-114-response.xml");
      if (p.cmdId === 272)
        return read("standalone", "findalarmvideo-272-open-response.xml");
      if (p.cmdId === 273) {
        throw new Error(
          "Baichuan request failed (responseCode 400, empty body). Possible causes: …",
        );
      }
      return "";
    });
    apis.push(api);
    api.setIsNvr(false);
    const windows = await api.searchAlarmVideos({
      start: dayStart(2026, 9, 20),
      end: dayEnd(2026, 9, 20),
      timeZone: TZ,
    });
    expect(windows).toEqual([]);
    expect(calls.map((c) => c.cmdId)).toEqual([114, 272, 273, 274]);
  });

  it("maxPages bounds a firmware that never sets bFinished 1", async () => {
    const neverFinished = read(
      "standalone",
      "findalarmvideo-273-page1-response.xml",
    );
    const { api, calls } = makeApi((p) => {
      if (p.cmdId === 114) return read("standalone", "getuid-114-response.xml");
      if (p.cmdId === 272)
        return read("standalone", "findalarmvideo-272-open-response.xml");
      if (p.cmdId === 273) return neverFinished;
      return "";
    });
    apis.push(api);
    api.setIsNvr(false);
    const windows = await api.searchAlarmVideos({
      start: dayStart(2026, 9, 20),
      end: dayEnd(2026, 9, 20),
      timeZone: TZ,
      maxPages: 3,
    });
    expect(windows).toHaveLength(90);
    expect(calls.filter((c) => c.cmdId === 273)).toHaveLength(3);
    expect(calls.at(-1)!.cmdId).toBe(274);
  });

  it("hub child: an explicit uid is used as given and the Extension names the channel", async () => {
    const { api, calls } = makeApi((p) => {
      if (p.cmdId === 272)
        return read("hub", "findalarmvideo-272-open-response.xml");
      if (p.cmdId === 273)
        return read("hub", "findalarmvideo-273-page-response.xml");
      return "";
    });
    apis.push(api);
    api.setIsNvr(true);
    const windows = await api.searchAlarmVideos({
      channel: 0,
      uid: "9527000HUBCHILD0",
      start: dayStart(2026, 9, 16),
      end: dayEnd(2026, 9, 16),
      timeZone: TZ,
    });
    expect(calls.map((c) => c.cmdId)).toEqual([272, 273, 274]);
    expect(
      normalise((calls[0]!.extensionXml ?? "") + (calls[0]!.payloadXml ?? "")),
    ).toBe(normalise(read("hub", "findalarmvideo-272-open-request.xml")));
    expect(windows).toHaveLength(29);
    expect(windows[0]!.uid).toBe("9527000HUBCHILD0");
    // The hub's open answered fileHandle 4, and the pages ask for 4.
    expect(calls[1]!.payloadXml).toContain("<fileHandle>4</fileHandle>");
  });
});

describe("the command ids are named after what the body actually is", () => {
  it("272/273/274 carry <findAlarmVideo>, and the old FIND_REC_VIDEO names still resolve", () => {
    expect(BC_CMD_ID_FIND_ALARM_VIDEO_OPEN).toBe(272);
    expect(BC_CMD_ID_FIND_ALARM_VIDEO_GET).toBe(273);
    expect(BC_CMD_ID_FIND_ALARM_VIDEO_CLOSE).toBe(274);
    // Renamed, with the old names kept as deprecated aliases — the repo did
    // the same for BC_CMD_ID_CMD_123 → BC_CMD_ID_REPLAY_SEEK.
    expect(BC_CMD_ID_FIND_REC_VIDEO_OPEN).toBe(BC_CMD_ID_FIND_ALARM_VIDEO_OPEN);
    expect(BC_CMD_ID_FIND_REC_VIDEO_GET).toBe(BC_CMD_ID_FIND_ALARM_VIDEO_GET);
    expect(BC_CMD_ID_FIND_REC_VIDEO_CLOSE).toBe(
      BC_CMD_ID_FIND_ALARM_VIDEO_CLOSE,
    );
    // The event-log family was already named for its body.
    expect(BC_CMD_ID_FIND_EVENT_LOG_OPEN).toBe(516);
    expect(BC_CMD_ID_FIND_EVENT_LOG_GET).toBe(517);
    expect(BC_CMD_ID_FIND_EVENT_LOG_CLOSE).toBe(518);
  });
});
