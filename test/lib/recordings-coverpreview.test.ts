/**
 * CoverPreview (cmd 298) — the recording thumbnail — against the payloads
 * captured 2026-09-20 from an E1 Outdoor PoE (v3.1.0.5223, `1002` stream
 * header, 640×360 @15) and a Reolink Home Hub child (v3.3.0.456, `1001`
 * header, 896×512 @30). The fixture payloads keep the stream header, the
 * frame wrapper and the first 48 bytes of the SPS/PPS NAL; the picture bytes
 * are zeroed (see `test/fixtures/recordings/README.md`).
 *
 * Pins three things:
 *   - the request XML the library builds, including `<uid>` on a hub child;
 *   - the parse of both firmware header shapes;
 *   - the 0.7.8 fixes: a zero-length window is widened (the camera answers
 *     400 to `end == start`), and the JPEG wrappers forward `uid`/`timeZone`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

const FIX = join(__dirname, "..", "fixtures", "recordings");
const ROME = "Europe/Rome";

type CoverCall = {
  cmdId: number;
  channelIdOverride?: number;
  msgNumOverride?: number;
  payloadXml?: string;
  streamType?: number;
};

function makeApi(): {
  api: ReolinkBaichuanApi;
  calls: CoverCall[];
  serve: (payload: Buffer) => void;
} {
  const api = new ReolinkBaichuanApi({
    host: "127.0.0.1",
    port: 65535, // bound to nothing; the constructor does not connect
    username: "u",
    password: "p",
    transport: "tcp",
    nativeOnly: true,
  });
  const calls: CoverCall[] = [];
  let payload = Buffer.alloc(0);
  const client = (api as unknown as { client: Record<string, unknown> }).client;
  client["login"] = async () => undefined;
  client["sendBinaryCoverPreview"] = async (p: CoverCall) => {
    calls.push(p);
    return payload;
  };
  return {
    api,
    calls,
    serve: (b) => {
      payload = b;
    },
  };
}

const normalise = (xml: string): string => xml.replace(/\s+/g, "");

const apis: ReolinkBaichuanApi[] = [];
afterEach(async () => {
  for (const a of apis.splice(0)) await a.close();
});

describe("getVideoclipThumbnail against captured payloads", () => {
  it("standalone: request matches the capture, `1002` header parsed", async () => {
    const { api, calls, serve } = makeApi();
    apis.push(api);
    api.setIsNvr(false);
    serve(
      readFileSync(join(FIX, "standalone", "coverpreview-298-payload.bin")),
    );
    const meta = JSON.parse(
      readFileSync(
        join(FIX, "standalone", "coverpreview-298-meta.json"),
        "utf8",
      ),
    );

    const result = await api.getVideoclipThumbnail({
      channel: 0,
      isNvr: false,
      time: new Date(Date.UTC(2026, 8, 19, 10, 49, 14)),
      endTime: new Date(Date.UTC(2026, 8, 19, 10, 49, 28)),
      timeZone: ROME,
    });

    expect(calls).toHaveLength(1);
    expect(normalise(calls[0]!.payloadXml ?? "")).toBe(
      normalise(
        readFileSync(
          join(FIX, "standalone", "coverpreview-298-request.xml"),
          "utf8",
        ),
      ),
    );
    expect(calls[0]!.channelIdOverride).toBeUndefined(); // standalone: session counter
    expect(calls[0]!.msgNumOverride).toBe(0);
    expect(result.encoding).toBe("H264");
    expect(result.streamInfo).toEqual(meta.parsed.streamInfo);
    expect(result.frameLength).toBe(meta.parsed.frameLength);
    expect(result.frame.subarray(0, 5)).toEqual(
      Buffer.from([0, 0, 0, 1, 0x67]),
    );
  });

  it("hub child: `<uid>` in the body, header channelId 250 without a push cache, `1001` header parsed", async () => {
    const { api, calls, serve } = makeApi();
    apis.push(api);
    api.setIsNvr(true);
    serve(readFileSync(join(FIX, "hub", "coverpreview-298-payload.bin")));
    const meta = JSON.parse(
      readFileSync(join(FIX, "hub", "coverpreview-298-meta.json"), "utf8"),
    );

    const result = await api.getVideoclipThumbnail({
      channel: 1,
      uid: "9527000HUBCHILD1",
      isNvr: true,
      time: new Date(Date.UTC(2026, 8, 19, 19, 20, 27)),
      endTime: new Date(Date.UTC(2026, 8, 19, 19, 20, 42)),
      timeZone: ROME,
    });

    expect(normalise(calls[0]!.payloadXml ?? "")).toBe(
      normalise(
        readFileSync(join(FIX, "hub", "coverpreview-298-request.xml"), "utf8"),
      ),
    );
    expect(calls[0]!.payloadXml).toContain("<uid>9527000HUBCHILD1</uid>");
    // The live capture ran with the cmd 145 push cache populated, so its header
    // channelId was the cache's index (meta.request.channelIdOverride === 1);
    // with no cache the library falls back to hostChannelId 250.
    expect(meta.request.channelIdOverride).toBe(1);
    expect(calls[0]!.channelIdOverride).toBe(250);
    expect(result.encoding).toBe("H264");
    expect(result.streamInfo).toEqual(meta.parsed.streamInfo);
    expect(result.frameLength).toBe(meta.parsed.frameLength);
  });

  it("a window whose end is not after its start is widened to 10 s (the camera answers 400 otherwise)", async () => {
    const { api, calls, serve } = makeApi();
    apis.push(api);
    api.setIsNvr(false);
    serve(
      readFileSync(join(FIX, "standalone", "coverpreview-298-payload.bin")),
    );
    const t = new Date(Date.UTC(2026, 8, 19, 14, 7, 1)); // the 0 s clip of the capture
    await api.getVideoclipThumbnail({
      channel: 0,
      isNvr: false,
      time: t,
      endTime: t,
      timeZone: "UTC",
    });
    const xml = (calls[0]!.payloadXml ?? "").replace(/\s+/g, "");
    expect(xml).toContain(
      "<startTime><year>2026</year><month>9</month><day>19</day><hour>14</hour><minute>7</minute><second>1</second></startTime>",
    );
    expect(xml).toContain(
      "<endTime><year>2026</year><month>9</month><day>19</day><hour>14</hour><minute>7</minute><second>11</second></endTime>",
    );
  });
});

describe("the JPEG wrappers forward what the raw call needs", () => {
  it("getVideoclipThumbnailJpeg passes uid, isNvr and timeZone through", async () => {
    const { api } = makeApi();
    apis.push(api);
    const raw = vi.fn(async () => ({
      frame: Buffer.from([0, 0, 0, 1, 0x67]),
      encoding: "H264",
      frameLength: 5,
      streamInfo: {},
    }));
    (
      api as unknown as { getVideoclipThumbnail: unknown }
    ).getVideoclipThumbnail = raw;
    (
      api as unknown as { decodeCoverPreviewFrameToJpeg: unknown }
    ).decodeCoverPreviewFrameToJpeg = async () => Buffer.from("jpeg");

    const t = new Date(Date.UTC(2026, 8, 19, 19, 20, 27));
    const jpeg = await api.getVideoclipThumbnailJpeg({
      channel: 1,
      uid: "9527000HUBCHILD1",
      isNvr: true,
      time: t,
      endTime: new Date(t.getTime() + 15_000),
      timeZone: ROME,
    });
    expect(jpeg.toString()).toBe("jpeg");
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0]![0]).toMatchObject({
      channel: 1,
      uid: "9527000HUBCHILD1",
      isNvr: true,
      timeZone: ROME,
    });
  });
});
