/**
 * Probe: how many times does a DESCRIBE/PLAY cycle read stream metadata
 * from the camera?
 *
 * Reading metadata issues a real Baichuan getEncXml. On a battery camera that
 * wakes it, so it must happen once per stream, not once per client connection
 * (issue #35). This measures the real behaviour against real hardware and
 * records *where* each call comes from, so the fix can be aimed at the path
 * that is actually hit rather than the one that looks likely.
 *
 * Read-only: connects, describes, plays briefly, tears down.
 *
 *   npx tsx test/_scratch/probe-describe-metadata.ts
 */

import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi.js";
import { BaichuanRtspServer } from "../../src/baichuan/stream/BaichuanRtspServer.js";

dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.env"),
});

const HOST = process.env.TCP_HOST!;
const USER = process.env.TCP_USERNAME!;
const PASS = process.env.TCP_PASSWORD!;
const PORT = 19311;
const PROFILE = "sub" as const;
const CYCLES = 4;

/** Callers of getStreamMetadata, keyed by the first in-repo frame. */
const callers = new Map<string, number>();
let metadataCalls = 0;

function recordCaller(stack: string | undefined): void {
  const frame =
    (stack ?? "")
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .find(
        (l) =>
          (l.includes("/src/") || l.includes("/app/")) &&
          !l.includes("ReolinkBaichuanApi.ts"),
      ) ?? "(unknown)";
  callers.set(frame, (callers.get(frame) ?? 0) + 1);
}

function rtspCycle(index: number): Promise<{ describeOk: boolean; bytes: number }> {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, "127.0.0.1");
    let buf = "";
    let bytes = 0;
    let cseq = 1;
    let session = "";
    let describeOk = false;
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ describeOk, bytes });
    };

    const send = (req: string) => sock.write(req);
    const url = `rtsp://127.0.0.1:${PORT}/probe/${PROFILE}`;

    sock.on("connect", () =>
      send(`DESCRIBE ${url} RTSP/1.0\r\nCSeq: ${cseq}\r\nAccept: application/sdp\r\n\r\n`),
    );

    sock.on("data", (d) => {
      bytes += d.length;
      buf += d.toString("binary");
      if (!describeOk && buf.includes("\r\n\r\n") && buf.startsWith("RTSP/1.0 200")) {
        describeOk = true;
        buf = "";
        cseq = 2;
        send(
          `SETUP ${url}/trackID=0 RTSP/1.0\r\nCSeq: ${cseq}\r\n` +
            `Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n`,
        );
        return;
      }
      if (describeOk && !session) {
        const m = /Session:\s*([^\s;\r\n]+)/i.exec(buf);
        if (m) {
          session = m[1]!;
          cseq = 3;
          send(`PLAY ${url} RTSP/1.0\r\nCSeq: ${cseq}\r\nSession: ${session}\r\n\r\n`);
          // Let a little media flow, then tear down like a real client.
          setTimeout(() => {
            send(`TEARDOWN ${url} RTSP/1.0\r\nCSeq: 4\r\nSession: ${session}\r\n\r\n`);
            setTimeout(done, 200);
          }, 2500);
        }
      }
    });

    sock.on("error", done);
    setTimeout(done, 15000);
  });
}

async function main(): Promise<void> {
  console.log(`Camera ${HOST} · profile=${PROFILE} · ${CYCLES} DESCRIBE/PLAY cycles\n`);

  const api = new ReolinkBaichuanApi({
    host: HOST,
    port: 9000,
    username: USER,
    password: PASS,
    transport: "tcp",
  });
  await api.login();
  console.log(`logged in (transport=${api.client.getTransport()})\n`);

  // Count every metadata read and remember who asked for it.
  const original = api.getStreamMetadata.bind(api);
  (api as any).getStreamMetadata = async (channel?: number) => {
    metadataCalls++;
    recordCaller(new Error().stack);
    return original(channel);
  };

  const server = new BaichuanRtspServer({
    api,
    channel: 0,
    profile: PROFILE,
    listenHost: "127.0.0.1",
    listenPort: PORT,
    path: `/probe/${PROFILE}`,
    // Exactly how the manager configures every camera.
    lazyMetadata: true,
    nativeStreamIdleStopMs: 30_000,
  } as any);

  await server.start();
  const afterStart = metadataCalls;
  console.log(`after start():            ${afterStart} metadata read(s)  (lazyMetadata → expect 0)\n`);

  for (let i = 1; i <= CYCLES; i++) {
    const before = metadataCalls;
    const r = await rtspCycle(i);
    console.log(
      `cycle ${i}: describe=${r.describeOk ? "ok" : "FAIL"} bytes=${r.bytes} ` +
        `→ metadata reads this cycle: ${metadataCalls - before}`,
    );
  }

  console.log(`\ntotal metadata reads: ${metadataCalls} across ${CYCLES} cycles`);
  console.log("callers:");
  for (const [frame, n] of [...callers].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}×  ${frame}`);
  }
  console.log(
    metadataCalls <= 1
      ? "\nRESULT: camera is read at most once — reconnects do not wake it."
      : `\nRESULT: camera is read ${metadataCalls}× — reconnects still hit it.`,
  );

  await server.stop();
  await api.disconnect?.();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
