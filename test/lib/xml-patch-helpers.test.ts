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
