import { describe, expect, it } from "vitest";
import {
  BC_CMD_ID_GET_OSD_DATETIME,
  BC_CMD_ID_SET_OSD_DATETIME,
} from "../../src/protocol/constants";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";
import {
  OSD_CORNERS,
  coordsForOsdCorner,
  isOsdCorner,
  readOsdPosition,
  type OsdCorner,
} from "../../src/reolink/baichuan/utils/osdPosition";
import {
  applyOsdDatetimePatch,
  parseOsdDatetimeXml,
} from "../../src/reolink/baichuan/utils/osdXml";

/**
 * Raw cmd_id 44 (`GetOsdDatetime`) reply captured from device 3825
 * ("Videocamera stanza caldaia", channel 3): channel name "Magicam" in the
 * bottom-right corner with the watermark on, timestamp in the top-right.
 */
const RAW_3825_CH3 =
  `<?xml version="1.0" encoding="UTF-8" ?>\n` +
  `<body>\n` +
  `<OsdDatetime version="1.1">\n` +
  `<channelId>3</channelId>\n` +
  `<enable>1</enable>\n` +
  `<topLeftX>65536</topLeftX>\n` +
  `<topLeftY>1</topLeftY>\n` +
  `<width>0</width>\n` +
  `<height>0</height>\n` +
  `<language>English</language>\n` +
  `</OsdDatetime>\n` +
  `<OsdChannelName version="1.1">\n` +
  `<channelId>3</channelId>\n` +
  `<name>Magicam</name>\n` +
  `<enable>1</enable>\n` +
  `<topLeftX>65536</topLeftX>\n` +
  `<topLeftY>65536</topLeftY>\n` +
  `<enWatermark>1</enWatermark>\n` +
  `<enBgcolor>0</enBgcolor>\n` +
  `</OsdChannelName>\n` +
  `</body>\n`;

describe("OSD position codec (16.16 normalised, not pixels)", () => {
  it("decodes the corner vocabulary observed on live cameras", () => {
    // device 3825: channel name bottom-right, timestamp top-right
    expect(readOsdPosition(65536, 65536)).toEqual({
      kind: "corner",
      corner: "bottom-right",
    });
    expect(readOsdPosition(65536, 1)).toEqual({
      kind: "corner",
      corner: "top-right",
    });
    // device 592: channel name bottom-left, timestamp top-left
    expect(readOsdPosition(1, 65536)).toEqual({
      kind: "corner",
      corner: "bottom-left",
    });
    expect(readOsdPosition(1, 1)).toEqual({
      kind: "corner",
      corner: "top-left",
    });
    // device 618 echoes a hard 0 for the start edge — same corner.
    expect(readOsdPosition(0, 0)).toEqual({
      kind: "corner",
      corner: "top-left",
    });
  });

  it("reports a hand-dragged placement as custom, never rounded to a corner", () => {
    expect(readOsdPosition(30000, 1)).toEqual({ kind: "custom", x: 30000, y: 1 });
    expect(readOsdPosition(65536, 40000)).toEqual({
      kind: "custom",
      x: 65536,
      y: 40000,
    });
  });

  it("reports a missing coordinate as unknown, never as a corner", () => {
    expect(readOsdPosition(undefined, undefined)).toEqual({ kind: "unknown" });
    expect(readOsdPosition(65536, null)).toEqual({ kind: "unknown" });
    expect(readOsdPosition(Number.NaN, 1)).toEqual({ kind: "unknown" });
  });

  it("round-trips every corner through the coordinates it writes", () => {
    for (const corner of OSD_CORNERS) {
      const { x, y } = coordsForOsdCorner(corner);
      expect(readOsdPosition(x, y)).toEqual({ kind: "corner", corner });
    }
  });

  it("narrows only the offered vocabulary", () => {
    expect(isOsdCorner("bottom-right")).toBe(true);
    expect(isOsdCorner("custom")).toBe(false);
    expect(isOsdCorner("centre")).toBe(false);
    expect(isOsdCorner(65536)).toBe(false);
  });
});

describe("parseOsdDatetimeXml", () => {
  it("parses the raw cmd_id 44 reply of device 3825 channel 3", () => {
    expect(parseOsdDatetimeXml(RAW_3825_CH3)).toEqual({
      osdDatetime: {
        channelId: 3,
        enable: true,
        topLeftX: 65536,
        topLeftY: 1,
        width: 0,
        height: 0,
        language: "English",
      },
      osdChannelName: {
        channelId: 3,
        name: "Magicam",
        enable: true,
        topLeftX: 65536,
        topLeftY: 65536,
        enWatermark: true,
        enBgcolor: false,
      },
    });
  });

  it("returns nothing rather than defaults when the blocks are absent", () => {
    expect(parseOsdDatetimeXml("<body></body>")).toEqual({});
  });
});

describe("applyOsdDatetimePatch (read-modify-write)", () => {
  it("moves the timestamp without disturbing any other field", () => {
    const patched = applyOsdDatetimePatch(RAW_3825_CH3, {
      datetime: { topLeftX: 0, topLeftY: 0 },
    });
    const parsed = parseOsdDatetimeXml(patched);
    expect(parsed.osdDatetime?.topLeftX).toBe(0);
    expect(parsed.osdDatetime?.topLeftY).toBe(0);
    // Everything the camera sent and we did not touch survives verbatim.
    expect(parsed.osdDatetime?.language).toBe("English");
    expect(parsed.osdDatetime?.enable).toBe(true);
    expect(parsed.osdDatetime?.width).toBe(0);
    expect(parsed.osdChannelName).toEqual(
      parseOsdDatetimeXml(RAW_3825_CH3).osdChannelName,
    );
  });

  it("keeps name, language and enBgcolor across a watermark-only write", () => {
    const patched = applyOsdDatetimePatch(RAW_3825_CH3, {
      channelName: { enWatermark: false },
    });
    const parsed = parseOsdDatetimeXml(patched);
    expect(parsed.osdChannelName?.enWatermark).toBe(false);
    expect(parsed.osdChannelName?.name).toBe("Magicam");
    expect(parsed.osdChannelName?.enBgcolor).toBe(false);
    expect(parsed.osdChannelName?.topLeftX).toBe(65536);
    expect(parsed.osdDatetime?.language).toBe("English");
  });

  it("escapes a channel name containing XML metacharacters", () => {
    const patched = applyOsdDatetimePatch(RAW_3825_CH3, {
      channelName: { name: "Ma<gi>&cam" },
    });
    expect(patched).toContain("<name>Ma&lt;gi&gt;&amp;cam</name>");
    expect(parseOsdDatetimeXml(patched).osdChannelName?.enable).toBe(true);
  });
});

interface SentFrame {
  cmdId: number;
  channel?: number;
  payloadXml?: string;
}

/**
 * A bare `ReolinkBaichuanApi` with only the two seams `getOsd`/`setOsd` reach:
 * the frame sender and the channel normaliser. Constructing the real client
 * would open sockets; the point of this harness is the cmd_id assertion.
 */
function makeApi(reply: string): {
  api: ReolinkBaichuanApi;
  sent: SentFrame[];
} {
  const sent: SentFrame[] = [];
  const api = Object.create(ReolinkBaichuanApi.prototype) as ReolinkBaichuanApi;
  const harness = api as unknown as {
    sendXml: (p: SentFrame) => Promise<string>;
    normalizeChannel: (c?: number) => number;
    isNvrLikeDevice: () => boolean;
  };
  harness.sendXml = async (p: SentFrame) => {
    sent.push(p);
    return reply;
  };
  harness.normalizeChannel = (c?: number) => c ?? 0;
  harness.isNvrLikeDevice = () => false;
  return { api, sent };
}

describe("getOsd / setOsd speak the OSD commands", () => {
  it("reads through cmd_id 44 and NEVER cmd_id 26 (GetImage)", async () => {
    const { api, sent } = makeApi(RAW_3825_CH3);
    await api.getOsd(3);
    expect(sent.map((f) => f.cmdId)).toEqual([BC_CMD_ID_GET_OSD_DATETIME]);
    // 26 is GetImage — the ISP block. It carries no OSD tag, and asking it
    // was what made every camera answer with the same fabricated tuple.
    expect(sent.some((f) => f.cmdId === 26)).toBe(false);
  });

  it("decodes the overlay state, watermark included, into corners", async () => {
    const { api } = makeApi(RAW_3825_CH3);
    const osd = await api.getOsd(3);
    expect(osd).toEqual({
      channel: 3,
      channelName: {
        enable: true,
        name: "Magicam",
        topLeftX: 65536,
        topLeftY: 65536,
        position: { kind: "corner", corner: "bottom-right" },
        enWatermark: true,
        enBgcolor: false,
      },
      datetime: {
        enable: true,
        topLeftX: 65536,
        topLeftY: 1,
        position: { kind: "corner", corner: "top-right" },
        language: "English",
      },
    });
  });

  it("reports unknown, not a default, when the camera answers nothing", async () => {
    const { api } = makeApi("<body></body>");
    const osd = await api.getOsd(3);
    expect(osd.channelName.enable).toBeNull();
    expect(osd.channelName.enWatermark).toBeNull();
    expect(osd.channelName.position).toEqual({ kind: "unknown" });
    expect(osd.datetime.position).toEqual({ kind: "unknown" });
  });

  it("writes through cmd_id 45 and NEVER cmd_id 25 (SetImage)", async () => {
    const { api, sent } = makeApi(RAW_3825_CH3);
    await api.setOsd(3, { channelName: { position: "top-left" } });
    expect(sent.map((f) => f.cmdId)).toEqual([
      BC_CMD_ID_GET_OSD_DATETIME,
      BC_CMD_ID_SET_OSD_DATETIME,
    ]);
    // 25 is SetImage; the firmware ignores an <Osd> body posted there, which
    // is why the pre-0.7 writes silently never landed.
    expect(sent.some((f) => f.cmdId === 25)).toBe(false);
  });

  it("encodes a corner and preserves the untouched overlay", async () => {
    const { api, sent } = makeApi(RAW_3825_CH3);
    await api.setOsd(3, {
      channelName: { position: "top-left", name: "Magicam" },
    });
    const body = sent[1]?.payloadXml ?? "";
    const parsed = parseOsdDatetimeXml(body);
    expect(parsed.osdChannelName?.topLeftX).toBe(0);
    expect(parsed.osdChannelName?.topLeftY).toBe(0);
    expect(parsed.osdChannelName?.enWatermark).toBe(true);
    // The timestamp overlay was not named in the patch — it must be untouched.
    expect(parsed.osdDatetime?.topLeftX).toBe(65536);
    expect(parsed.osdDatetime?.topLeftY).toBe(1);
    expect(parsed.osdDatetime?.language).toBe("English");
  });

  it("sends nothing at all for an empty patch", async () => {
    const { api, sent } = makeApi(RAW_3825_CH3);
    await api.setOsd(3, {});
    expect(sent).toEqual([]);
  });

  it("accepts every offered corner without throwing", async () => {
    for (const corner of OSD_CORNERS as readonly OsdCorner[]) {
      const { api, sent } = makeApi(RAW_3825_CH3);
      await api.setOsd(3, { datetime: { position: corner } });
      expect(sent[1]?.cmdId).toBe(BC_CMD_ID_SET_OSD_DATETIME);
    }
  });
});
