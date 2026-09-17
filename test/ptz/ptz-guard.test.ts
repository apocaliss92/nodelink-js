/**
 * The PTZ guard point — the "monitoring point" of the official app.
 *
 * Every shape asserted here was taken from a decrypted capture of the official
 * app talking to an E1 Outdoor PoE (firmware v3.1.0.5223) on 2026-09-17. The
 * two details that look like noise are deliberate: the floats are SCIENTIFIC
 * with a two-digit exponent on the write and plain on the read, and the READ
 * extension carries `chnType` while the WRITE extension does not. Tidying
 * either is how a protocol implementation starts lying.
 */
import { describe, expect, it } from "vitest";
import {
  BC_CMD_ID_GET_PTZ_GUARD,
  BC_CMD_ID_PTZ_GUARD,
} from "../../src/protocol/constants";
import {
  buildPtzGuardExtensionXml,
  buildPtzGuardGoXml,
  buildPtzGuardSetXml,
  parsePtzGuardXml,
} from "../../src/reolink/baichuan/ptzGuard";

describe("guard point command ids", () => {
  it("shares one id for both verbs and a second for the read", () => {
    expect(BC_CMD_ID_PTZ_GUARD).toBe(331);
    expect(BC_CMD_ID_GET_PTZ_GUARD).toBe(332);
  });
});

describe("buildPtzGuardGoXml", () => {
  it("asks the camera to go to the guard point now", () => {
    const xml = buildPtzGuardGoXml(0);
    expect(xml).toContain("<command>toGrd</command>");
    expect(xml).toContain('<PtzGuard version="1.1">');
  });

  it("uses the captured two-digit exponent, not JavaScript's one", () => {
    expect(buildPtzGuardGoXml(0)).toContain("<xpos>0.000000e+00</xpos>");
  });
});

describe("buildPtzGuardSetXml", () => {
  it("pins the current head position when asked", () => {
    const xml = buildPtzGuardSetXml({
      channelId: 0,
      enabled: true,
      timeoutSeconds: 68,
      setPosition: true,
    });
    expect(xml).toContain("<command>setGrd</command>");
    expect(xml).toContain("<benable>1</benable>");
    expect(xml).toContain("<timeout>68</timeout>");
    expect(xml).toContain("<needSetPos>1</needSetPos>");
  });

  /**
   * `needSetPos` appeared only on the FIRST set of the captured session.
   * Sending it on every edit would re-pin the point to wherever the head
   * happens to be, silently moving a position the operator had placed.
   */
  it("omits needSetPos when only the settings change", () => {
    const xml = buildPtzGuardSetXml({
      channelId: 0,
      enabled: false,
      timeoutSeconds: 60,
      setPosition: false,
    });
    expect(xml).not.toContain("needSetPos");
  });
});

describe("buildPtzGuardExtensionXml", () => {
  it("carries chnType on the read and withholds it on the write", () => {
    expect(buildPtzGuardExtensionXml(0, "read")).toContain("<chnType>0</chnType>");
    expect(buildPtzGuardExtensionXml(0, "write")).not.toContain("chnType");
  });
});

describe("parsePtzGuardXml", () => {
  const REPLY = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<PtzGuard version="1.1">
<channelId>0</channelId>
<timeout>68</timeout>
<benable>1</benable>
<bvalid>1</bvalid>
<imageName>guard</imageName>
<mode>global</mode>
<xpos>0</xpos>
<ypos>0</ypos>
<height>0</height>
<width>0</width>
</PtzGuard>
</body>`;

  it("reads the camera back", () => {
    expect(parsePtzGuardXml(REPLY)).toEqual({
      enabled: true,
      valid: true,
      timeoutSeconds: 68,
      mode: "global",
      imageName: "guard",
    });
  });

  /**
   * `bvalid` answers "is a guard point stored at all", and it is independent of
   * `benable`: a camera with the auto-return switched off can still hold a
   * valid point, which is exactly the state that makes `toGrd` useful.
   */
  it("tells stored apart from enabled", () => {
    const s = parsePtzGuardXml(REPLY.replace("<benable>1<", "<benable>0<"));
    expect(s?.enabled).toBe(false);
    expect(s?.valid).toBe(true);
  });

  /** An unreadable reply is null, never a default that claims a guard exists. */
  it("returns null for a reply it cannot read", () => {
    expect(parsePtzGuardXml("<body></body>")).toBeNull();
    expect(parsePtzGuardXml("")).toBeNull();
  });
});
