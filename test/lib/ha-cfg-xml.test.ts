import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHaCfgXml,
  parseHaCfgXml,
  isHaCfgSupportedResponse,
} from "../../src/reolink/baichuan/utils/haCfg.js";
import {
  BC_CMD_ID_GET_HA_CFG,
  BC_CMD_ID_SET_HA_CFG,
} from "../../src/protocol/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("HaCfg command ids", () => {
  it("uses 806 get / 807 set", () => {
    expect(BC_CMD_ID_GET_HA_CFG).toBe(806);
    expect(BC_CMD_ID_SET_HA_CFG).toBe(807);
  });
});

describe("buildHaCfgXml", () => {
  it("builds an enabled payload matching reolink_aio WEBHOOK_PUSH", () => {
    expect(
      buildHaCfgXml({
        enable: true,
        url: "http://192.168.1.10:9081/webhook/cam-a",
        verifyCert: false,
      }),
    ).toBe(`<?xml version="1.0" encoding="UTF-8" ?>
<body>
<HaCfg version="1.1">
<enable>1</enable>
<url>http://192.168.1.10:9081/webhook/cam-a</url>
<verify_cert>0</verify_cert>
</HaCfg>
</body>`);
  });

  it("clears the url when disabling", () => {
    const xml = buildHaCfgXml({
      enable: false,
      url: "http://example.invalid/webhook",
    });
    expect(xml).toContain("<enable>0</enable>");
    expect(xml).toContain("<url></url>");
  });
});

describe("parseHaCfgXml", () => {
  it("parses the doorbell Gen2 fixture", () => {
    const xml = fs.readFileSync(
      path.join(__dirname, "..", "fixtures", "protocol", "ha-cfg-response.xml"),
      "utf8",
    );
    expect(parseHaCfgXml(xml)).toEqual({
      enable: false,
      url: "",
      verifyCert: true,
    });
    expect(isHaCfgSupportedResponse(xml)).toBe(true);
  });

  it("returns undefined for empty / non-HaCfg bodies", () => {
    expect(parseHaCfgXml("")).toBeUndefined();
    expect(parseHaCfgXml("<body></body>")).toBeUndefined();
    expect(isHaCfgSupportedResponse("")).toBe(false);
  });

  it("reads enable=1 + url after a SET", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<HaCfg version="1.1">
<enable>1</enable>
<url>http://192.168.1.192:64194/webhook</url>
<verify_cert>0</verify_cert>
</HaCfg>
</body>`;
    expect(parseHaCfgXml(xml)).toEqual({
      enable: true,
      url: "http://192.168.1.192:64194/webhook",
      verifyCert: false,
    });
  });
});
