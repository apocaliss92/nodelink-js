/**
 * The recordings surface reads and writes the CAMERA's wall clock — every
 * `<startTime>` block, the CoverPreview window and the `YYYYMMDD_HHMMSS`
 * pair in a file name carry local time with no offset. Until 0.7.8 the
 * library used the host's `Date` accessors for all of it, which is only right
 * when the process runs in the camera's zone. These tests pin the explicit
 * `timeZone` path against instants taken from the 2026-09-20 captures (the
 * hub ran in `Europe/Berlin`, CEST, UTC+2).
 */

import { describe, it, expect } from "vitest";
import {
  dateFromWallClock,
  endOfWallClockDay,
  isKnownTimeZone,
  wallClockParts,
} from "../../src/reolink/baichuan/utils/wallClock";
import { xmlDateTimePayload } from "../../src/reolink/baichuan/utils/recordings";
import { parseXmlDateTimeBlock } from "../../src/reolink/baichuan/xmlUtils";
import { parseRecordingFileName } from "../../src/reolink/baichuan/recordingFileName";

// 2026-09-19 10:49:14Z — the start of the standalone clip whose thumbnail
// and bytes were captured; the camera showed 12:49:14 (CEST).
const CLIP_START_UTC = Date.UTC(2026, 8, 19, 10, 49, 14);

describe("wallClockParts / dateFromWallClock", () => {
  it("reads the same instant on three different wall clocks", () => {
    const d = new Date(CLIP_START_UTC);
    expect(wallClockParts(d, "Europe/Rome")).toEqual({
      year: 2026,
      month: 9,
      day: 19,
      hour: 12,
      minute: 49,
      second: 14,
    });
    expect(wallClockParts(d, "UTC")).toEqual({
      year: 2026,
      month: 9,
      day: 19,
      hour: 10,
      minute: 49,
      second: 14,
    });
    expect(wallClockParts(d, "America/New_York")).toEqual({
      year: 2026,
      month: 9,
      day: 19,
      hour: 6,
      minute: 49,
      second: 14,
    });
  });

  it("round-trips through dateFromWallClock in a zone with DST", () => {
    const parts = wallClockParts(new Date(CLIP_START_UTC), "Europe/Rome");
    expect(dateFromWallClock(parts, "Europe/Rome").getTime()).toBe(
      CLIP_START_UTC,
    );
  });

  it("resolves a reading across the spring-forward gap to the later instant", () => {
    // 2026-03-29 02:30 does not exist in Europe/Rome (clocks jump 02:00→03:00).
    const d = dateFromWallClock(
      { year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 },
      "Europe/Rome",
    );
    expect(wallClockParts(d, "Europe/Rome")).toEqual({
      year: 2026,
      month: 3,
      day: 29,
      hour: 3,
      minute: 30,
      second: 0,
    });
  });

  it("resolves an ambiguous fall-back reading to an instant that reads back the same", () => {
    // 2026-10-25 02:30 happens twice in Europe/Rome.
    const parts = {
      year: 2026,
      month: 10,
      day: 25,
      hour: 2,
      minute: 30,
      second: 0,
    };
    const d = dateFromWallClock(parts, "Europe/Rome");
    expect(wallClockParts(d, "Europe/Rome")).toEqual(parts);
  });

  it("falls back to the host clock when no zone is given (pre-0.7.8 behaviour)", () => {
    const d = new Date(CLIP_START_UTC);
    expect(wallClockParts(d)).toEqual({
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
    });
    expect(dateFromWallClock(wallClockParts(d)).getTime()).toBe(CLIP_START_UTC);
  });

  it("refuses an unknown zone instead of silently using the host clock", () => {
    expect(isKnownTimeZone("Europe/Rome")).toBe(true);
    expect(isKnownTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(() => wallClockParts(new Date(), "Mars/Olympus_Mons")).toThrow(
      RangeError,
    );
  });
});

describe("endOfWallClockDay", () => {
  it("ends the CAMERA's day, not the host's", () => {
    // 2026-09-19 22:30Z is already 2026-09-20 in Asia/Kolkata (UTC+5:30).
    const d = new Date(Date.UTC(2026, 8, 19, 22, 30, 0));
    const end = endOfWallClockDay(d, "Asia/Kolkata");
    expect(wallClockParts(end, "Asia/Kolkata")).toEqual({
      year: 2026,
      month: 9,
      day: 20,
      hour: 23,
      minute: 59,
      second: 59,
    });
    expect(end.getMilliseconds()).toBe(999);
    // …and in UTC the same instant ends the 19th.
    expect(wallClockParts(endOfWallClockDay(d, "UTC"), "UTC")).toEqual({
      year: 2026,
      month: 9,
      day: 19,
      hour: 23,
      minute: 59,
      second: 59,
    });
  });
});

describe("request payload and response parsing carry the zone", () => {
  it("xmlDateTimePayload writes the camera's wall clock", () => {
    const d = new Date(CLIP_START_UTC);
    expect(xmlDateTimePayload("startTime", d, "Asia/Tokyo")).toBe(
      "<startTime><year>2026</year><month>9</month><day>19</day><hour>19</hour><minute>49</minute><second>14</second></startTime>",
    );
    expect(xmlDateTimePayload("endTime", d, "UTC")).toBe(
      "<endTime><year>2026</year><month>9</month><day>19</day><hour>10</hour><minute>49</minute><second>14</second></endTime>",
    );
  });

  it("parseXmlDateTimeBlock reads a block as the camera's wall clock", () => {
    const block =
      "<startTime><year>2026</year><month>9</month><day>19</day><hour>12</hour><minute>49</minute><second>14</second></startTime>";
    expect(parseXmlDateTimeBlock(block, "Europe/Rome")?.getTime()).toBe(
      CLIP_START_UTC,
    );
    expect(parseXmlDateTimeBlock(block, "UTC")?.getTime()).toBe(
      CLIP_START_UTC + 2 * 3_600_000,
    );
  });

  it("parseRecordingFileName reads the file-name pair as the camera's wall clock", () => {
    const parsed = parseRecordingFileName(
      "/mnt/sda/Mp4Record/2026-09-19/RecS03_DST20260919_124914_124928_2B1E818_809DC.mp4",
      { timeZone: "Europe/Rome" },
    );
    expect(parsed?.start.getTime()).toBe(CLIP_START_UTC);
    expect(parsed?.end.getTime()).toBe(CLIP_START_UTC + 14_000);
    expect(parsed?.durationMs).toBe(14_000);
    // The hub's nine-part name, same zone.
    const hub = parseRecordingFileName(
      "RecS04_DST20260919_212027_212042_0_380_200_033C8000000000_E2E47.mp4",
      { timeZone: "Europe/Rome" },
    );
    expect(hub?.devType).toBe("hub");
    expect(hub?.start.getTime()).toBe(Date.UTC(2026, 8, 19, 19, 20, 27));
  });
});
