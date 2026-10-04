/* eslint-disable no-console */
/**
 * Probe Baichuan webhook push (cmd 806 get / 807 set) on battery cameras.
 *
 * Usage: npx tsx test/_scratch/probe-baichuan-webhook.ts
 *
 * READ-ONLY by default (only cmd 806). Pass --set-url=http://IP:PORT/webhook
 * to exercise cmd 807, then immediately restore the previous config.
 */
import "dotenv/config";
import http from "node:http";
import { networkInterfaces } from "node:os";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

function envOr(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function pickLocalIp(towardHost: string): string {
  // Prefer a non-internal IPv4 on the same /16 as the camera when possible.
  const parts = towardHost.split(".");
  const prefix = parts.length >= 2 ? `${parts[0]}.${parts[1]}.` : "";
  const nets = networkInterfaces();
  let fallback: string | undefined;
  for (const addrs of Object.values(nets)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (prefix && a.address.startsWith(prefix)) return a.address;
      fallback ??= a.address;
    }
  }
  return fallback ?? "127.0.0.1";
}

interface Target {
  label: string;
  host: string;
  username: string;
  password: string;
  uid?: string;
  transport: "udp" | "tcp" | "auto";
}

function buildTargets(): Target[] {
  const out: Target[] = [];
  const add = (
    label: string,
    hostKey: string,
    userKey: string,
    passKey: string,
    uidKey: string,
    transport: Target["transport"],
  ) => {
    const host = envOr(hostKey);
    if (!host) return;
    out.push({
      label,
      host,
      username: envOr(userKey) ?? "admin",
      password: envOr(passKey) ?? "",
      ...(envOr(uidKey) ? { uid: envOr(uidKey) } : {}),
      transport,
    });
  };

  add(
    "UDP_STANDALONE (campanello)",
    "UDP_STANDALONE_HOST",
    "UDP_STANDALONE_USERNAME",
    "UDP_STANDALONE_PASSWORD",
    "UDP_STANDALONE_UID",
    "udp",
  );
  add("UDP (Argus)", "UDP_HOST", "UDP_USERNAME", "UDP_PASSWORD", "UDP_UID", "udp");
  add(
    "UDP_SLEEP",
    "UDP_SLEEP_HOST",
    "UDP_SLEEP_USERNAME",
    "UDP_SLEEP_PASSWORD",
    "UDP_SLEEP_UID",
    "udp",
  );
  // DOORBELL_* often lacks password in .env — skip unless present.
  if (envOr("DOORBELL_HOST") && envOr("DOORBELL_PASSWORD")) {
    add(
      "DOORBELL",
      "DOORBELL_HOST",
      "DOORBELL_USERNAME",
      "DOORBELL_PASSWORD",
      "DOORBELL_UID",
      "udp",
    );
  }
  return out;
}

async function sendRaw(
  api: ReolinkBaichuanApi,
  cmdId: number,
  payloadXml?: string,
): Promise<{ responseCode?: number; xml?: string; error?: string }> {
  try {
    // sendXml throws on non-200; use lower-level client path via any.
    const xml = await (api as any).sendXml({
      cmdId,
      ...(payloadXml ? { payloadXml } : {}),
      timeoutMs: 20_000,
    });
    return { responseCode: 200, xml: typeof xml === "string" ? xml : String(xml) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Try to extract responseCode from error text if present.
    const m = /responseCode[=:]?\s*(\d+)/i.exec(msg);
    return {
      responseCode: m ? Number(m[1]) : undefined,
      error: msg,
    };
  }
}

function startTempWebhookServer(): Promise<{
  url: string;
  close: () => Promise<void>;
  events: unknown[];
}> {
  const events: unknown[] = [];
  const localIp = pickLocalIp("192.168.1.1");
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = body;
        try {
          parsed = JSON.parse(body);
        } catch {
          /* keep raw */
        }
        console.log(
          `[webhook] ${req.method} ${req.url} from ${req.socket.remoteAddress}:`,
          typeof parsed === "string" ? parsed.slice(0, 500) : parsed,
        );
        events.push({
          at: new Date().toISOString(),
          method: req.method,
          url: req.url,
          body: parsed,
        });
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
      });
    });
    server.listen(0, "0.0.0.0", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no listen address"));
        return;
      }
      const url = `http://${localIp}:${addr.port}/webhook`;
      resolve({
        url,
        events,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

async function probeOne(
  t: Target,
  opts: { setUrl?: string; keepUntilRestore?: boolean } = {},
): Promise<{ restore: () => Promise<void> } | void> {
  console.log("\n==========", t.label, t.host, "==========");
  const api = new ReolinkBaichuanApi({
    host: t.host,
    username: t.username,
    password: t.password,
    ...(t.uid ? { uid: t.uid } : {}),
    transport: t.transport,
    idleDisconnect: false,
  });

  let prevXml: string | undefined;

  try {
    console.log("login…");
    await api.login();
    console.log("login ok");

    try {
      const info = await api.getInfo();
      console.log("model:", (info as any)?.model ?? (info as any)?.type ?? info);
    } catch (e) {
      console.log("getInfo failed:", (e as Error).message);
    }

    try {
      const bat = await api.getBatteryInfo?.(0);
      console.log("battery:", bat);
    } catch (e) {
      console.log("getBatteryInfo failed:", (e as Error).message);
    }

    try {
      const ps = await (api as any).getPowerSource?.();
      console.log("powerSource:", ps);
    } catch (e) {
      console.log("getPowerSource failed:", (e as Error).message);
    }

    console.log("cmd 806 (get HaCfg / webhook)…");
    const get806 = await sendRaw(api, 806);
    console.log("806:", {
      responseCode: get806.responseCode,
      error: get806.error?.slice(0, 300),
      xml: get806.xml?.slice(0, 800),
    });

    if (!opts.setUrl) return;

    prevXml = get806.xml;
    console.log("cmd 807 set url=", opts.setUrl);
    const setXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<HaCfg version="1.1">
<enable>1</enable>
<url>${opts.setUrl}</url>
<verify_cert>0</verify_cert>
</HaCfg>
</body>`;
    const set807 = await sendRaw(api, 807, setXml);
    console.log("807 set:", {
      responseCode: set807.responseCode,
      error: set807.error?.slice(0, 300),
      xml: set807.xml?.slice(0, 400),
    });

    const verify = await sendRaw(api, 806);
    console.log("806 after set:", {
      responseCode: verify.responseCode,
      xml: verify.xml?.slice(0, 800),
    });

    // Mirror reolink_aio: also send cmd 31 when enabling webhook.
    try {
      await api.subscribeEvents();
      console.log("cmd 31 subscribeEvents: ok");
    } catch (e) {
      console.log("cmd 31 subscribeEvents failed:", (e as Error).message);
    }

    const restore = async () => {
      const restoreApi = new ReolinkBaichuanApi({
        host: t.host,
        username: t.username,
        password: t.password,
        ...(t.uid ? { uid: t.uid } : {}),
        transport: t.transport,
        idleDisconnect: false,
      });
      try {
        await restoreApi.login();
        let restoreXml: string;
        if (prevXml && /<HaCfg/i.test(prevXml)) {
          restoreXml = prevXml.includes("<body>")
            ? prevXml
            : `<?xml version="1.0" encoding="UTF-8" ?><body>${prevXml}</body>`;
        } else {
          restoreXml = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<HaCfg version="1.1">
<enable>0</enable>
<url></url>
<verify_cert>0</verify_cert>
</HaCfg>
</body>`;
        }
        console.log("restoring previous HaCfg…");
        const r = await sendRaw(restoreApi, 807, restoreXml);
        console.log("807 restore:", {
          responseCode: r.responseCode,
          error: r.error?.slice(0, 200),
        });
      } finally {
        await restoreApi.close().catch(() => undefined);
      }
    };

    if (opts.keepUntilRestore) {
      // Drop the control socket (idle-disconnect style) while webhook stays armed.
      await api.close();
      console.log("control socket closed; webhook left enabled for listen window");
      return { restore };
    }

    await restore();
  } finally {
    try {
      await api.close();
    } catch {
      /* ignore */
    }
  }
}

async function main(): Promise<void> {
  const setArg = process.argv.find((a) => a.startsWith("--set-url="));
  const listen = process.argv.includes("--listen");
  let setUrl = setArg?.slice("--set-url=".length);
  let server: Awaited<ReturnType<typeof startTempWebhookServer>> | undefined;

  if (listen) {
    server = await startTempWebhookServer();
    setUrl = server.url;
    console.log("temp webhook listening at", setUrl);
  }

  const targets = buildTargets();
  if (!targets.length) {
    console.error("No battery targets in .env");
    process.exit(1);
  }

  const restorers: Array<() => Promise<void>> = [];
  const wait = process.argv.includes("--wait");

  for (const t of targets) {
    try {
      const result = await probeOne(t, {
        setUrl,
        keepUntilRestore: Boolean(setUrl && wait),
      });
      if (result?.restore) restorers.push(result.restore);
    } catch (e) {
      console.error(t.label, "FAILED:", e);
    }
  }

  if (server && wait) {
    console.log(
      "waiting 90s for webhook POSTs (walk in front of campanello / press doorbell)…",
    );
    await new Promise((r) => setTimeout(r, 90_000));
    console.log("events received:", server.events.length);
    for (const r of restorers) {
      try {
        await r();
      } catch (e) {
        console.error("restore failed:", e);
      }
    }
    await server.close();
  } else if (server) {
    for (const r of restorers) await r().catch(() => undefined);
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
