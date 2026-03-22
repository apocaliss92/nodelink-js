import { describe, it, expect } from "vitest";
import { groupDeviceSessionsByIp } from "../../app/client/src/components/cameras/groupDeviceSessionsByIp.ts";

describe("groupDeviceSessionsByIp", () => {
  it("groups rows by IP and exposes counts", () => {
    const sessions = [
      { userName: "a", ip: "10.0.0.1", sessionId: 1, level: 0 },
      { userName: "b", ip: "10.0.0.2", sessionId: 2, level: 1 },
      { userName: "c", ip: "10.0.0.1", sessionId: 3, level: 0 },
    ];
    const groups = groupDeviceSessionsByIp(sessions);
    expect(groups).toHaveLength(2);
    const g1 = groups.find((g) => g.ip === "10.0.0.1");
    expect(g1?.items).toHaveLength(2);
    const g2 = groups.find((g) => g.ip === "10.0.0.2");
    expect(g2?.items).toHaveLength(1);
  });

  it("sorts groups by count descending", () => {
    const sessions = [
      { userName: "solo", ip: "1.1.1.1", sessionId: 0, level: 0 },
      { userName: "x", ip: "2.2.2.2", sessionId: 0, level: 0 },
      { userName: "y", ip: "2.2.2.2", sessionId: 0, level: 0 },
      { userName: "z", ip: "2.2.2.2", sessionId: 0, level: 0 },
    ];
    const groups = groupDeviceSessionsByIp(sessions);
    expect(groups[0]?.ip).toBe("2.2.2.2");
    expect(groups[0]?.items.length).toBe(3);
    expect(groups[1]?.ip).toBe("1.1.1.1");
  });

  it("normalizes empty IP to ?", () => {
    const sessions = [{ userName: "u", ip: "", sessionId: 0, level: 0 }];
    const groups = groupDeviceSessionsByIp(sessions);
    expect(groups[0]?.ip).toBe("?");
  });
});
