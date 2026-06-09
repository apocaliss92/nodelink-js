/**
 * Wire-level tests for the dedicated `BaichuanRtspBackchannelServer`.
 *
 * Talks to the listener over a real localhost TCP socket so the request /
 * response parsing, interleaved-RTP routing and TalkSession plumbing get
 * exercised end-to-end. The Baichuan API and the talk session are mocked so
 * the test never touches a camera.
 */

import { describe, it, expect, vi } from "vitest";
import * as net from "node:net";
import { mulaw } from "alawmulaw";
import { BaichuanRtspBackchannelServer } from "../../src/baichuan/stream/BaichuanRtspBackchannelServer";
import type { TalkSession } from "../../src/reolink/baichuan/types";

function makeFakeTalk(): {
  session: TalkSession;
  blocks: Buffer[];
  stopped: () => boolean;
} {
  const blockSize = 256;
  const blocks: Buffer[] = [];
  let isStopped = false;
  const session: TalkSession = {
    info: {
      channel: 0,
      audioConfig: {
        audioType: "adpcm",
        sampleRate: 16000,
        samplePrecision: 16,
        lengthPerEncoder: blockSize,
        soundTrack: "mono",
        priority: 0,
      },
      blockSize,
      fullBlockSize: blockSize + 4,
    },
    sendAudio: async (adpcm: Buffer) => {
      blocks.push(Buffer.from(adpcm));
    },
    stop: async () => {
      isStopped = true;
    },
  };
  return { session, blocks, stopped: () => isStopped };
}

function makeApi(opts?: {
  talk?: TalkSession;
  createSpy?: ReturnType<typeof vi.fn>;
}) {
  const talk = opts?.talk ?? makeFakeTalk().session;
  const createDedicatedTalkSession =
    opts?.createSpy ?? vi.fn(async () => talk);
  return {
    client: { getTransport: () => "tcp" as const, on: vi.fn() },
    createDedicatedTalkSession,
  } as unknown as ConstructorParameters<
    typeof BaichuanRtspBackchannelServer
  >[0]["api"];
}

function buildRtpPcmu(payload: Buffer, seq: number, timestamp: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt8(0x80, 0); // V=2
  header.writeUInt8(0, 1); // PT = 0 (PCMU)
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(0xdeadbeef, 8);
  return Buffer.concat([header, payload]);
}

function tcpInterleavedFrame(channel: number, rtp: Buffer): Buffer {
  const out = Buffer.alloc(4 + rtp.length);
  out.writeUInt8(0x24, 0);
  out.writeUInt8(channel & 0xff, 1);
  out.writeUInt16BE(rtp.length, 2);
  rtp.copy(out, 4);
  return out;
}

/**
 * Send a single RTSP request over `socket` and resolve with the full
 * status-line + headers of the next response. Caller is responsible for
 * closing the socket.
 */
function rtspRequest(
  socket: net.Socket,
  request: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = buf.subarray(0, headerEnd).toString("utf8");
      const lines = headerText.split("\r\n");
      const statusLine = lines[0] ?? "";
      const statusMatch = statusLine.match(/RTSP\/\d\.\d\s+(\d+)/);
      const status = statusMatch ? parseInt(statusMatch[1] ?? "0", 10) : 0;
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(":");
        if (idx > 0) {
          const key = line.slice(0, idx).trim();
          const value = line.slice(idx + 1).trim();
          headers[key] = value;
        }
      }
      const contentLength = headers["Content-Length"]
        ? parseInt(headers["Content-Length"], 10)
        : 0;
      if (buf.length < headerEnd + 4 + contentLength) return;
      const body = buf
        .subarray(headerEnd + 4, headerEnd + 4 + contentLength)
        .toString("utf8");
      socket.removeListener("data", onData);
      resolve({ status, headers, body });
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(request, "utf8");
  });
}

async function newServerOnEphemeralPort(
  api: ConstructorParameters<typeof BaichuanRtspBackchannelServer>[0]["api"],
): Promise<{ server: BaichuanRtspBackchannelServer; port: number }> {
  const server = new BaichuanRtspBackchannelServer({
    api,
    channel: 0,
    listenHost: "127.0.0.1",
    listenPort: 0,
    path: "/talk",
    logger: {
      log: () => {},
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
    } as any,
  });
  await server.start();
  const port = (server as any).server.address().port as number;
  return { server, port };
}

describe("BaichuanRtspBackchannelServer", () => {
  it("OPTIONS advertises only the backchannel-relevant methods", async () => {
    const { server, port } = await newServerOnEphemeralPort(makeApi());
    try {
      const socket = net.createConnection(port, "127.0.0.1");
      await new Promise<void>((r) => socket.once("connect", () => r()));
      const resp = await rtspRequest(
        socket,
        "OPTIONS rtsp://127.0.0.1/talk RTSP/1.0\r\nCSeq: 1\r\n\r\n",
      );
      expect(resp.status).toBe(200);
      expect(resp.headers.Public).toContain("OPTIONS");
      expect(resp.headers.Public).toContain("DESCRIBE");
      expect(resp.headers.Public).toContain("SETUP");
      expect(resp.headers.Public).toContain("RECORD");
      expect(resp.headers.Public).toContain("TEARDOWN");
      // No PLAY/PAUSE — this server is talk-only.
      expect(resp.headers.Public).not.toContain("PLAY");
      socket.destroy();
    } finally {
      await server.stop();
    }
  });

  it("DESCRIBE returns SDP with only the audiobackchannel media track", async () => {
    const { server, port } = await newServerOnEphemeralPort(makeApi());
    try {
      const socket = net.createConnection(port, "127.0.0.1");
      await new Promise<void>((r) => socket.once("connect", () => r()));
      const resp = await rtspRequest(
        socket,
        "DESCRIBE rtsp://127.0.0.1/talk RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\n\r\n",
      );
      expect(resp.status).toBe(200);
      expect(resp.headers["Content-Type"]).toBe("application/sdp");
      expect(resp.body).toContain("m=audio 0 RTP/AVP 0");
      expect(resp.body).toContain("a=rtpmap:0 PCMU/8000");
      expect(resp.body).toContain("a=sendonly");
      expect(resp.body).toContain("a=control:audiobackchannel");
      // No video track — backchannel is a per-camera concept, not per-profile.
      expect(resp.body).not.toContain("m=video");
      socket.destroy();
    } finally {
      await server.stop();
    }
  });

  it("path is profile-independent — same DESCRIBE works for any URL the server is bound to", async () => {
    const { server, port } = await newServerOnEphemeralPort(makeApi());
    try {
      const socket = net.createConnection(port, "127.0.0.1");
      await new Promise<void>((r) => socket.once("connect", () => r()));
      // No /main, /sub, /ext path component — the user is expected to point
      // at the camera-level talk URL, not a video profile URL.
      const resp = await rtspRequest(
        socket,
        "DESCRIBE rtsp://127.0.0.1/talk?backchannel=1 RTSP/1.0\r\nCSeq: 1\r\n\r\n",
      );
      expect(resp.status).toBe(200);
      expect(resp.body).toContain("audiobackchannel");
      socket.destroy();
    } finally {
      await server.stop();
    }
  });

  it("SETUP + RECORD opens a TalkSession and routes inbound RTP into it", async () => {
    const fake = makeFakeTalk();
    const createSpy = vi.fn(async () => fake.session);
    const api = makeApi({ talk: fake.session, createSpy });
    const { server, port } = await newServerOnEphemeralPort(api);
    try {
      const socket = net.createConnection(port, "127.0.0.1");
      await new Promise<void>((r) => socket.once("connect", () => r()));

      const setup = await rtspRequest(
        socket,
        "SETUP rtsp://127.0.0.1/talk/audiobackchannel RTSP/1.0\r\n" +
          "CSeq: 2\r\nTransport: RTP/AVP/TCP;unicast;interleaved=4-5\r\n\r\n",
      );
      expect(setup.status).toBe(200);
      const sessionId = setup.headers.Session ?? "";
      expect(sessionId).toBeTruthy();
      expect(setup.headers.Transport).toContain("interleaved=4-5");
      expect(setup.headers.Transport).toContain("mode=record");

      const record = await rtspRequest(
        socket,
        `RECORD rtsp://127.0.0.1/talk RTSP/1.0\r\nCSeq: 3\r\nSession: ${sessionId}\r\n\r\n`,
      );
      expect(record.status).toBe(200);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls[0]?.[0]).toBe(0);

      // Push 16 RTP frames × 160 PCM-u samples ≈ 320 ms of audio.
      // Pipeline: PCMU 8 kHz → PCM16 8 kHz → upsample to 16 kHz → ADPCM(256-byte blocks)
      // → 16 frames × 160 samples × 2 = 5120 PCM16 samples ÷ 513 = 9 full blocks + tail.
      for (let i = 0; i < 16; i++) {
        const pcm = new Int16Array(160);
        for (let j = 0; j < 160; j++) {
          pcm[j] = Math.round(
            8000 * Math.sin((2 * Math.PI * 220 * j) / 8000),
          );
        }
        const payload = Buffer.from(mulaw.encode(pcm));
        const rtp = buildRtpPcmu(payload, i + 1, i * 160);
        socket.write(tcpInterleavedFrame(4, rtp));
      }
      // Let the async pipeline drain.
      await new Promise((r) => setTimeout(r, 80));
      const totalAdpcm = fake.blocks.reduce((acc, b) => acc + b.length, 0);
      const blockBytes = 4 + 256;
      expect(totalAdpcm % blockBytes).toBe(0);
      expect(totalAdpcm / blockBytes).toBe(9);

      // TEARDOWN cleans up.
      const teardown = await rtspRequest(
        socket,
        `TEARDOWN rtsp://127.0.0.1/talk RTSP/1.0\r\nCSeq: 4\r\nSession: ${sessionId}\r\n\r\n`,
      );
      expect(teardown.status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect(fake.stopped()).toBe(true);
      socket.destroy();
    } finally {
      await server.stop();
    }
  });

  it("rejects SETUP with UDP transport (461)", async () => {
    const { server, port } = await newServerOnEphemeralPort(makeApi());
    try {
      const socket = net.createConnection(port, "127.0.0.1");
      await new Promise<void>((r) => socket.once("connect", () => r()));
      const resp = await rtspRequest(
        socket,
        "SETUP rtsp://127.0.0.1/talk/audiobackchannel RTSP/1.0\r\n" +
          "CSeq: 1\r\nTransport: RTP/AVP/UDP;unicast;client_port=4000-4001\r\n\r\n",
      );
      expect(resp.status).toBe(461);
      socket.destroy();
    } finally {
      await server.stop();
    }
  });

  it("socket close stops any in-flight TalkSession", async () => {
    const fake = makeFakeTalk();
    const api = makeApi({ talk: fake.session });
    const { server, port } = await newServerOnEphemeralPort(api);
    try {
      const socket = net.createConnection(port, "127.0.0.1");
      await new Promise<void>((r) => socket.once("connect", () => r()));
      const setup = await rtspRequest(
        socket,
        "SETUP rtsp://127.0.0.1/talk/audiobackchannel RTSP/1.0\r\n" +
          "CSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=4-5\r\n\r\n",
      );
      const sessionId = setup.headers.Session ?? "";
      await rtspRequest(
        socket,
        `RECORD rtsp://127.0.0.1/talk RTSP/1.0\r\nCSeq: 2\r\nSession: ${sessionId}\r\n\r\n`,
      );
      socket.destroy();
      await new Promise((r) => setTimeout(r, 30));
      expect(fake.stopped()).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

describe("BaichuanRtspBackchannelServer — multi-tenant path routing", () => {
  const silentLogger = {
    log: () => {},
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  } as any;

  async function newMultiCameraServer(routes: {
    [path: string]: { api: any; channel: number };
  }): Promise<{ server: BaichuanRtspBackchannelServer; port: number }> {
    const server = new BaichuanRtspBackchannelServer({
      routes,
      listenHost: "127.0.0.1",
      listenPort: 0,
      logger: silentLogger,
    });
    await server.start();
    const port = (server as any).server.address().port as number;
    return { server, port };
  }

  it("routes DESCRIBE to the correct camera and 404s unknown paths", async () => {
    const apiA = makeApi();
    const apiB = makeApi();
    const { server, port } = await newMultiCameraServer({
      "/camA": { api: apiA, channel: 0 },
      "/camB": { api: apiB, channel: 1 },
    });
    try {
      const sock = net.createConnection(port, "127.0.0.1");
      await new Promise<void>((r) => sock.once("connect", () => r()));

      const a = await rtspRequest(
        sock,
        "DESCRIBE rtsp://127.0.0.1/camA RTSP/1.0\r\nCSeq: 1\r\n\r\n",
      );
      expect(a.status).toBe(200);
      expect(a.headers["Content-Base"]).toContain("/camA/");

      const b = await rtspRequest(
        sock,
        "DESCRIBE rtsp://127.0.0.1/camB?backchannel=1 RTSP/1.0\r\nCSeq: 2\r\n\r\n",
      );
      expect(b.status).toBe(200);
      expect(b.headers["Content-Base"]).toContain("/camB/");

      const miss = await rtspRequest(
        sock,
        "DESCRIBE rtsp://127.0.0.1/unknown RTSP/1.0\r\nCSeq: 3\r\n\r\n",
      );
      expect(miss.status).toBe(404);
      sock.destroy();
    } finally {
      await server.stop();
    }
  });

  it("RECORD opens the TalkSession on the camera matching the SETUP path", async () => {
    const fakeA = makeFakeTalk();
    const fakeB = makeFakeTalk();
    const createA = vi.fn(async () => fakeA.session);
    const createB = vi.fn(async () => fakeB.session);
    const apiA = makeApi({ talk: fakeA.session, createSpy: createA });
    const apiB = makeApi({ talk: fakeB.session, createSpy: createB });

    const { server, port } = await newMultiCameraServer({
      "/camA": { api: apiA, channel: 0 },
      "/camB": { api: apiB, channel: 7 },
    });
    try {
      const sock = net.createConnection(port, "127.0.0.1");
      await new Promise<void>((r) => sock.once("connect", () => r()));

      const setup = await rtspRequest(
        sock,
        "SETUP rtsp://127.0.0.1/camB/audiobackchannel RTSP/1.0\r\n" +
          "CSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n",
      );
      expect(setup.status).toBe(200);
      const sessionId = setup.headers.Session ?? "";
      expect(sessionId).not.toBe("");

      const record = await rtspRequest(
        sock,
        `RECORD rtsp://127.0.0.1/camB RTSP/1.0\r\nCSeq: 2\r\nSession: ${sessionId}\r\n\r\n`,
      );
      expect(record.status).toBe(200);

      expect(createA).not.toHaveBeenCalled();
      expect(createB).toHaveBeenCalledTimes(1);
      // First positional argument is the channel.
      expect(createB.mock.calls[0]?.[0]).toBe(7);

      sock.destroy();
    } finally {
      await server.stop();
    }
  });

  it("addRoute / removeRoute work at runtime", async () => {
    const apiA = makeApi();
    const apiB = makeApi();
    const { server, port } = await newMultiCameraServer({
      "/camA": { api: apiA, channel: 0 },
    });
    try {
      // Initially camB is unknown.
      let sock = net.createConnection(port, "127.0.0.1");
      await new Promise<void>((r) => sock.once("connect", () => r()));
      const before = await rtspRequest(
        sock,
        "DESCRIBE rtsp://127.0.0.1/camB RTSP/1.0\r\nCSeq: 1\r\n\r\n",
      );
      expect(before.status).toBe(404);
      sock.destroy();

      // Register at runtime.
      server.addRoute("/camB", { api: apiB, channel: 3 });
      expect(server.hasRoute("/camB")).toBe(true);
      expect(server.listRoutes().sort()).toEqual(["/camA", "/camB"]);

      sock = net.createConnection(port, "127.0.0.1");
      await new Promise<void>((r) => sock.once("connect", () => r()));
      const after = await rtspRequest(
        sock,
        "DESCRIBE rtsp://127.0.0.1/camB RTSP/1.0\r\nCSeq: 1\r\n\r\n",
      );
      expect(after.status).toBe(200);
      sock.destroy();

      // Unregister; goes back to 404.
      expect(server.removeRoute("/camB")).toBe(true);
      sock = net.createConnection(port, "127.0.0.1");
      await new Promise<void>((r) => sock.once("connect", () => r()));
      const gone = await rtspRequest(
        sock,
        "DESCRIBE rtsp://127.0.0.1/camB RTSP/1.0\r\nCSeq: 1\r\n\r\n",
      );
      expect(gone.status).toBe(404);
      sock.destroy();
    } finally {
      await server.stop();
    }
  });

  it("rejects construction with both single-camera and multi-tenant config", () => {
    expect(
      () =>
        new BaichuanRtspBackchannelServer({
          api: makeApi(),
          channel: 0,
          routes: { "/x": { api: makeApi(), channel: 0 } },
          listenHost: "127.0.0.1",
          listenPort: 0,
          logger: silentLogger,
        }),
    ).toThrow(/single camera.*multi tenant|both/i);
  });

  it("requires at least one configuration mode", () => {
    expect(
      () =>
        new BaichuanRtspBackchannelServer({
          listenHost: "127.0.0.1",
          listenPort: 0,
          logger: silentLogger,
        }),
    ).toThrow();
  });
});
