/**
 * FileInfoList (cmd 14 open / 15 page / 16 close) against the wire captured
 * 2026-09-20 from an E1 Outdoor PoE (v3.1.0.5223, standalone, ch 0) and a
 * Reolink Home Hub (v3.3.0.456, child ch 1). Fixtures under
 * `test/fixtures/recordings/` are the decrypted XML with UIDs and camera
 * names replaced — see the README there.
 *
 * Two facts these captures settled, both pinned here:
 *   - the channel travels ONLY in the XML body; `sendXml` is never given a
 *     `channel`, so the header carries hostChannelId (250) on both topologies
 *     (an override keyed on `p.channel` sat in `getVideoclips` until 0.7.8 and
 *     could never fire);
 *   - neither firmware sends `<bFinished>`: a listing ends on the first page
 *     shorter than 40 entries, so a 4-clip day is one page and a 546-clip day
 *     is fourteen.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFileInfoListOpenXml,
  buildFileInfoListPageXml,
  dedupeRecordingFiles,
  DEFAULT_RECORDING_SEARCH_FILE_RECORD_TYPES,
  DEFAULT_RECORDING_SEARCH_RECORD_TYPES,
  listRecordingsViaFileInfoList,
  parseFileInfoListHandle,
} from "../../src/reolink/baichuan/utils/recordingsFileInfoList";
import { parseRecordingFilesFromXml } from "../../src/reolink/baichuan/xmlUtils";
import { dateFromWallClock } from "../../src/reolink/baichuan/utils/wallClock";

const FIX = join(__dirname, "..", "fixtures", "recordings");
const read = (topology: "standalone" | "hub", name: string): string =>
  readFileSync(join(FIX, topology, name), "utf8");

const normalise = (xml: string): string => xml.replace(/\s+/g, "");

/** Keep only the first `n` <FileInfo> blocks of a page response. */
const truncatePage = (xml: string, n: number): string => {
  const blocks = xml.match(/<FileInfo>[\s\S]*?<\/FileInfo>/g) ?? [];
  const kept = blocks.slice(0, n).join("");
  return `<?xml version="1.0" encoding="UTF-8" ?><body><FileInfoList version="1.1">${kept}</FileInfoList></body>`;
};

const ROME = "Europe/Rome";
const DAY_START = dateFromWallClock(
  { year: 2026, month: 9, day: 19, hour: 0, minute: 0, second: 0 },
  ROME,
);
const DAY_END = dateFromWallClock(
  { year: 2026, month: 9, day: 19, hour: 23, minute: 59, second: 59 },
  ROME,
);

describe("FileInfoList request builders reproduce the captured requests", () => {
  it("standalone open request (ch 0, device UID from cmd 114)", () => {
    const xml = buildFileInfoListOpenXml({
      uid: "9527000STANDALON",
      channel: 0,
      streamType: "subStream",
      recordType:
        "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package",
      start: DAY_START,
      end: DAY_END,
      timeZone: ROME,
    });
    expect(normalise(xml)).toBe(
      normalise(read("standalone", "fileinfolist-14-open-request.xml")),
    );
  });

  it("hub open request (ch 1, child UID)", () => {
    const xml = buildFileInfoListOpenXml({
      uid: "9527000HUBCHILD1",
      channel: 1,
      streamType: "subStream",
      recordType:
        "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package",
      start: DAY_START,
      end: DAY_END,
      timeZone: ROME,
    });
    expect(normalise(xml)).toBe(
      normalise(read("hub", "fileinfolist-14-open-request.xml")),
    );
  });

  it("page request carries channel, uid and the handle from the open reply", () => {
    const handle = parseFileInfoListHandle(
      read("hub", "fileinfolist-14-open-response.xml"),
    );
    expect(handle).toBe(15);
    const xml = buildFileInfoListPageXml({
      channel: 1,
      uid: "9527000HUBCHILD1",
      handle,
    });
    expect(normalise(xml)).toBe(
      normalise(read("hub", "fileinfolist-15-page-request.xml")),
    );
  });
});

describe("the default filter is the official app's (2026-09-20 captures)", () => {
  it("standalone: defaults reproduce the app's open request, sub stream", () => {
    const xml = buildFileInfoListOpenXml({
      uid: "9527000STANDALON",
      channel: 0,
      streamType: "subStream",
      recordType: DEFAULT_RECORDING_SEARCH_RECORD_TYPES,
      fileRecordTypes: DEFAULT_RECORDING_SEARCH_FILE_RECORD_TYPES,
      start: dateFromWallClock(
        { year: 2026, month: 9, day: 20, hour: 0, minute: 0, second: 0 },
        ROME,
      ),
      end: dateFromWallClock(
        { year: 2026, month: 9, day: 20, hour: 23, minute: 59, second: 59 },
        ROME,
      ),
      timeZone: ROME,
    });
    expect(normalise(xml)).toBe(
      normalise(read("standalone", "fileinfolist-14-open-app-request.xml")),
    );
  });

  it("hub child (the Events screen): the same body, over the EVENT's 15 s window — a sub-day search is valid", () => {
    const xml = buildFileInfoListOpenXml({
      uid: "9527000HUBCHILD0",
      channel: 0,
      streamType: "subStream",
      recordType: DEFAULT_RECORDING_SEARCH_RECORD_TYPES,
      fileRecordTypes: DEFAULT_RECORDING_SEARCH_FILE_RECORD_TYPES,
      start: dateFromWallClock(
        { year: 2026, month: 9, day: 18, hour: 18, minute: 35, second: 53 },
        ROME,
      ),
      end: dateFromWallClock(
        { year: 2026, month: 9, day: 18, hour: 18, minute: 36, second: 8 },
        ROME,
      ),
      timeZone: ROME,
    });
    expect(normalise(xml)).toBe(
      normalise(read("hub", "fileinfolist-14-open-app-request.xml")),
    );
  });

  it("the app asks the sub and the main stream as two searches, and the twins carry different names", () => {
    const sub = read("standalone", "fileinfolist-14-open-app-request.xml");
    const main = read(
      "standalone",
      "fileinfolist-14-open-app-main-request.xml",
    );
    expect(sub).toContain("<streamType>subStream</streamType>");
    expect(main).toContain("<streamType>mainStream</streamType>");
    expect(normalise(sub.replace("subStream", "X"))).toBe(
      normalise(main.replace("mainStream", "X")),
    );
  });
});

describe("parseRecordingFilesFromXml on captured pages", () => {
  it("standalone page: 40 entries, Id path as fileName, camera-zone timestamps", () => {
    const files = parseRecordingFilesFromXml(
      read("standalone", "fileinfolist-15-page1-response.xml"),
      { timeZone: ROME },
    );
    expect(files).toHaveLength(40);
    const first = files[0]!;
    expect(first.fileName).toBe(
      "/mnt/sda/Mp4Record/2026-09-19/RecS03_DST20260919_000145_000348_2B1E808_257B48.mp4",
    );
    expect(first.name).toBe("0120260919000145");
    expect(first.recordType).toBe("md");
    expect(first.sizeBytes).toBe(2456392);
    // 00:01:45 on the camera (CEST) is 22:01:45Z the day before.
    expect(first.startTime?.getTime()).toBe(Date.UTC(2026, 8, 18, 22, 1, 45));
    expect(first.endTime?.getTime()).toBe(Date.UTC(2026, 8, 18, 22, 3, 48));
    expect(first.parsedFileName?.streamHint).toBe("sub");
    expect(first.detectionClasses).toContain("motion");
  });

  it("hub page: 4 entries, child folder in the Id, nine-part hub file name", () => {
    const files = parseRecordingFilesFromXml(
      read("hub", "fileinfolist-15-page1-response.xml"),
      { timeZone: ROME },
    );
    expect(files).toHaveLength(4);
    const first = files[0]!;
    expect(first.fileName).toContain(
      "/mnt/sda/U109527000HUBCHILD1-Camera 1/Mp4Record/2026-09-19/",
    );
    expect(first.recordType).toBe("none");
    expect(first.parsedFileName?.devType).toBe("hub");
    expect(first.startTime?.getTime()).toBe(Date.UTC(2026, 8, 19, 7, 25, 9));
  });

  it("the same page read without a zone follows the host clock (compatibility)", () => {
    const files = parseRecordingFilesFromXml(
      read("standalone", "fileinfolist-15-page1-response.xml"),
    );
    const d = files[0]!.startTime!;
    expect([
      d.getFullYear(),
      d.getMonth() + 1,
      d.getDate(),
      d.getHours(),
      d.getMinutes(),
      d.getSeconds(),
    ]).toEqual([2026, 9, 19, 0, 1, 45]);
  });

  it("neither firmware sends <bFinished>", () => {
    expect(
      read("standalone", "fileinfolist-15-page1-response.xml"),
    ).not.toContain("bFinished");
    expect(
      read("standalone", "fileinfolist-15-page2-response.xml"),
    ).not.toContain("bFinished");
    expect(read("hub", "fileinfolist-15-page1-response.xml")).not.toContain(
      "bFinished",
    );
  });
});

describe("listRecordingsViaFileInfoList", () => {
  const pageOf = (
    topology: "standalone" | "hub",
    calls: Array<{ cmdId: number }>,
  ): number => calls.filter((c) => c.cmdId === 15).length;

  it("standalone: pages until the first page shorter than 40, never hands sendXml a channel", async () => {
    const calls: Array<{
      cmdId: number;
      channel?: number;
      channelIdOverride?: number;
      payloadXml?: string;
    }> = [];
    const page1 = read("standalone", "fileinfolist-15-page1-response.xml");
    const page2 = read("standalone", "fileinfolist-15-page2-response.xml");
    const page3 = truncatePage(page1, 5); // a short last page, as the 14th page was live
    const sendXml = vi.fn(
      async (p: {
        cmdId: number;
        channel?: number;
        channelIdOverride?: number;
        payloadXml?: string;
      }) => {
        calls.push(p);
        if (p.cmdId === 14)
          return read("standalone", "fileinfolist-14-open-response.xml");
        if (p.cmdId === 15) {
          const n = pageOf("standalone", calls);
          return n === 1 ? page1 : n === 2 ? page2 : page3;
        }
        return "";
      },
    );

    const files = await listRecordingsViaFileInfoList({
      sendXml,
      channel: 0,
      uid: "9527000STANDALON",
      streamType: "subStream",
      recordType:
        "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package",
      start: DAY_START,
      end: DAY_END,
      maxIterations: 50,
      timeZone: ROME,
    });

    expect(calls.map((c) => c.cmdId)).toEqual([14, 15, 15, 15, 16]);
    // THE HEADER RULE: the channel is in the body only.
    for (const c of calls) {
      expect(c.channel).toBeUndefined();
      expect(c.channelIdOverride).toBeUndefined();
    }
    expect(calls[0]!.payloadXml).toContain("<channelId>0</channelId>");
    // page3 repeats 5 of page1's files: the helper returns them raw (85);
    // `getVideoclips` de-duplicates by fileName on top.
    expect(files).toHaveLength(85);
    expect(dedupeRecordingFiles(files)).toHaveLength(80);
  });

  it("hub child: a 4-entry page is the whole day", async () => {
    const calls: Array<{
      cmdId: number;
      channel?: number;
      payloadXml?: string;
    }> = [];
    const sendXml = vi.fn(
      async (p: { cmdId: number; channel?: number; payloadXml?: string }) => {
        calls.push(p);
        if (p.cmdId === 14)
          return read("hub", "fileinfolist-14-open-response.xml");
        if (p.cmdId === 15)
          return read("hub", "fileinfolist-15-page1-response.xml");
        return "";
      },
    );
    const files = await listRecordingsViaFileInfoList({
      sendXml,
      channel: 1,
      uid: "9527000HUBCHILD1",
      streamType: "subStream",
      recordType:
        "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package",
      start: DAY_START,
      end: DAY_END,
      maxIterations: 50,
      timeZone: ROME,
    });
    expect(calls.map((c) => c.cmdId)).toEqual([14, 15, 16]);
    expect(calls[0]!.payloadXml).toContain("<channelId>1</channelId>");
    expect(calls[0]!.payloadXml).toContain("<uid>9527000HUBCHILD1</uid>");
    expect(files).toHaveLength(4);
    for (const c of calls) expect(c.channel).toBeUndefined();
  });

  it("a `responseCode 400, empty body` on a page ends the listing and still closes the handle", async () => {
    const calls: number[] = [];
    const sendXml = vi.fn(async (p: { cmdId: number }) => {
      calls.push(p.cmdId);
      if (p.cmdId === 14)
        return read("standalone", "fileinfolist-14-open-response.xml");
      if (p.cmdId === 15)
        throw new Error(
          "Baichuan request failed (responseCode 400, empty body)",
        );
      return "";
    });
    const files = await listRecordingsViaFileInfoList({
      sendXml,
      channel: 0,
      uid: "9527000STANDALON",
      streamType: "subStream",
      recordType: "md",
      start: DAY_START,
      end: DAY_END,
      maxIterations: 50,
    });
    expect(files).toEqual([]);
    expect(calls).toEqual([14, 15, 16]);
  });
});
