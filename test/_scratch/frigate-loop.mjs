/**
 * Reproduce the client behaviour from issue #35: hold an RTSP session for a
 * couple of seconds, tear it down, wait so the camera has time to fall asleep
 * and the manager's idle-disconnect fires, then reconnect. Repeat.
 *
 * The earlier probes cycled every few seconds, which kept the camera awake,
 * the API connection up and the RTSP servers alive — so nothing that the
 * reported loop depends on ever happened.
 *
 *   node test/_scratch/frigate-loop.mjs <path> <minutes> [periodSeconds]
 */
import * as net from "node:net";

const PATH = process.argv[2] ?? "/argus3_repro/sub";
const MINUTES = Number(process.argv[3] ?? 5);
const PERIOD_S = Number(process.argv[4] ?? 22);
const HOLD_MS = 2000;
const HOST = "127.0.0.1";
const PORT = 8554;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function session() {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, HOST);
    const url = `rtsp://${HOST}:${PORT}${PATH}`;
    let buf = "";
    let stage = "describe";
    let bytes = 0;
    let done = false;
    const finish = (note) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ note, bytes });
    };
    sock.on("connect", () =>
      sock.write(`DESCRIBE ${url} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n`),
    );
    sock.on("data", (d) => {
      bytes += d.length;
      buf += d.toString("binary");
      if (stage === "describe" && buf.includes("\r\n\r\n")) {
        stage = "setup";
        buf = "";
        sock.write(
          `SETUP ${url}/trackID=0 RTSP/1.0\r\nCSeq: 2\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n`,
        );
        return;
      }
      if (stage === "setup") {
        const m = /Session:\s*([^\s;\r\n]+)/i.exec(buf);
        if (m) {
          stage = "play";
          const s = m[1];
          sock.write(`PLAY ${url} RTSP/1.0\r\nCSeq: 3\r\nSession: ${s}\r\n\r\n`);
          setTimeout(() => {
            sock.write(`TEARDOWN ${url} RTSP/1.0\r\nCSeq: 4\r\nSession: ${s}\r\n\r\n`);
            setTimeout(() => finish("ok"), 150);
          }, HOLD_MS);
        }
      }
    });
    sock.on("error", (e) => finish(`err:${e.code ?? e.message}`));
    setTimeout(() => finish("timeout"), 15000);
  });
}

const cycles = Math.ceil((MINUTES * 60) / PERIOD_S);
console.log(`loop: ${cycles} cycles × ${PERIOD_S}s on ${PATH}`);
for (let i = 1; i <= cycles; i++) {
  const r = await session();
  console.log(`[${new Date().toISOString().slice(11, 19)}] cycle ${i}/${cycles}: ${r.note} (${r.bytes}B)`);
  await sleep(PERIOD_S * 1000 - HOLD_MS);
}
console.log("loop done");
