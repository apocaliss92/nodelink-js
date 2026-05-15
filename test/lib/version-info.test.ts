import { describe, it, expect } from "vitest";
import { parseVersionInfo } from "../../src/reolink/baichuan/utils/versionInfo";

describe("parseVersionInfo", () => {
  // Captured from a real E1 Zoom (firmware v3.2.0.4741) via the in-app
  // Capture tool, decrypted server-side. Body of cmd_id=80 response.
  const E1_ZOOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<VersionInfo version="1.1">
<name>Camera da letto</name>
<type>E1 Zoom</type>
<serialNumber>53817922778550</serialNumber>
<buildDay>build 2503281992</buildDay>
<hardwareVersion>IPC_NT14NA48MPSD6</hardwareVersion>
<cfgVersion>v3.2.0.0</cfgVersion>
<firmwareVersion>v3.2.0.4741_2503281992</firmwareVersion>
<detail>IPC_NT14NA48MPSD6S38E1W13110000</detail>
<IEClient>IEClient</IEClient>
<cc3200Version></cc3200Version>
<spVersion></spVersion>
<pakSuffix>pak</pakSuffix>
<itemNo>E340</itemNo>
<aiVersion>241119002701</aiVersion>
<helpVersion>blackPointsLevel=0</helpVersion>
</VersionInfo>
</body>
`;

  it("extracts all VersionInfo fields from a real camera response", () => {
    const result = parseVersionInfo(E1_ZOOM_FIXTURE);
    expect(result).toEqual({
      name: "Camera da letto",
      type: "E1 Zoom",
      serialNumber: "53817922778550",
      buildDay: "build 2503281992",
      hardwareVersion: "IPC_NT14NA48MPSD6",
      cfgVersion: "v3.2.0.0",
      firmwareVersion: "v3.2.0.4741_2503281992",
      detail: "IPC_NT14NA48MPSD6S38E1W13110000",
      IEClient: "IEClient",
      // Empty XML elements come through as "" rather than undefined so
      // callers can tell "absent" from "explicitly empty".
      cc3200Version: "",
      spVersion: "",
      pakSuffix: "pak",
      itemNo: "E340",
      aiVersion: "241119002701",
      helpVersion: "blackPointsLevel=0",
    });
  });

  it("accepts the inner VersionInfo block without the outer body envelope", () => {
    const inner = `<VersionInfo version="1.1">
<name>Front Door</name>
<type>RLC-810A</type>
<firmwareVersion>v3.1.0.1234</firmwareVersion>
</VersionInfo>`;
    const result = parseVersionInfo(inner);
    expect(result.name).toBe("Front Door");
    expect(result.type).toBe("RLC-810A");
    expect(result.firmwareVersion).toBe("v3.1.0.1234");
    // Fields not present in this firmware variant must be undefined, not "".
    expect(result.serialNumber).toBeUndefined();
    expect(result.aiVersion).toBeUndefined();
  });

  it("returns an all-undefined object for an empty/malformed XML", () => {
    const result = parseVersionInfo("<body></body>");
    expect(result).toEqual({
      name: undefined,
      type: undefined,
      serialNumber: undefined,
      buildDay: undefined,
      hardwareVersion: undefined,
      cfgVersion: undefined,
      firmwareVersion: undefined,
      detail: undefined,
      IEClient: undefined,
      cc3200Version: undefined,
      spVersion: undefined,
      pakSuffix: undefined,
      itemNo: undefined,
      aiVersion: undefined,
      helpVersion: undefined,
    });
  });
});
