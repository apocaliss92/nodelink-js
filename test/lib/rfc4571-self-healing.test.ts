/**
 * The RFC4571 server is what a consumer actually holds: a TCP connection that
 * carries the camera's video. When the camera drops or silences the native
 * stream, that connection must stay open and video must resume on it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import net from "node:net";

class FakeNativeStream extends EventEmitter {
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  consumePendingStartupError = () => undefined;
}

const nativeStreams: FakeNativeStream[] = [];

vi.mock("../../src/baichuan/stream/BaichuanVideoStream.js", () => ({
  BaichuanVideoStream: vi.fn().mockImplementation(function () {
    const s = new FakeNativeStream();
    nativeStreams.push(s);
    return s;
  }),
}));

// Import AFTER vi.mock so the server builds on the fake native stream.
import { createRfc4571TcpServer } from "../../src/rfc/rfc4571-server.js";

const START = Buffer.from([0, 0, 0, 1]);
const SPS = Buffer.from("6742c01fda014016e84000000300400000 0c83c60ca8".replace(/ /g, ""), "hex");
const PPS = Buffer.from("68ce3c80", "hex");
const IDR = Buffer.from("6588840000030000030000", "hex");
const KEYFRAME = Buffer.concat([START, SPS, START, PPS, START, IDR]);

const emitKeyframe = (s: FakeNativeStream, microseconds: number) =>
  s.emit("videoAccessUnit", {
    data: KEYFRAME,
    isKeyframe: true,
    videoType: "H264",
    microseconds,
  });

// `logger` is a required option of the server.
const quietLogger = { info() {}, log() {}, warn() {}, debug() {}, error() {} };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, what: string, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
};

function buildApi() {
  const sessions: Array<{
    release: ReturnType<typeof vi.fn>;
    invalidate: ReturnType<typeof vi.fn>;
  }> = [];
  const permits = { held: 0, taken: 0 };
  const api = {
    client: {
      acquirePermit: vi.fn(() => {
        permits.held++;
        permits.taken++;
        return () => {
          permits.held--;
        };
      }),
    },
    createDedicatedSession: vi.fn(async () => {
      const session = {
        client: {},
        release: vi.fn(async () => {}),
        invalidate: vi.fn(async () => {}),
      };
      sessions.push(session);
      return session;
    }),
    getDedicatedSessionsSummary: () => [],
    getStreamMetadata: vi.fn(async () => ({ streams: [] })),
  };
  return { api, sessions, permits };
}

/**
 * The camera: delivers a keyframe every 40 ms on whichever native stream was
 * opened last and has been started, until it is paused.
 */
function startCamera() {
  // Every session has its own clock: it restarts with the stream.
  let microseconds = 0;
  let clockOf: FakeNativeStream | undefined;
  let paused = false;
  const timer = setInterval(() => {
    const current = nativeStreams[nativeStreams.length - 1];
    if (paused || !current || current.start.mock.calls.length === 0) return;
    if (clockOf !== current) {
      clockOf = current;
      microseconds = 0;
    }
    microseconds += 40_000;
    emitKeyframe(current, microseconds);
  }, 40);
  return {
    pause: () => (paused = true),
    resume: () => (paused = false),
    off: () => clearInterval(timer),
  };
}

/** Opens the server and a connected TCP consumer that is receiving video. */
async function openConsumer(
  deviceId: string,
  extra: Record<string, unknown> = {},
) {
  const { api, sessions, permits } = buildApi();
  const camera = startCamera();
  const server = await createRfc4571TcpServer({
    api: api as never,
    channel: 0,
    profile: "main",
    host: "127.0.0.1",
    deviceId,
    closeApiOnTeardown: false,
    idleTeardownMs: 60_000,
    logger: quietLogger,
    ...extra,
  } as never);

  const consumer = net.connect(server.port, "127.0.0.1");
  const state = { bytes: 0, closed: false };
  consumer.on("data", (d) => (state.bytes += d.length));
  consumer.on("close", () => (state.closed = true));
  consumer.on("error", () => {});
  await until(() => state.bytes > 0, "the first video bytes");
  return { server, consumer, state, sessions, api, camera, permits };
}

const SLOW = 30_000;

describe("RFC4571 server — native stream lost mid-stream", () => {
  afterEach(() => {
    nativeStreams.length = 0;
  });

  it(
    "D2C_DISC: the consumer connection stays open and video resumes on it",
    async () => {
      const { server, consumer, state, sessions, api, camera } =
        await openConsumer("heal-disc");
      expect(nativeStreams).toHaveLength(1);

      // The camera drops the transport under the stream.
      nativeStreams[0]!.emit("close");
      const atLoss = state.bytes;

      await until(() => nativeStreams.length === 2, "the re-requested stream");
      expect(sessions[0]!.invalidate).toHaveBeenCalledOnce();
      expect(api.createDedicatedSession).toHaveBeenCalledTimes(2);

      await until(() => state.bytes > atLoss, "video after the outage");
      expect(state.closed).toBe(false);
      expect(server.server.listening).toBe(true);

      camera.off();
      consumer.destroy();
      await server.close();
    },
    SLOW,
  );

  it(
    "silent pause: the consumer connection stays open and video resumes on it",
    async () => {
      const { server, consumer, state, sessions, camera, permits } =
        await openConsumer("heal-silent", { uptimeRestartMs: 400 });
      expect(nativeStreams).toHaveLength(1);
      expect(permits.taken).toBe(0);

      // The firmware stops sending; nothing closes, nothing errors.
      camera.pause();
      await until(() => nativeStreams.length === 2, "the re-requested stream");
      expect(sessions[0]!.invalidate).toHaveBeenCalledOnce();
      expect(state.closed).toBe(false);
      // The command socket is held open for the outage only.
      expect(permits.held).toBe(1);

      const atLoss = state.bytes;
      camera.resume();
      await until(() => state.bytes > atLoss, "video after the pause");
      expect(state.closed).toBe(false);
      expect(permits.held).toBe(0);
      expect(server.server.listening).toBe(true);

      camera.off();
      consumer.destroy();
      await server.close();
    },
    SLOW,
  );

  it(
    "the recovery permit is released when the server is closed mid-outage",
    async () => {
      const { server, consumer, camera, permits } = await openConsumer(
        "heal-permit-close",
        { uptimeRestartMs: 400 },
      );
      camera.pause();
      await until(() => permits.held === 1, "the permit taken for the outage");

      camera.off();
      consumer.destroy();
      await server.close();
      expect(permits.held).toBe(0);
      expect(permits.taken).toBe(1);
    },
    SLOW,
  );

  it(
    "the recovery permit is released when recovery gives up",
    async () => {
      const { server, consumer, camera, permits } = await openConsumer(
        "heal-permit-giveup",
        { uptimeRestartMs: 400, resilience: { maxRecoveryMs: 1_500 } },
      );
      camera.pause();
      await until(() => permits.held === 1, "the permit taken for the outage");
      // The budget is spent: the wrapper gives up and the permit goes back
      // without anyone calling close() on the server.
      await until(() => permits.held === 0, "the permit released on give-up", 15_000);
      expect(permits.taken).toBeGreaterThanOrEqual(1);

      camera.off();
      consumer.destroy();
      await server.close();
    },
    SLOW,
  );

  it(
    "creation is not held open by a frame-rate read that is never answered",
    async () => {
      const { api } = buildApi();
      api.getStreamMetadata = vi.fn(() => new Promise<never>(() => {}));
      const camera = startCamera();
      const startedAt = Date.now();
      const server = await createRfc4571TcpServer({
        api: api as never,
        channel: 0,
        profile: "main",
        host: "127.0.0.1",
        deviceId: "heal-metadata",
        closeApiOnTeardown: false,
        idleTeardownMs: 60_000,
        logger: quietLogger,
      } as never);
      // The read is given 5 s, then creation goes on without the hint.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_900);
      expect(server.server.listening).toBe(true);
      camera.off();
      await server.close();
    },
    SLOW,
  );
});
