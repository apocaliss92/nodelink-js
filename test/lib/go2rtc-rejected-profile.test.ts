/**
 * Regression test for the "ext profile log spam" follow-up on issue #13.
 *
 * Pre-fix: when a camera explicitly rejects a profile (response_code 400)
 * the Go2rtcTcpServer onEnd auto-restart path kept trying to recreate the
 * native stream, spamming "[createNativeStream] stream error → closed" every
 * few seconds for AC cameras (prestartStream=true).
 *
 * Fix: onEnd now consults `api.isStreamProfileRejected()` and bails out
 * (drops connected clients, no restart) when the device has already
 * rejected the profile.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Go2rtcTcpServer } from "../../src/baichuan/stream/Go2rtcTcpServer.js";
import * as helpers from "../../src/rfc/helpers.js";

vi.mock("../../src/rfc/helpers.js", () => ({
  createNativeStream: vi.fn(),
}));

/** Simulates a stream that ends immediately without frames (mirrors a 400 reject). */
function makeImmediateEndGenerator() {
  return (async function* () {
    // yield nothing — generator ends → fanout onEnd fires
  })();
}

function buildMockApi(opts: { rejected: boolean }) {
  return {
    client: {
      getTransport: () => "tcp" as const,
      getDebugConfig: () => ({ debugRtsp: false }),
    },
    isReady: true,
    isClosed: false,
    isStreamProfileRejected: vi.fn(
      (_ch: number, _profile: string) => opts.rejected,
    ),
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    createDedicatedSession: vi.fn().mockResolvedValue({
      client: {},
      release: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

describe("Go2rtcTcpServer — rejected profile (issue #13 follow-up)", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT restart the native stream when the profile is rejected (no log spam)", async () => {
    vi.mocked(helpers.createNativeStream).mockImplementation(
      (() => makeImmediateEndGenerator()) as any,
    );

    const api = buildMockApi({ rejected: true });
    const server = new Go2rtcTcpServer({
      api: api as any,
      channel: 0,
      profile: "ext",
      listenHost: "127.0.0.1",
      listenPort: 0,
      prestartStream: true, // AC camera path — the one that loops pre-fix
      gracePeriodMs: 10_000,
      streamTimeoutMs: 20_000,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const s = server as any;
    s.active = true;

    await s.startNativeStream();
    for (let i = 0; i < 50; i++) await Promise.resolve();

    expect(helpers.createNativeStream).toHaveBeenCalledTimes(1);
    expect(api.isStreamProfileRejected).toHaveBeenCalledWith(0, "ext");
  });

  it("DOES restart when the profile is NOT rejected (control case)", async () => {
    let counter = 0;
    vi.mocked(helpers.createNativeStream).mockImplementation((() => {
      counter++;
      // First call ends immediately, subsequent calls return a hanging generator
      // so we don't loop forever in this test.
      if (counter === 1) return makeImmediateEndGenerator() as any;
      return (async function* () {
        // eslint-disable-next-line require-yield
        await new Promise<never>(() => {});
      })();
    }) as any);

    const api = buildMockApi({ rejected: false });
    const server = new Go2rtcTcpServer({
      api: api as any,
      channel: 0,
      profile: "main",
      listenHost: "127.0.0.1",
      listenPort: 0,
      prestartStream: true,
      gracePeriodMs: 10_000,
      streamTimeoutMs: 20_000,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const s = server as any;
    s.active = true;

    await s.startNativeStream();
    for (let i = 0; i < 50; i++) await Promise.resolve();

    expect(helpers.createNativeStream).toHaveBeenCalledTimes(2);
  });
});
