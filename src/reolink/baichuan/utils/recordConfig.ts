/**
 * Onboard recording configuration — `<RecordCfg>` (cmd 54 GET / 55 SET) and
 * `<Record>` (cmd 81 GET / 82 SET).
 *
 * Everything in this file is pure: XML in, XML or a verdict out. The wire
 * facts below were measured, not inferred, on 2026-09-22 against three live
 * devices:
 *
 *   - E1 Outdoor PoE, v3.1.0.5223_2510172100
 *   - E1 Outdoor Pro, v3.1.0.5714_2511271366
 *   - Reolink Home Hub, v3.3.0.456_25122258 (channel 0, a battery camera)
 *
 * ## The camera never says no
 *
 * **Every** bad value measured was answered `200` and then dropped:
 * `preRecordTime` 9999, a `cycle` outside the camera's own `<cyclelist>`, a
 * 167-character weekly mask, and a `<type>` the camera does not have. Not one
 * of them produced an error code. A setter that trusted the response code
 * would report success on all four.
 *
 * Worse, the drop is **per field and per schedule item**: a document carrying
 * a 167-character `Normal` mask AND a valid `MD` mask applied the `MD` one and
 * silently discarded the `Normal` one. So a caller cannot even treat a write
 * as atomic.
 *
 * Two consequences, and both are implemented here:
 *   1. Everything checkable is refused BEFORE the wire ({@link
 *      validateRecordCfgPatch}, {@link validateRecordSchedulePatch}).
 *   2. What cannot be checked in advance is verified AFTER, by re-reading and
 *      diffing ({@link diffRecordCfg}, {@link diffRecordSchedule}).
 *
 * ## `preRecordTime` is a switch wearing a number's clothes
 *
 * The wire field is seconds and the camera honours exactly two states.
 * Measured identically on E1 Outdoor PoE and E1 Outdoor Pro: `0` turns
 * pre-record off; `5`, `15` and `30` all read back as `10`, the camera's own
 * fixed pre-roll. There is no seconds control here to offer, so this module
 * exposes a boolean and preserves the camera's own non-zero value when
 * turning it back on.
 *
 * ## `<timeList>` is a suggestion, not a constraint
 *
 * The Home Hub's `<RecordCfg>` carries `<timeList>8,15,30</timeList>` for
 * `recordDelayTime`. Writing `20` — absent from that list — was accepted AND
 * applied, read back as 20. So the list is what the vendor app offers, not
 * what the firmware enforces, and refusing against it would block a value the
 * camera honours. `<cyclelist>` IS enforced (7 was dropped), so that one is
 * refused.
 */
import { getXmlText } from "../../../protocol/xml";
import { getXmlBlocks } from "../xmlUtils";
import { parseNumber } from "./parsing";

/** 7 days × 24 hours. The weekly mask is one character per hour. */
export const RECORD_WEEKLY_MASK_LENGTH = 168;

// ── Patches ──────────────────────────────────────────────────────────

/** A partial change to `<RecordCfg>`. Omitted fields are left alone. */
export type BaichuanRecordCfgPatch = {
  /** Overwrite-when-full. Must be a member of the camera's `<cyclelist>`. */
  readonly cycle?: number;
  /** Post-record seconds — how long recording continues after the trigger clears. */
  readonly recordDelayTime?: number;
  /**
   * Pre-record on/off. Not a number of seconds: see the module note. `true`
   * restores the camera's own pre-roll, `false` writes 0.
   */
  readonly preRecordEnabled?: boolean;
  /** Segment/package length in minutes. */
  readonly packageTime?: number;
};

/**
 * One schedule row. A camera may carry SEVERAL rows of the same `type`, one
 * per configured rule — E1 Outdoor Pro lists `crossline`, `intrude` and
 * `loitering` three times each, distinguished only by `<index>`. The row is
 * therefore addressed by `(type, index)`, and `index` is omitted only for the
 * types that carry no index on that firmware (`MD`, `Normal`, `people`, …).
 */
export type BaichuanRecordScheduleEntryPatch = {
  readonly type: string;
  readonly index?: number;
  /** Exactly {@link RECORD_WEEKLY_MASK_LENGTH} characters of `0` or `1`. */
  readonly valueTable: string;
};

/** A partial change to `<Record>`. */
export type BaichuanRecordSchedulePatch = {
  /** Master "record to the card at all" switch. */
  readonly enable?: boolean;
  readonly entries?: readonly BaichuanRecordScheduleEntryPatch[];
};

// ── What the camera says it accepts ──────────────────────────────────

/**
 * The camera's own statement of its limits, read out of the GET document.
 *
 * Nothing here is assumed: a firmware that stops offering a value stops
 * offering it to the caller too.
 */
export type BaichuanRecordCfgLimits = {
  /** `<cyclelist>` — the accepted `cycle` values. Enforced by the firmware. */
  readonly cycleList: readonly number[];
  /**
   * `<timeList>` — the post-record values the vendor app offers. NOT enforced
   * by the firmware (measured), so it is advisory and never a refusal reason.
   */
  readonly recordDelayTimeChoices: readonly number[];
  /** True when the document carries `<preRecordTime>` at all. */
  readonly preRecordSupported: boolean;
  /**
   * The camera's own pre-roll in seconds — the value a `true` write restores.
   * Null when pre-record is currently off and the camera never stated one.
   */
  readonly preRecordSeconds: number | null;
};

/** The default pre-roll, used when a camera reports 0 and never stated its own. */
const DEFAULT_PRE_RECORD_SECONDS = 10;

/** Read a `<RecordCfg>` reply's limits. */
export const parseRecordCfgLimits = (xml: string): BaichuanRecordCfgLimits => {
  const block = getXmlBlocks(xml, "RecordCfg")[0] ?? "";
  const numbersIn = (container: string, tag: string): number[] => {
    const outer = getXmlBlocks(block, container)[0];
    if (outer === undefined) return [];
    return getXmlBlocks(outer, tag)
      .map((t) => parseNumber(t.trim()))
      .filter((n): n is number => n !== undefined);
  };
  const pre = parseNumber(getXmlText(block, "preRecordTime"));
  return {
    cycleList: numbersIn("cyclelist", "item"),
    recordDelayTimeChoices: numbersIn("timeList", "time"),
    preRecordSupported: pre !== undefined,
    preRecordSeconds: pre === undefined || pre === 0 ? null : pre,
  };
};

/** One `(type, index)` row as the camera currently lists it. */
export type BaichuanRecordScheduleRow = {
  readonly type: string;
  readonly index: number | null;
  readonly valueTable: string;
};

/** Read every `<typeScheduleList><item>` row out of a `<Record>` reply. */
export const parseRecordScheduleRows = (
  xml: string,
): readonly BaichuanRecordScheduleRow[] => {
  const block = getXmlBlocks(xml, "Record")[0];
  const list = block === undefined ? undefined : getXmlBlocks(block, "typeScheduleList")[0];
  if (list === undefined) return [];
  const rows: BaichuanRecordScheduleRow[] = [];
  for (const item of getXmlBlocks(list, "item")) {
    const type = (getXmlText(item, "type") ?? "").trim();
    if (type === "") continue;
    const index = parseNumber(getXmlText(item, "index"));
    rows.push({
      type,
      index: index === undefined ? null : index,
      valueTable: (getXmlText(item, "valueTable") ?? "").trim(),
    });
  }
  return rows;
};

// ── Refusal, before the wire ─────────────────────────────────────────

/** A value this camera would accept with a 200 and then discard. */
export class BaichuanRecordConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaichuanRecordConfigError";
  }
}

const requireInteger = (field: string, value: number): void => {
  if (!Number.isInteger(value)) {
    throw new BaichuanRecordConfigError(
      `${field} must be a whole number, got ${String(value)}`,
    );
  }
};

/**
 * Refuse a `<RecordCfg>` patch the camera would silently drop.
 *
 * `cycle` is checked against the camera's own `<cyclelist>` because the
 * firmware enforces it. `recordDelayTime` is NOT checked against
 * `<timeList>` — that list is advisory (measured).
 */
export const validateRecordCfgPatch = (
  patch: BaichuanRecordCfgPatch,
  limits: BaichuanRecordCfgLimits,
): void => {
  if (patch.cycle !== undefined) {
    requireInteger("cycle", patch.cycle);
    if (limits.cycleList.length > 0 && !limits.cycleList.includes(patch.cycle)) {
      throw new BaichuanRecordConfigError(
        `cycle ${patch.cycle} is not one of the values this camera accepts (${limits.cycleList.join(", ")}); it would answer 200 and keep the old value`,
      );
    }
  }
  if (patch.recordDelayTime !== undefined) {
    requireInteger("recordDelayTime", patch.recordDelayTime);
    if (patch.recordDelayTime < 0) {
      throw new BaichuanRecordConfigError(
        `recordDelayTime must not be negative, got ${patch.recordDelayTime}`,
      );
    }
  }
  if (patch.packageTime !== undefined) {
    requireInteger("packageTime", patch.packageTime);
    if (patch.packageTime < 1) {
      throw new BaichuanRecordConfigError(
        `packageTime is a length in minutes and must be at least 1, got ${patch.packageTime}`,
      );
    }
  }
  if (patch.preRecordEnabled !== undefined && !limits.preRecordSupported) {
    throw new BaichuanRecordConfigError(
      "this camera does not report a pre-record setting, so writing one would do nothing",
    );
  }
};

/** True when `mask` is a weekly hour mask this protocol can carry. */
export const isWeeklyMask = (mask: string): boolean =>
  mask.length === RECORD_WEEKLY_MASK_LENGTH && /^[01]+$/.test(mask);

/**
 * Refuse a `<Record>` patch the camera would silently drop.
 *
 * A row the camera does not already list is refused: measured, appending
 * `<type>bogus</type>` was answered 200 and discarded. A mask of the wrong
 * length is refused for the same reason, and refusing it protects the rest of
 * the document, since the drop is per item and not per document.
 */
export const validateRecordSchedulePatch = (
  patch: BaichuanRecordSchedulePatch,
  rows: readonly BaichuanRecordScheduleRow[],
): void => {
  for (const entry of patch.entries ?? []) {
    if (!isWeeklyMask(entry.valueTable)) {
      throw new BaichuanRecordConfigError(
        `the weekly mask for ${describeEntry(entry)} must be exactly ${RECORD_WEEKLY_MASK_LENGTH} characters of 0 or 1, got ${entry.valueTable.length}; the camera would answer 200 and keep the old mask`,
      );
    }
    const known = rows.some(
      (row) =>
        row.type === entry.type &&
        (entry.index === undefined || row.index === entry.index),
    );
    if (!known) {
      throw new BaichuanRecordConfigError(
        `this camera has no recording schedule for ${describeEntry(entry)}; it lists ${rows.map(describeRow).join(", ") || "nothing"}`,
      );
    }
  }
};

const describeEntry = (entry: BaichuanRecordScheduleEntryPatch): string =>
  entry.index === undefined ? entry.type : `${entry.type}[${entry.index}]`;

const describeRow = (row: BaichuanRecordScheduleRow): string =>
  row.index === null ? row.type : `${row.type}[${row.index}]`;

// ── Building the document that goes on the wire ──────────────────────

const replaceTag = (xml: string, tag: string, value: string): string =>
  xml.replace(new RegExp(`<${tag}>[^<]*</${tag}>`), `<${tag}>${value}</${tag}>`);

/**
 * Patch a `<RecordCfg>` GET reply into the document cmd 55 wants.
 *
 * Read-modify-write over the camera's OWN document, so every firmware-specific
 * field it carried survives the round trip. A partial document is accepted too
 * (measured: a `<RecordCfg>` naming only `packageTime` applied it and left
 * `cycle` and `recordDelayTime` alone), but echoing the whole document is the
 * shape that works on every firmware here, and it is what the library does
 * everywhere else.
 *
 * The `<body>` wrapper is REQUIRED: the same document sent without it was
 * answered `400` with an empty body.
 */
export const buildRecordCfgSetXml = (
  currentXml: string,
  patch: BaichuanRecordCfgPatch,
  limits: BaichuanRecordCfgLimits,
): string => {
  let xml = currentXml;
  if (patch.cycle !== undefined) xml = replaceTag(xml, "cycle", String(patch.cycle));
  if (patch.recordDelayTime !== undefined) {
    xml = replaceTag(xml, "recordDelayTime", String(patch.recordDelayTime));
  }
  if (patch.packageTime !== undefined) {
    xml = replaceTag(xml, "packageTime", String(patch.packageTime));
  }
  if (patch.preRecordEnabled !== undefined) {
    const seconds = patch.preRecordEnabled
      ? (limits.preRecordSeconds ?? DEFAULT_PRE_RECORD_SECONDS)
      : 0;
    xml = replaceTag(xml, "preRecordTime", String(seconds));
  }
  return xml;
};

/**
 * Patch a `<Record>` GET reply into the document cmd 82 wants.
 *
 * Rows are matched on `(type, index)` — matching on `type` alone would rewrite
 * all three `crossline` rules of an E1 Outdoor Pro with one mask.
 */
export const buildRecordScheduleSetXml = (
  currentXml: string,
  patch: BaichuanRecordSchedulePatch,
): string => {
  let xml = currentXml;
  if (patch.enable !== undefined) {
    xml = replaceTag(xml, "enable", patch.enable ? "1" : "0");
  }
  for (const entry of patch.entries ?? []) {
    xml = replaceItemValueTable(xml, entry);
  }
  return xml;
};

const ITEM_RE = /<item>([\s\S]*?)<\/item>/g;

const replaceItemValueTable = (
  xml: string,
  entry: BaichuanRecordScheduleEntryPatch,
): string =>
  xml.replace(ITEM_RE, (whole, inner: string) => {
    const type = (getXmlText(inner, "type") ?? "").trim();
    if (type !== entry.type) return whole;
    if (entry.index !== undefined) {
      const index = parseNumber(getXmlText(inner, "index"));
      if (index !== entry.index) return whole;
    }
    if (getXmlText(inner, "valueTable") === undefined) return whole;
    return `<item>${replaceTag(inner, "valueTable", entry.valueTable)}</item>`;
  });

// ── Verification, after the wire ─────────────────────────────────────

/** What the camera did with one requested field. */
export type BaichuanRecordWriteOutcome =
  | { readonly field: string; readonly status: "applied"; readonly value: string }
  | {
      readonly field: string;
      readonly status: "ignored";
      readonly requested: string;
      readonly actual: string;
    };

/** The verdict on a whole write, read back from the camera. */
export type BaichuanRecordWriteResult = {
  readonly outcomes: readonly BaichuanRecordWriteOutcome[];
  /** True when the camera kept every field that was asked of it. */
  readonly allApplied: boolean;
};

const verdict = (
  outcomes: readonly BaichuanRecordWriteOutcome[],
): BaichuanRecordWriteResult => ({
  outcomes,
  allApplied: outcomes.every((o) => o.status === "applied"),
});

const compare = (
  field: string,
  requested: string,
  actual: string | undefined,
): BaichuanRecordWriteOutcome =>
  actual === requested
    ? { field, status: "applied", value: requested }
    : { field, status: "ignored", requested, actual: actual ?? "(absent)" };

/**
 * Diff a `<RecordCfg>` write against the document the camera answers next.
 *
 * `preRecordEnabled` is compared as a BOOLEAN, because the camera is entitled
 * to answer 10 to a request to turn it on and that is the setting doing what
 * it says — comparing seconds would report every successful enable as ignored.
 */
export const diffRecordCfg = (
  patch: BaichuanRecordCfgPatch,
  afterXml: string,
): BaichuanRecordWriteResult => {
  const block = getXmlBlocks(afterXml, "RecordCfg")[0] ?? "";
  const outcomes: BaichuanRecordWriteOutcome[] = [];
  if (patch.cycle !== undefined) {
    outcomes.push(compare("cycle", String(patch.cycle), getXmlText(block, "cycle")));
  }
  if (patch.recordDelayTime !== undefined) {
    outcomes.push(
      compare(
        "recordDelayTime",
        String(patch.recordDelayTime),
        getXmlText(block, "recordDelayTime"),
      ),
    );
  }
  if (patch.packageTime !== undefined) {
    outcomes.push(
      compare("packageTime", String(patch.packageTime), getXmlText(block, "packageTime")),
    );
  }
  if (patch.preRecordEnabled !== undefined) {
    const seconds = parseNumber(getXmlText(block, "preRecordTime"));
    const on = seconds !== undefined && seconds !== 0;
    outcomes.push(
      compare(
        "preRecordEnabled",
        String(patch.preRecordEnabled),
        seconds === undefined ? undefined : String(on),
      ),
    );
  }
  return verdict(outcomes);
};

/** Diff a `<Record>` write against the document the camera answers next. */
export const diffRecordSchedule = (
  patch: BaichuanRecordSchedulePatch,
  afterXml: string,
): BaichuanRecordWriteResult => {
  const outcomes: BaichuanRecordWriteOutcome[] = [];
  const block = getXmlBlocks(afterXml, "Record")[0] ?? "";
  if (patch.enable !== undefined) {
    outcomes.push(
      compare("enable", patch.enable ? "1" : "0", getXmlText(block, "enable")),
    );
  }
  const rows = parseRecordScheduleRows(afterXml);
  for (const entry of patch.entries ?? []) {
    const row = rows.find(
      (r) => r.type === entry.type && (entry.index === undefined || r.index === entry.index),
    );
    outcomes.push(
      compare(
        `schedule.${describeEntry(entry)}`,
        entry.valueTable,
        row === undefined ? undefined : row.valueTable,
      ),
    );
  }
  return verdict(outcomes);
};
