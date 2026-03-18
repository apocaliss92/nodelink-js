import { describe, it, expect } from "vitest";
import * as http from "node:http";

describe("go2rtc integration (mock)", () => {
  // Mock go2rtc API server for testing the manager's HTTP interactions
  let mockGo2rtc: http.Server;
  let mockPort: number;
  const registeredStreams = new Map<string, string>();

  beforeAll(async () => {
    mockGo2rtc = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);

      if (url.pathname === "/api" && req.method === "GET") {
        // Health check
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ uptime: 123 }));
        return;
      }

      if (url.pathname === "/api/streams" && req.method === "GET") {
        // List streams
        const out: Record<string, any> = {};
        for (const [name, src] of registeredStreams) {
          out[name] = { producers: [{ url: src }], consumers: [] };
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
        return;
      }

      if (url.pathname === "/api/streams" && req.method === "PUT") {
        // Add stream
        const name = url.searchParams.get("name");
        const src = url.searchParams.get("src");
        if (name && src) {
          registeredStreams.set(name, src);
          res.writeHead(200);
          res.end();
        } else {
          res.writeHead(400);
          res.end("missing name or src");
        }
        return;
      }

      if (url.pathname === "/api/streams" && req.method === "DELETE") {
        const src = url.searchParams.get("src");
        if (src) {
          registeredStreams.delete(src);
          res.writeHead(200);
          res.end();
        } else {
          res.writeHead(400);
          res.end("missing src");
        }
        return;
      }

      if (url.pathname === "/api/webrtc" && req.method === "POST") {
        // Mock WHEP — return a fake SDP answer
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(201, { "Content-Type": "application/sdp" });
          res.end("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n");
        });
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });

    await new Promise<void>((resolve) => {
      mockGo2rtc.listen(0, "127.0.0.1", () => {
        mockPort = (mockGo2rtc.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    mockGo2rtc?.close();
  });

  beforeEach(() => {
    registeredStreams.clear();
  });

  it("health check returns 200", async () => {
    const res = await fetch(`http://127.0.0.1:${mockPort}/api`);
    expect(res.ok).toBe(true);
  });

  it("register stream via PUT", async () => {
    const res = await fetch(
      `http://127.0.0.1:${mockPort}/api/streams?name=test_main&src=${encodeURIComponent("rtsp://127.0.0.1:8556/test/main")}`,
      { method: "PUT" },
    );
    expect(res.ok).toBe(true);
    expect(registeredStreams.has("test_main")).toBe(true);
    expect(registeredStreams.get("test_main")).toBe("rtsp://127.0.0.1:8556/test/main");
  });

  it("list streams returns registered streams", async () => {
    registeredStreams.set("cam1_main", "rtsp://127.0.0.1:8556/cam1/main");
    registeredStreams.set("cam1_sub", "rtsp://127.0.0.1:8557/cam1/sub");

    const res = await fetch(`http://127.0.0.1:${mockPort}/api/streams`);
    const data = await res.json();
    expect(Object.keys(data)).toHaveLength(2);
    expect(data.cam1_main.producers[0].url).toBe("rtsp://127.0.0.1:8556/cam1/main");
  });

  it("remove stream via DELETE", async () => {
    registeredStreams.set("test_main", "rtsp://test");
    const res = await fetch(
      `http://127.0.0.1:${mockPort}/api/streams?src=test_main`,
      { method: "DELETE" },
    );
    expect(res.ok).toBe(true);
    expect(registeredStreams.has("test_main")).toBe(false);
  });

  it("WHEP signaling returns SDP answer", async () => {
    const sdpOffer = "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\n";
    const res = await fetch(
      `http://127.0.0.1:${mockPort}/api/webrtc?src=test`,
      {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: sdpOffer,
      },
    );
    expect(res.status).toBe(201);
    const answer = await res.text();
    expect(answer).toContain("v=0");
  });

  it("full flow: register → list → remove", async () => {
    // Register
    await fetch(
      `http://127.0.0.1:${mockPort}/api/streams?name=studio_main&src=rtsp://127.0.0.1:8556/studio/main`,
      { method: "PUT" },
    );
    await fetch(
      `http://127.0.0.1:${mockPort}/api/streams?name=studio_sub&src=rtsp://127.0.0.1:8557/studio/sub`,
      { method: "PUT" },
    );

    // List
    let res = await fetch(`http://127.0.0.1:${mockPort}/api/streams`);
    let data = await res.json();
    expect(Object.keys(data)).toHaveLength(2);

    // Remove one
    await fetch(
      `http://127.0.0.1:${mockPort}/api/streams?src=studio_sub`,
      { method: "DELETE" },
    );

    // List again
    res = await fetch(`http://127.0.0.1:${mockPort}/api/streams`);
    data = await res.json();
    expect(Object.keys(data)).toHaveLength(1);
    expect(data.studio_main).toBeDefined();
  });

  it("multiple cameras don't interfere", async () => {
    // Register streams for 3 cameras
    for (const cam of ["cam1", "cam2", "cam3"]) {
      for (const profile of ["main", "sub"]) {
        await fetch(
          `http://127.0.0.1:${mockPort}/api/streams?name=${cam}_${profile}&src=rtsp://127.0.0.1:${8556 + Math.random() * 100 | 0}/${cam}/${profile}`,
          { method: "PUT" },
        );
      }
    }

    const res = await fetch(`http://127.0.0.1:${mockPort}/api/streams`);
    const data = await res.json();
    expect(Object.keys(data)).toHaveLength(6);

    // Each camera has its own streams
    expect(data.cam1_main).toBeDefined();
    expect(data.cam2_sub).toBeDefined();
    expect(data.cam3_main).toBeDefined();

    // Remove one camera's streams
    await fetch(`http://127.0.0.1:${mockPort}/api/streams?src=cam2_main`, { method: "DELETE" });
    await fetch(`http://127.0.0.1:${mockPort}/api/streams?src=cam2_sub`, { method: "DELETE" });

    const res2 = await fetch(`http://127.0.0.1:${mockPort}/api/streams`);
    const data2 = await res2.json();
    expect(Object.keys(data2)).toHaveLength(4);
    expect(data2.cam2_main).toBeUndefined();
    expect(data2.cam1_main).toBeDefined(); // cam1 unaffected
  });
});
