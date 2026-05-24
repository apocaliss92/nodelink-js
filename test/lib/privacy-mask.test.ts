import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SHELTER_CANVAS,
  decodePrivacyMaskZones,
  decodeShelterCoord,
  encodeShelterCoord,
  encodeShelterListXml,
  encodeTrackShelterListXml,
  extractCanvasFromShelterXml,
  patchShelterXml,
  type ShelterRect,
  type TrackShelterRect,
} from "../../src/reolink/baichuan/utils/privacyMask";

const fixturePath = join(
  __dirname,
  "..",
  "fixtures",
  "protocol",
  "getPrivacyMask-populated-response.json",
);

interface Fixture {
  cmdId: number;
  body: string;
}

const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as Fixture;

describe("privacy mask coord codec", () => {
  it("decodes the (pixel << 16) | canvas wire format", () => {
    // E1 Zoom shelter id=0: topLeftX=6816284 → pixel=104, canvas=540
    expect(decodeShelterCoord(6816284)).toEqual({ pixel: 104, canvas: 540 });
    expect(decodeShelterCoord(6160688)).toEqual({ pixel: 94, canvas: 304 });
    expect(decodeShelterCoord(7733788)).toEqual({ pixel: 118, canvas: 540 });
    expect(decodeShelterCoord(6488368)).toEqual({ pixel: 99, canvas: 304 });
  });

  it("round-trips encode → decode for the captured shelters", () => {
    const cases = [
      [6816284, 104, 540],
      [16843292, 257, 540],
      [22217244, 339, 540],
      [27066908, 413, 540],
      [6160688, 94, 304],
      [4456752, 68, 304],
      [12779824, 195, 304],
      [6553904, 100, 304],
    ] as const;
    for (const [wire, pixel, canvas] of cases) {
      const decoded = decodeShelterCoord(wire);
      expect(decoded).toEqual({ pixel, canvas });
      expect(encodeShelterCoord(pixel, canvas)).toBe(wire);
    }
  });

  it("clamps and floors pixel values on encode", () => {
    expect(encodeShelterCoord(-5, 540)).toBe(0 * 65536 + 540);
    expect(encodeShelterCoord(104.7, 540)).toBe(104 * 65536 + 540);
    expect(encodeShelterCoord(70000, 540)).toBe(0xffff * 65536 + 540);
  });
});

describe("extractCanvasFromShelterXml", () => {
  it("extracts canvas dims from the first non-zero coord", () => {
    expect(extractCanvasFromShelterXml(fixture.body)).toEqual({
      width: 540,
      height: 304,
    });
  });

  it("falls back to DEFAULT_SHELTER_CANVAS when every coord is zero", () => {
    const allZero = `
      <shelterList>
        <Shelter><topLeftX>0</topLeftX><topLeftY>0</topLeftY></Shelter>
      </shelterList>
    `;
    expect(extractCanvasFromShelterXml(allZero)).toEqual(
      DEFAULT_SHELTER_CANVAS,
    );
  });
});

describe("decodePrivacyMaskZones from real E1 Zoom fixture", () => {
  const zones = decodePrivacyMaskZones(fixture.body);

  it("reads the Shelter block scalar fields", () => {
    expect(zones.enable).toBe(true);
    expect(zones.maxNum).toBe(4);
    expect(zones.trackEnable).toBe(false);
    expect(zones.maxTrackShelterNum).toBe(4);
    expect(zones.canvas).toEqual({ width: 540, height: 304 });
  });

  it("parses 4 populated shelterList rectangles with normalized coords", () => {
    expect(zones.shelterList).toHaveLength(4);
    // Shelter id=0: x=104/540, y=94/304, w=118/540, h=99/304
    const r0 = zones.shelterList[0];
    expect(r0).toBeDefined();
    expect(r0!.id).toBe(0);
    expect(r0!.enable).toBe(true);
    expect(r0!.x).toBeCloseTo(104 / 540, 6);
    expect(r0!.y).toBeCloseTo(94 / 304, 6);
    expect(r0!.width).toBeCloseTo(118 / 540, 6);
    expect(r0!.height).toBeCloseTo(99 / 304, 6);
    // Shelter id=3: x=413/540, y=100/304, w=48/540, h=54/304
    const r3 = zones.shelterList[3];
    expect(r3).toBeDefined();
    expect(r3!.id).toBe(3);
    expect(r3!.x).toBeCloseTo(413 / 540, 6);
    expect(r3!.width).toBeCloseTo(48 / 540, 6);
  });

  it("parses 4 empty trackShelterList slots with sentinel -1 PTZ positions", () => {
    expect(zones.trackShelterList).toHaveLength(4);
    for (const t of zones.trackShelterList) {
      expect(t.enable).toBe(false);
      expect(t.pPos).toBe(-1);
      expect(t.tPos).toBe(-1);
      expect(t.zPos).toBe(-1);
    }
    // The track slot index is in <name>
    expect(zones.trackShelterList.map((t) => t.id)).toEqual([0, 1, 2, 3]);
  });
});

describe("encodeShelterListXml round-trips the populated fixture", () => {
  it("re-encodes the 4 shelterList rectangles to identical wire integers", () => {
    const zones = decodePrivacyMaskZones(fixture.body);
    const xml = encodeShelterListXml(
      zones.shelterList,
      zones.canvas,
      zones.maxNum,
    );

    // Verify every captured wire integer is reproduced verbatim.
    const captured = [
      [6816284, 6160688, 7733788, 6488368],
      [16843292, 4456752, 5833244, 2621744],
      [22217244, 12779824, 3998236, 1311024],
      [27066908, 6553904, 3146268, 3539248],
    ] as const;
    for (let id = 0; id < 4; id++) {
      const block = xml.match(
        new RegExp(`<Shelter><id>${id}</id>[\\s\\S]*?</Shelter>`),
      );
      expect(block).toBeTruthy();
      const txt = block![0];
      expect(txt).toContain(`<topLeftX>${captured[id]![0]}</topLeftX>`);
      expect(txt).toContain(`<topLeftY>${captured[id]![1]}</topLeftY>`);
      expect(txt).toContain(`<width>${captured[id]![2]}</width>`);
      expect(txt).toContain(`<height>${captured[id]![3]}</height>`);
      expect(txt).toContain(`<enable>1</enable>`);
    }
  });

  it("pads missing ids with disabled zero-rects up to maxNum", () => {
    const rects: ShelterRect[] = [
      {
        id: 1,
        enable: true,
        layer: 0,
        color: 0,
        x: 0.1,
        y: 0.1,
        width: 0.3,
        height: 0.3,
      },
    ];
    const xml = encodeShelterListXml(rects, { width: 540, height: 304 }, 4);
    expect(xml).toMatch(/<Shelter><id>0<\/id><enable>0<\/enable>/);
    expect(xml).toMatch(/<Shelter><id>1<\/id><enable>1<\/enable>/);
    expect(xml).toMatch(/<Shelter><id>2<\/id><enable>0<\/enable>/);
    expect(xml).toMatch(/<Shelter><id>3<\/id><enable>0<\/enable>/);
  });

  it("encodes <shelterList /> when maxNum is 0", () => {
    expect(
      encodeShelterListXml([], { width: 540, height: 304 }, 0),
    ).toBe("<shelterList />");
  });
});

describe("encodeTrackShelterListXml", () => {
  it("emits sentinel -1 PTZ pos and zero-size rects for empty slots", () => {
    const xml = encodeTrackShelterListXml(
      [],
      { width: 540, height: 304 },
      4,
    );
    expect(xml).toContain("<name>0</name>");
    expect(xml).toContain("<name>3</name>");
    expect(xml.match(/<pPos>-1<\/pPos>/g)).toHaveLength(4);
    expect(xml.match(/<tPos>-1<\/tPos>/g)).toHaveLength(4);
    expect(xml.match(/<zPos>-1<\/zPos>/g)).toHaveLength(4);
  });

  it("encodes a tracking shelter anchored to a PTZ preset", () => {
    const rects: TrackShelterRect[] = [
      {
        id: 0,
        enable: true,
        layer: 0,
        color: 0,
        x: 0.25,
        y: 0.25,
        width: 0.5,
        height: 0.5,
        pPos: 1800,
        tPos: 200,
        zPos: 0,
      },
    ];
    const xml = encodeTrackShelterListXml(
      rects,
      { width: 540, height: 304 },
      4,
    );
    const block0 = xml.match(
      /<trackShelter><name>0<\/name>[\s\S]*?<\/trackShelter>/,
    );
    expect(block0).toBeTruthy();
    expect(block0![0]).toContain("<enable>1</enable>");
    expect(block0![0]).toContain("<pPos>1800</pPos>");
    expect(block0![0]).toContain("<tPos>200</tPos>");
    expect(block0![0]).toContain("<zPos>0</zPos>");
    // x=0.25 of 540 = 135 → wire = 135*65536 + 540 = 8847900
    expect(block0![0]).toContain("<topLeftX>8847900</topLeftX>");
  });
});

describe("patchShelterXml", () => {
  it("replaces shelterList in-place preserving surrounding tags", () => {
    const newRects: ShelterRect[] = [
      {
        id: 0,
        enable: true,
        layer: 0,
        color: 0,
        x: 0,
        y: 0,
        width: 0.5,
        height: 0.5,
      },
    ];
    const patched = patchShelterXml(
      fixture.body,
      { shelterList: newRects },
      { width: 540, height: 304 },
      4,
      4,
    );
    // maxNum and trackShelterList must still be present
    expect(patched).toContain("<maxNum>4</maxNum>");
    expect(patched).toContain("<trackShelterList>");
    expect(patched).toContain("<maxTrackShelterNum>4</maxTrackShelterNum>");
    // The new shelter rect must be present
    const parsed = decodePrivacyMaskZones(patched);
    expect(parsed.shelterList).toHaveLength(4);
    expect(parsed.shelterList[0]!.enable).toBe(true);
    expect(parsed.shelterList[0]!.width).toBeCloseTo(0.5, 4);
    expect(parsed.shelterList[1]!.enable).toBe(false);
  });

  it("toggles enable without touching shelter rectangles", () => {
    const patched = patchShelterXml(
      fixture.body,
      { enable: false },
      { width: 540, height: 304 },
      4,
      4,
    );
    expect(patched.match(/<enable>0<\/enable>/)).toBeTruthy();
    // Existing rectangle data preserved
    expect(patched).toContain("<topLeftX>6816284</topLeftX>");
  });
});
