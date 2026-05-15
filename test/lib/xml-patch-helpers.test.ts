import { describe, expect, it } from "vitest";
import {
  applyStreamPatch,
  applyXmlTagPatch,
  ensureXmlHeader,
  normalizeDayNightMode,
  normalizeOpenClose,
  patchNestedTag,
} from "../../src/protocol/xml.js";

const SAMPLE_VIDEO_INPUT = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<VideoInput>
<channel>0</channel>
<bright>50</bright>
<contrast>50</contrast>
<saturation>50</saturation>
<hue>50</hue>
<sharpen>50</sharpen>
</VideoInput>
<InputAdvanceCfg>
<DayNight version="1.1">
<mode>auto</mode>
</DayNight>
<Exposure>
<mode>auto</mode>
</Exposure>
<hdrSwitch>0</hdrSwitch>
<binning_mode>0</binning_mode>
</InputAdvanceCfg>
</body>`;

const SAMPLE_ENC = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Enc>
<channelId>0</channelId>
<audio>1</audio>
<mainStream>
<size>2304*1296</size>
<videoEncType>0</videoEncType>
<frameRate>15</frameRate>
<bitRate>4096</bitRate>
</mainStream>
<subStream>
<size>640*480</size>
<videoEncType>0</videoEncType>
<frameRate>10</frameRate>
<bitRate>512</bitRate>
</subStream>
</Enc>
</body>`;

describe("applyXmlTagPatch", () => {
  it("replaces a leaf tag's text content", () => {
    const out = applyXmlTagPatch(SAMPLE_VIDEO_INPUT, "bright", 75);
    expect(out).toContain("<bright>75</bright>");
    expect(out).not.toContain("<bright>50</bright>");
    // Other fields untouched.
    expect(out).toContain("<contrast>50</contrast>");
  });

  it("is a no-op when value is undefined", () => {
    const out = applyXmlTagPatch(SAMPLE_VIDEO_INPUT, "bright", undefined);
    expect(out).toBe(SAMPLE_VIDEO_INPUT);
  });

  it("coerces booleans to 0/1", () => {
    const xml = "<body><enable>0</enable></body>";
    expect(applyXmlTagPatch(xml, "enable", true)).toContain(
      "<enable>1</enable>",
    );
    expect(applyXmlTagPatch(xml, "enable", false)).toContain(
      "<enable>0</enable>",
    );
  });
});

describe("patchNestedTag", () => {
  it("scopes the patch to the named parent block", () => {
    const out = patchNestedTag(
      SAMPLE_VIDEO_INPUT,
      "DayNight",
      "mode",
      "color",
    );
    // Inside DayNight: patched.
    expect(out).toMatch(/<DayNight[^>]*>\s*<mode>color<\/mode>\s*<\/DayNight>/);
    // Inside Exposure: untouched.
    expect(out).toMatch(/<Exposure>\s*<mode>auto<\/mode>\s*<\/Exposure>/);
  });

  it("is a no-op when value is undefined", () => {
    const out = patchNestedTag(
      SAMPLE_VIDEO_INPUT,
      "DayNight",
      "mode",
      undefined,
    );
    expect(out).toBe(SAMPLE_VIDEO_INPUT);
  });
});

describe("applyStreamPatch", () => {
  it("scopes bitRate / frameRate / videoEncType to the right stream", () => {
    const out = applyStreamPatch(SAMPLE_ENC, "mainStream", {
      bitRate: 8192,
      frameRate: 30,
      videoEncType: "h265",
    });
    // Main stream patched.
    expect(out).toMatch(
      /<mainStream>[\s\S]*<bitRate>8192<\/bitRate>[\s\S]*<\/mainStream>/,
    );
    expect(out).toMatch(
      /<mainStream>[\s\S]*<frameRate>30<\/frameRate>[\s\S]*<\/mainStream>/,
    );
    expect(out).toMatch(
      /<mainStream>[\s\S]*<videoEncType>1<\/videoEncType>[\s\S]*<\/mainStream>/,
    );
    // Sub stream untouched.
    expect(out).toMatch(
      /<subStream>[\s\S]*<bitRate>512<\/bitRate>[\s\S]*<\/subStream>/,
    );
    expect(out).toMatch(
      /<subStream>[\s\S]*<frameRate>10<\/frameRate>[\s\S]*<\/subStream>/,
    );
  });

  it("is a no-op when patch is undefined", () => {
    const out = applyStreamPatch(SAMPLE_ENC, "mainStream", undefined);
    expect(out).toBe(SAMPLE_ENC);
  });

  // The block below mirrors the exact <Compression> XML the Reolink Android
  // app receives from cmd_56 (GET_ENC) on an E1 Outdoor PoE — captured in
  // pcap/resolution.pcapng. setEnc() reads this back and patches it before
  // shipping the result as the cmd_57 (SET_ENC) request body.
  const SAMPLE_COMPRESSION = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<Compression version="1.1">
<channelId>0</channelId>
<isNoTranslateFrame>1</isNoTranslateFrame>
<mainStream>
<audio>1</audio>
<resolutionName>3840*2160</resolutionName>
<width>3840</width>
<height>2160</height>
<frame>25</frame>
<bitRate>8192</bitRate>
<encoderProfile>high</encoderProfile>
<videoEncType>0</videoEncType>
<gop>
<cur>2</cur>
<max>2</max>
<min>1</min>
</gop>
</mainStream>
<subStream>
<audio>1</audio>
<resolutionName>640*360</resolutionName>
<width>640</width>
<height>360</height>
<frame>10</frame>
<bitRate>256</bitRate>
<encoderProfile>high</encoderProfile>
<videoEncType>0</videoEncType>
<gop>
<cur>4</cur>
<max>4</max>
<min>1</min>
</gop>
</subStream>
<thirdStream>
<audio>1</audio>
<resolutionName>896*512</resolutionName>
<width>896</width>
<height>512</height>
<frame>20</frame>
<bitRate>1228</bitRate>
<encoderProfile>high</encoderProfile>
<videoEncType>0</videoEncType>
</thirdStream>
</Compression>
</body>`;

  describe("Compression block (cmd_56) extended fields", () => {
    it("patches width/height/encoderType/encoderProfile/gop on mainStream only", () => {
      const out = applyStreamPatch(SAMPLE_COMPRESSION, "mainStream", {
        width: 2560,
        height: 1440,
        encoderType: "vbr",
        encoderProfile: "main",
        gop: 4,
      });
      // mainStream patched
      expect(out).toMatch(
        /<mainStream>[\s\S]*<width>2560<\/width>[\s\S]*<\/mainStream>/,
      );
      expect(out).toMatch(
        /<mainStream>[\s\S]*<height>1440<\/height>[\s\S]*<\/mainStream>/,
      );
      expect(out).toMatch(
        /<mainStream>[\s\S]*<encoderType>vbr<\/encoderType>[\s\S]*<\/mainStream>/,
      );
      expect(out).toMatch(
        /<mainStream>[\s\S]*<encoderProfile>main<\/encoderProfile>[\s\S]*<\/mainStream>/,
      );
      // gop cur patched but max/min preserved
      expect(out).toMatch(
        /<mainStream>[\s\S]*<gop>\s*<cur>4<\/cur>\s*<max>2<\/max>\s*<min>1<\/min>\s*<\/gop>[\s\S]*<\/mainStream>/,
      );
      // subStream untouched
      expect(out).toMatch(
        /<subStream>[\s\S]*<width>640<\/width>[\s\S]*<\/subStream>/,
      );
      expect(out).toMatch(
        /<subStream>[\s\S]*<height>360<\/height>[\s\S]*<\/subStream>/,
      );
      // thirdStream untouched
      expect(out).toMatch(
        /<thirdStream>[\s\S]*<width>896<\/width>[\s\S]*<\/thirdStream>/,
      );
    });

    it("patches thirdStream (no existing <gop> block — injects one)", () => {
      const out = applyStreamPatch(SAMPLE_COMPRESSION, "thirdStream", {
        bitRate: 2048,
        gop: 4,
      });
      expect(out).toMatch(
        /<thirdStream>[\s\S]*<bitRate>2048<\/bitRate>[\s\S]*<\/thirdStream>/,
      );
      expect(out).toMatch(
        /<thirdStream>[\s\S]*<gop><cur>4<\/cur><\/gop>[\s\S]*<\/thirdStream>/,
      );
    });

    it("patches audio per-stream without touching the others", () => {
      const out = applyStreamPatch(SAMPLE_COMPRESSION, "subStream", {
        audio: 0,
      });
      expect(out).toMatch(
        /<subStream>[\s\S]*<audio>0<\/audio>[\s\S]*<\/subStream>/,
      );
      expect(out).toMatch(
        /<mainStream>[\s\S]*<audio>1<\/audio>[\s\S]*<\/mainStream>/,
      );
      expect(out).toMatch(
        /<thirdStream>[\s\S]*<audio>1<\/audio>[\s\S]*<\/thirdStream>/,
      );
    });

    it("frame and frameRate are both patched defensively", () => {
      const out = applyStreamPatch(SAMPLE_COMPRESSION, "mainStream", {
        frameRate: 15,
      });
      // The Compression block uses <frame> — must be updated.
      expect(out).toMatch(
        /<mainStream>[\s\S]*<frame>15<\/frame>[\s\S]*<\/mainStream>/,
      );
    });
  });
});

describe("normalizeDayNightMode", () => {
  it("downcases first letter", () => {
    expect(normalizeDayNightMode("Auto")).toBe("auto");
    expect(normalizeDayNightMode("Color")).toBe("color");
  });

  it("rewrites & to And", () => {
    expect(normalizeDayNightMode("Black&White")).toBe("blackAndWhite");
  });

  it("handles empty string", () => {
    expect(normalizeDayNightMode("")).toBe("");
  });
});

describe("normalizeOpenClose", () => {
  it("maps On/open/1/true to open", () => {
    expect(normalizeOpenClose("On")).toBe("open");
    expect(normalizeOpenClose("open")).toBe("open");
    expect(normalizeOpenClose("1")).toBe("open");
    expect(normalizeOpenClose("true")).toBe("open");
  });

  it("maps everything else to close", () => {
    expect(normalizeOpenClose("Off")).toBe("close");
    expect(normalizeOpenClose("close")).toBe("close");
    expect(normalizeOpenClose("0")).toBe("close");
    expect(normalizeOpenClose("")).toBe("close");
  });
});

describe("ensureXmlHeader", () => {
  it("prepends header when missing", () => {
    const out = ensureXmlHeader("<body></body>");
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8" ?>')).toBe(
      true,
    );
  });

  it("leaves an existing header alone", () => {
    const xml = '<?xml version="1.0" encoding="UTF-8" ?><body></body>';
    expect(ensureXmlHeader(xml)).toBe(xml);
  });
});
