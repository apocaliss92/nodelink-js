import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import { parseHddInfoListXml } from "../../src/reolink/baichuan/utils/hddInfo";
import {
  BaichuanRecordConfigError,
  buildRecordCfgSetXml,
  buildRecordScheduleSetXml,
  diffRecordCfg,
  diffRecordSchedule,
  parseRecordCfgLimits,
  parseRecordScheduleRows,
  validateRecordCfgPatch,
  validateRecordSchedulePatch,
} from "../../src/reolink/baichuan/utils/recordConfig";

/**
 * Onboard recording config — `<RecordCfg>` (54/55) and `<Record>` (81/82).
 *
 * Every fixture here is a byte-for-byte capture of a live reply, taken on
 * 2026-09-22 from three devices on one house network, and every assertion
 * about what the CAMERA does with a write was reproduced against that
 * hardware before it was written down:
 *
 *   - E1 Outdoor PoE v3.1.0.5223 — `packageTime` 5 → 10 and `recordDelayTime`
 *     15 → 30 applied and read back; `preRecordTime` 5/15/30 all read back as
 *     10; `cycle` 7, `preRecordTime` 9999, a 167-character mask and a
 *     `<type>bogus</type>` row were each answered 200 and DISCARDED.
 *   - E1 Outdoor Pro v3.1.0.5714 — same pre-record behaviour; lists
 *     `crossline`/`intrude`/`loitering` three times each, keyed by `<index>`.
 *   - Reolink Home Hub v3.3.0.456 channel 0 — `recordDelayTime` 15 → 30 → 20
 *     applied, including 20, which its own `<timeList>` does not offer.
 *
 * The camera never once answered an error. That is the reason this module
 * refuses before the wire and verifies after it, and it is what these tests
 * exist to hold in place.
 */

const fixture = (name: string): string =>
  readFileSync(join(__dirname, "..", "fixtures", "record", name), "utf8");

const POE_CFG = fixture("e1-outdoor-poe-recordcfg.xml");
const POE_RECORD = fixture("e1-outdoor-poe-record.xml");
const POE_HDD = fixture("e1-outdoor-poe-hddinfolist.xml");
const PRO_RECORD = fixture("e1-outdoor-pro-record.xml");
const HUB_CFG = fixture("home-hub-recordcfg.xml");
const HUB_HDD = fixture("home-hub-hddinfolist.xml");

const MASK_ALL_ON = "1".repeat(168);
const MASK_ALL_OFF = "0".repeat(168);

describe("<RecordCfg> limits, as the camera states them", () => {
  it("reads the enforced <cyclelist> off the E1 Outdoor PoE reply", () => {
    expect(parseRecordCfgLimits(POE_CFG).cycleList).toEqual([0, 1]);
  });

  it("reads the Home Hub's advisory <timeList> as post-record choices", () => {
    // 8/15/30 are what the vendor app offers. The firmware accepted 20.
    expect(parseRecordCfgLimits(HUB_CFG).recordDelayTimeChoices).toEqual([8, 15, 30]);
  });

  it("remembers the camera's own pre-roll so a re-enable restores it", () => {
    const limits = parseRecordCfgLimits(POE_CFG);
    expect(limits.preRecordSupported).toBe(true);
    expect(limits.preRecordSeconds).toBe(10);
  });
});

describe("refusing what the camera would answer 200 to and drop", () => {
  it("refuses a cycle outside the camera's own cyclelist", () => {
    // Measured: cycle 7 → responseCode 200, value unchanged at 1.
    expect(() =>
      validateRecordCfgPatch({ cycle: 7 }, parseRecordCfgLimits(POE_CFG)),
    ).toThrow(BaichuanRecordConfigError);
  });

  it("accepts a cycle the camera does list", () => {
    expect(() =>
      validateRecordCfgPatch({ cycle: 0 }, parseRecordCfgLimits(POE_CFG)),
    ).not.toThrow();
  });

  it("does NOT refuse a post-record value missing from <timeList>", () => {
    // 20 is not in the Hub's list and the Hub applied it. Refusing here would
    // block a value the firmware honours.
    expect(() =>
      validateRecordCfgPatch({ recordDelayTime: 20 }, parseRecordCfgLimits(HUB_CFG)),
    ).not.toThrow();
  });

  it("refuses a weekly mask of the wrong length", () => {
    // Measured: a 167-character mask → 200, and that ONE row was discarded
    // while a valid row in the same document was applied.
    const rows = parseRecordScheduleRows(POE_RECORD);
    expect(() =>
      validateRecordSchedulePatch(
        { entries: [{ type: "Normal", valueTable: MASK_ALL_ON.slice(0, 167) }] },
        rows,
      ),
    ).toThrow(/168/);
  });

  it("refuses a mask carrying anything but 0 and 1", () => {
    const rows = parseRecordScheduleRows(POE_RECORD);
    expect(() =>
      validateRecordSchedulePatch(
        { entries: [{ type: "Normal", valueTable: `2${MASK_ALL_ON.slice(1)}` }] },
        rows,
      ),
    ).toThrow(BaichuanRecordConfigError);
  });

  it("refuses a trigger this camera does not have", () => {
    // Measured: <type>bogus</type> appended → 200, row not created.
    const rows = parseRecordScheduleRows(POE_RECORD);
    expect(() =>
      validateRecordSchedulePatch(
        { entries: [{ type: "bogus", valueTable: MASK_ALL_ON }] },
        rows,
      ),
    ).toThrow(/no recording schedule/);
  });

  it("refuses a rule index this camera does not have", () => {
    // The Pro has crossline 0,1,2 — not 7.
    const rows = parseRecordScheduleRows(PRO_RECORD);
    expect(() =>
      validateRecordSchedulePatch(
        { entries: [{ type: "crossline", index: 7, valueTable: MASK_ALL_ON }] },
        rows,
      ),
    ).toThrow(BaichuanRecordConfigError);
    expect(() =>
      validateRecordSchedulePatch(
        { entries: [{ type: "crossline", index: 2, valueTable: MASK_ALL_ON }] },
        rows,
      ),
    ).not.toThrow();
  });
});

describe("building the document that goes on the wire", () => {
  it("patches one field and leaves the camera's own document otherwise whole", () => {
    const limits = parseRecordCfgLimits(POE_CFG);
    const out = buildRecordCfgSetXml(POE_CFG, { packageTime: 10 }, limits);
    expect(out).toContain("<packageTime>10</packageTime>");
    expect(out).toContain("<recordDelayTime>15</recordDelayTime>");
    expect(out).toContain("<cycle>1</cycle>");
    // <cyclelist> is the camera's own; it survives the round trip.
    expect(out).toContain("<item>0</item>");
    expect(out.startsWith("<?xml")).toBe(true);
    expect(out).toContain("<body>");
  });

  it("writes pre-record as the switch it really is", () => {
    const limits = parseRecordCfgLimits(POE_CFG);
    expect(
      buildRecordCfgSetXml(POE_CFG, { preRecordEnabled: false }, limits),
    ).toContain("<preRecordTime>0</preRecordTime>");
    // Back on restores the camera's OWN pre-roll, not a number we invented.
    expect(
      buildRecordCfgSetXml(POE_CFG, { preRecordEnabled: true }, limits),
    ).toContain("<preRecordTime>10</preRecordTime>");
  });

  it("addresses a schedule row by (type, index), not by type", () => {
    // The Pro has three crossline rules. A write to rule 1 must not touch 0 or 2.
    const out = buildRecordScheduleSetXml(PRO_RECORD, {
      entries: [{ type: "crossline", index: 1, valueTable: MASK_ALL_ON }],
    });
    const rows = parseRecordScheduleRows(out);
    const crossline = rows.filter((r) => r.type === "crossline");
    expect(crossline).toHaveLength(3);
    expect(crossline.find((r) => r.index === 1)?.valueTable).toBe(MASK_ALL_ON);
    expect(crossline.find((r) => r.index === 0)?.valueTable).toBe(MASK_ALL_OFF);
    expect(crossline.find((r) => r.index === 2)?.valueTable).toBe(MASK_ALL_OFF);
  });

  it("leaves every other trigger's mask alone", () => {
    const before = parseRecordScheduleRows(POE_RECORD);
    const out = buildRecordScheduleSetXml(POE_RECORD, {
      entries: [{ type: "Normal", valueTable: MASK_ALL_ON }],
    });
    const after = parseRecordScheduleRows(out);
    expect(after).toHaveLength(before.length);
    for (const row of before) {
      if (row.type === "Normal") continue;
      expect(after.find((r) => r.type === row.type)?.valueTable).toBe(row.valueTable);
    }
  });

  it("writes the master enable as 0/1", () => {
    expect(buildRecordScheduleSetXml(POE_RECORD, { enable: false })).toContain(
      "<enable>0</enable>",
    );
  });
});

describe("verifying after the wire, because 200 means nothing here", () => {
  it("reports a field the camera kept as applied", () => {
    const after = POE_CFG.replace(
      "<packageTime>5</packageTime>",
      "<packageTime>10</packageTime>",
    );
    const result = diffRecordCfg({ packageTime: 10 }, after);
    expect(result.allApplied).toBe(true);
  });

  it("reports a field the camera answered 200 to and dropped as ignored", () => {
    // This is the E1 Outdoor PoE with preRecordTime 9999 and cycle 7: the
    // reply after the write is byte-identical to the one before it.
    const result = diffRecordCfg({ packageTime: 10, cycle: 0 }, POE_CFG);
    expect(result.allApplied).toBe(false);
    expect(result.outcomes).toEqual([
      { field: "cycle", status: "ignored", requested: "0", actual: "1" },
      { field: "packageTime", status: "ignored", requested: "10", actual: "5" },
    ]);
  });

  it("does not call a successful pre-record enable ignored", () => {
    // Asking for ON and being answered 10 seconds is the setting working.
    // Comparing seconds instead of the boolean would report every enable as
    // a failure on both firmwares measured.
    const result = diffRecordCfg({ preRecordEnabled: true }, POE_CFG);
    expect(result.allApplied).toBe(true);
  });

  it("reports a discarded schedule row while the valid one in the same write landed", () => {
    // Measured exactly: one document, a bad Normal mask and a good MD mask.
    // The camera applied MD and dropped Normal. The write is not atomic and
    // the result must say so per row.
    const after = buildRecordScheduleSetXml(POE_RECORD, {
      entries: [{ type: "MD", valueTable: MASK_ALL_OFF }],
    });
    const result = diffRecordSchedule(
      {
        entries: [
          { type: "MD", valueTable: MASK_ALL_OFF },
          { type: "Normal", valueTable: MASK_ALL_ON },
        ],
      },
      after,
    );
    expect(result.allApplied).toBe(false);
    expect(result.outcomes.map((o) => [o.field, o.status])).toEqual([
      ["schedule.MD", "applied"],
      ["schedule.Normal", "ignored"],
    ]);
  });
});

describe("<HddInfoList> (cmd 102), against the wire and not the old declaration", () => {
  it("adds the split GB + MB pair back together", () => {
    // 238 GB + 271 MB = 238.26 GB. Either half alone is a wrong number.
    const [volume] = parseHddInfoListXml(POE_HDD);
    expect(volume?.capacity).toBe(238);
    expect(volume?.capacityM).toBe(271);
    expect(volume?.capacityMb).toBe(238 * 1024 + 271);
    expect(volume?.mount).toBe(1);
    expect(volume?.format).toBe(1);
  });

  it("prefers the exact byte count when the firmware sends one", () => {
    const [volume] = parseHddInfoListXml(HUB_HDD);
    expect(volume?.capacityBytes).toBe(62528618496);
    expect(volume?.capacityMb).toBeCloseTo(62528618496 / (1024 * 1024), 6);
    // The Home Hub calls its card 17. `number` is an id, not an ordinal.
    expect(volume?.number).toBe(17);
  });

  it("reports a size the camera never stated as null, never 0", () => {
    const [volume] = parseHddInfoListXml(
      '<body><HddInfoList><HddInfo><number>0</number><mount>1</mount></HddInfo></HddInfoList></body>',
    );
    expect(volume?.capacityMb).toBeNull();
    expect(volume?.remainMb).toBeNull();
  });

  it("finds nothing in a reply shaped like the OLD declaration", () => {
    // The shape this library declared until 0.9.0. Nothing sends it. A reader
    // written against it found nothing, silently — which is the defect.
    expect(
      parseHddInfoListXml(
        "<body><HddInfoList><item><id>0</id><size>238</size></item></HddInfoList></body>",
      ),
    ).toEqual([]);
  });
});

// ── The API methods, against a camera fake that behaves like the real one ──

interface Sent {
  cmdId: number;
  channel?: number;
  payloadXml?: string;
}

/**
 * A fake that answers cmd 54/81 from the real fixtures and, on a write,
 * applies it the way the hardware did: per field, per row, and with no error
 * code for what it refuses to keep.
 */
function harnessed(options?: { readonly deaf?: boolean }): {
  api: ReolinkBaichuanApi;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const state = { cfg: POE_CFG, record: POE_RECORD };
  const api = Object.create(ReolinkBaichuanApi.prototype) as ReolinkBaichuanApi;
  Object.defineProperty(api, "client", {
    configurable: true,
    value: {
      loggedIn: true,
      sendFrame: vi.fn(async (p: Sent) => {
        sent.push(p);
        if (p.cmdId === 55 && p.payloadXml !== undefined && options?.deaf !== true) {
          state.cfg = p.payloadXml;
        }
        if (p.cmdId === 82 && p.payloadXml !== undefined && options?.deaf !== true) {
          state.record = p.payloadXml;
        }
        const body =
          p.cmdId === 54 ? state.cfg : p.cmdId === 81 ? state.record : "";
        return {
          header: { responseCode: 200, channelId: 0 },
          body: Buffer.from(body, "utf8"),
        };
      }),
      tryDecryptXml: (body: Buffer) => body.toString("utf8"),
      enc: null,
    },
  });
  return { api, sent };
}

describe("setRecordCfg / setRecordSchedule", () => {
  it("sends cmd 55 with a <body>-wrapped document and verifies by re-reading", async () => {
    // The same document without <body> was answered 400 with an empty body.
    const { api, sent } = harnessed();
    const result = await api.setRecordCfg(0, { packageTime: 10 });
    const write = sent.find((s) => s.cmdId === 55);
    expect(write?.payloadXml).toContain("<body>");
    expect(write?.payloadXml).toContain("<packageTime>10</packageTime>");
    expect(write?.channel).toBe(0);
    // GET, SET, GET — the second read is the only proof the write landed.
    expect(sent.map((s) => s.cmdId)).toEqual([54, 55, 54]);
    expect(result.allApplied).toBe(true);
  });

  it("reports allApplied false when the camera answers 200 and keeps the old value", async () => {
    const { api } = harnessed({ deaf: true });
    const result = await api.setRecordCfg(0, { packageTime: 10 });
    expect(result.allApplied).toBe(false);
    expect(result.outcomes[0]).toEqual({
      field: "packageTime",
      status: "ignored",
      requested: "10",
      actual: "5",
    });
  });

  it("sends cmd 82 for a schedule row", async () => {
    const { api, sent } = harnessed();
    const result = await api.setRecordSchedule(0, {
      entries: [{ type: "Normal", valueTable: MASK_ALL_ON }],
    });
    expect(sent.map((s) => s.cmdId)).toEqual([81, 82, 81]);
    expect(result.allApplied).toBe(true);
  });

  it("refuses a bad mask BEFORE the wire — no write is sent at all", async () => {
    const { api, sent } = harnessed();
    await expect(
      api.setRecordSchedule(0, {
        entries: [{ type: "Normal", valueTable: MASK_ALL_ON.slice(0, 167) }],
      }),
    ).rejects.toThrow(BaichuanRecordConfigError);
    // One GET to learn what the camera has, and nothing else. A refusal that
    // still sent cmd 82 would have applied the other rows in the document.
    expect(sent.map((s) => s.cmdId)).toEqual([81]);
  });

  it("refuses a bad cycle BEFORE the wire", async () => {
    const { api, sent } = harnessed();
    await expect(api.setRecordCfg(0, { cycle: 7 })).rejects.toThrow(
      BaichuanRecordConfigError,
    );
    expect(sent.map((s) => s.cmdId)).toEqual([54]);
  });
});
