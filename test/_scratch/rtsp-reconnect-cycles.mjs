/**
 * Simulate the client reconnect loop from issue #35 against a running manager.
 *
 * Frigate/go2rtc tore the RTSP session down and reconnected every ~22s. Each
 * reconnect used to end up reading the camera's encoder config, which wakes a
 * battery camera. This drives the same loop against the local mux so the
 * manager's log can be checked for camera reads.
 *
 *   node test/_scratch/rtsp-reconnect-cycles.mjs <path> <cycles>
 */
import * as net from "node:net";

const PATH = process.argv[2] ?? "/cameretta_daniel/sub";
const CYCLES = Number(process.argv[3] ?? 5);
const HOST = "127.0.0.1";
const PORT = 8554;

function cycle(i) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, HOST);
    const url = `rtsp://${HOST}:${PORT}${PATH}`;
    let buf = "";
    let stage = "describe";
    let session = "";
    let bytes = 0;
    let done = false;

    const finish = (note) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ i, note, bytes });
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
          `SETUP ${url}/trackID=0 RTSP/1.0\r\nCSeq: 2\r\n` +
            `Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n`,
        );
        return;
      }
      if (stage === "setup") {
        const m = /Session:\s*([^\s;\r\n]+)/i.exec(buf);
        if (m) {
          session = m[1];
          stage = "play";
          sock.write(`PLAY ${url} RTSP/1.0\r\nCSeq: 3\r\nSession: ${session}\r\n\r\n`);
          setTimeout(() => {
            sock.write(`TEARDOWN ${url} RTSP/1.0\r\nCSeq: 4\r\nSession: ${session}\r\n\r\n`);
            setTimeout(() => finish("ok"), 150);
          }, 1500);
        }
      }
    });
    sock.on("error", (e) => finish(`error: ${e.message}`));
    setTimeout(() => finish("timeout"), 12000);
  });
}

for (let i = 1; i <= CYCLES; i++) {
  const r = await cycle(i);
  console.log(`cycle ${r.i}: ${r.note} (${r.bytes} bytes)`);
}
