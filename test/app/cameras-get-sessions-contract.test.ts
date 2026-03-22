import { describe, it, expect } from "vitest";

/**
 * Contract for cameras.getSessions — Manager UI (SessionsList, floating panel)
 * and the tRPC router must stay aligned on this shape.
 */
describe("cameras.getSessions response contract", () => {
  it("has sessions array with required fields and numeric total", () => {
    const payload = {
      sessions: [
        { userName: "admin", ip: "192.168.1.10", sessionId: 1, level: 2 },
        { userName: "guest", ip: "10.0.0.5", sessionId: 0, level: 0 },
      ],
      total: 2,
    };

    expect(Array.isArray(payload.sessions)).toBe(true);
    for (const row of payload.sessions) {
      expect(row).toEqual(
        expect.objectContaining({
          userName: expect.any(String),
          ip: expect.any(String),
          sessionId: expect.any(Number),
          level: expect.any(Number),
        }),
      );
    }
    expect(typeof payload.total).toBe("number");
  });
});
