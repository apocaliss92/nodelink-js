/**
 * Wall-clock conversions for the recordings surface.
 *
 * Every Baichuan recording timestamp — the `<startTime>`/`<endTime>` blocks a
 * FileInfoList search is asked with and answers with, the CoverPreview window,
 * and the `YYYYMMDD_HHMMSS` pair inside a recording file name — is the
 * camera's LOCAL wall clock, with no offset carried on the wire. Until 0.7.8
 * the library read and wrote those values with the host's `Date` local-time
 * accessors, which is only right when the process runs in the camera's zone.
 * Measured 2026-09-20: a hub container pinned to `Europe/Berlin` happened to
 * match its cameras, by configuration and not by design.
 *
 * `timeZone` is an IANA name (`Europe/Rome`). `undefined` keeps the historic
 * behaviour — the host's local zone — so existing callers are unchanged.
 */

export interface WallClockParts {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  /** 0-23 */
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  // Throws RangeError on an unknown zone — that is the right failure: a
  // misspelled zone must not silently fall back to the host clock.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, fmt);
  return fmt;
}

/** True when `timeZone` names a zone the runtime knows. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The wall-clock reading of instant `d` in `timeZone` (host local when
 * omitted).
 */
export function wallClockParts(d: Date, timeZone?: string): WallClockParts {
  if (timeZone === undefined) {
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
    };
  }
  const parts = formatterFor(timeZone).formatToParts(d);
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    return Number.parseInt(p?.value ?? "", 10);
  };
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    // hourCycle h23 yields "00".."23"; some ICU builds still emit "24" at
    // midnight — normalise.
    hour: pick("hour") % 24,
    minute: pick("minute"),
    second: pick("second"),
  };
}

/**
 * The instant at which the wall clock in `timeZone` (host local when omitted)
 * reads `parts`.
 *
 * Resolved by iteration: take the reading as if it were UTC, measure the
 * zone's offset at that guess, correct, and re-check once so a guess that
 * lands across a DST transition converges. A reading inside a spring-forward
 * gap resolves to the instant one hour later (the same choice `new Date(y, m,
 * d, h)` makes on the host clock).
 */
export function dateFromWallClock(
  parts: WallClockParts,
  timeZone?: string,
): Date {
  if (timeZone === undefined) {
    return new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
  }
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const seen = wallClockParts(new Date(guess), timeZone);
    const seenAsUtc = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      seen.hour,
      seen.minute,
      seen.second,
    );
    const offset = seenAsUtc - guess;
    if (offset === 0) break;
    guess = asUtc - offset;
  }
  return new Date(guess);
}

/**
 * 23:59:59.999 on the same wall-clock day as `d` in `timeZone`. A Reolink
 * FileInfoList search is bounded to one camera-local day, and the day must be
 * the camera's, not the host's.
 */
export function endOfWallClockDay(d: Date, timeZone?: string): Date {
  const p = wallClockParts(d, timeZone);
  const end = dateFromWallClock(
    { ...p, hour: 23, minute: 59, second: 59 },
    timeZone,
  );
  return new Date(end.getTime() + 999);
}
