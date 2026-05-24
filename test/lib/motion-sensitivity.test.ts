import { describe, it, expect } from "vitest";
import {
  encodeMotionSensitivityListXml,
  patchMotionSensitivityListXml,
  type MotionSensitivityBand,
} from "../../src/reolink/baichuan/utils/motionSensitivity";

const fourBands: MotionSensitivityBand[] = [
  { id: 0, sensitivity: 10, beginHour: 0, beginMinute: 0, endHour: 6, endMinute: 0 },
  { id: 1, sensitivity: 20, beginHour: 6, beginMinute: 0, endHour: 12, endMinute: 0 },
  { id: 2, sensitivity: 30, beginHour: 12, beginMinute: 0, endHour: 18, endMinute: 0 },
  { id: 3, sensitivity: 40, beginHour: 18, beginMinute: 0, endHour: 23, endMinute: 59 },
];

describe("encodeMotionSensitivityListXml", () => {
  it("emits the 4 standard E1 Zoom bands in id order", () => {
    const xml = encodeMotionSensitivityListXml(fourBands);
    expect(xml.startsWith("<sensitivityInfoList>")).toBe(true);
    expect(xml.endsWith("</sensitivityInfoList>")).toBe(true);
    // each band carries the right scalar values
    expect(xml).toContain(
      "<sensitivityInfo><id>0</id><sensitivity>10</sensitivity><beginHour>0</beginHour><beginMinute>0</beginMinute><endHour>6</endHour><endMinute>0</endMinute></sensitivityInfo>",
    );
    expect(xml).toContain(
      "<sensitivityInfo><id>3</id><sensitivity>40</sensitivity><beginHour>18</beginHour><beginMinute>0</beginMinute><endHour>23</endHour><endMinute>59</endMinute></sensitivityInfo>",
    );
  });

  it("clamps sensitivity to [0,50] and hour/minute to legal ranges", () => {
    const xml = encodeMotionSensitivityListXml([
      {
        id: 0,
        sensitivity: 999,
        beginHour: 25,
        beginMinute: -5,
        endHour: -3,
        endMinute: 99,
      },
    ]);
    expect(xml).toContain("<sensitivity>50</sensitivity>");
    expect(xml).toContain("<beginHour>23</beginHour>");
    expect(xml).toContain("<beginMinute>0</beginMinute>");
    expect(xml).toContain("<endHour>0</endHour>");
    expect(xml).toContain("<endMinute>59</endMinute>");
  });

  it("emits <sensitivityInfoList /> for an empty list", () => {
    expect(encodeMotionSensitivityListXml([])).toBe("<sensitivityInfoList />");
  });

  it("sorts by id ascending", () => {
    const xml = encodeMotionSensitivityListXml([
      { id: 2, sensitivity: 30, beginHour: 12, beginMinute: 0, endHour: 18, endMinute: 0 },
      { id: 0, sensitivity: 10, beginHour: 0, beginMinute: 0, endHour: 6, endMinute: 0 },
    ]);
    expect(xml.indexOf("<id>0</id>")).toBeLessThan(xml.indexOf("<id>2</id>"));
  });
});

describe("patchMotionSensitivityListXml", () => {
  const mdResponse = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<MD version="1.1">
<channelId>0</channelId>
<enable>1</enable>
<sensitivityInfoList>
<sensitivityInfo><id>0</id><sensitivity>10</sensitivity><beginHour>0</beginHour><beginMinute>0</beginMinute><endHour>24</endHour><endMinute>0</endMinute></sensitivityInfo>
</sensitivityInfoList>
<sensInfoNew><sensitivityDefault>10</sensitivityDefault><sensInfoList /></sensInfoNew>
</MD>
</body>`;

  it("replaces the existing list in place, preserving the rest of the XML", () => {
    const out = patchMotionSensitivityListXml(mdResponse, fourBands);
    expect(out).toContain("<id>3</id>");
    expect(out).toContain("<channelId>0</channelId>");
    expect(out).toContain("<sensInfoNew>");
    // Old single-band entry is gone
    expect(out).not.toMatch(/<endHour>24<\/endHour>/);
  });

  it("replaces a self-closing list tag", () => {
    const empty = mdResponse.replace(
      /<sensitivityInfoList>[\s\S]*?<\/sensitivityInfoList>/,
      "<sensitivityInfoList />",
    );
    const out = patchMotionSensitivityListXml(empty, fourBands);
    expect(out).toContain("<id>3</id>");
    expect(out).not.toMatch(/<sensitivityInfoList \/>/);
  });
});
