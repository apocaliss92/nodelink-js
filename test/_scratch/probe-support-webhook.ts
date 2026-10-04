import "dotenv/config";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

async function main() {
  const api = new ReolinkBaichuanApi({
    host: process.env.UDP_STANDALONE_HOST!,
    username: process.env.UDP_STANDALONE_USERNAME || "admin",
    password: process.env.UDP_STANDALONE_PASSWORD!,
    uid: process.env.UDP_STANDALONE_UID,
    transport: "udp",
    idleDisconnect: false,
  });
  await api.login();
  for (const cmdId of [199, 151]) {
    try {
      const xml = String(await (api as any).sendXml({ cmdId, timeoutMs: 15000 }));
      console.log("\n=== cmd", cmdId, "len", xml.length, "===");
      const interesting = [...xml.matchAll(/<([A-Za-z0-9_]+)>([^<]{0,80})<\/\1>/g)]
        .map((m) => `${m[1]}=${m[2]}`)
        .filter((s) =>
          /web|push|ha|http|email|pir|visit|door|battery|adapt|md|motion|alarm|linger|wake|support/i.test(
            s,
          ),
        );
      console.log(interesting.join("\n") || "(no matching tags)");
      // raw dump snippets containing Ha / webhook / push
      for (const re of [/HaCfg/i, /webhook/i, /push/gi, /batteryMode/i, /battery>/i]) {
        const idx = xml.search(re);
        if (idx >= 0) console.log("snippet", re, xml.slice(Math.max(0, idx - 80), idx + 160).replace(/\s+/g, " "));
      }
    } catch (e) {
      console.log("cmd", cmdId, "failed", (e as Error).message);
    }
  }
  try {
    const caps = await (api as any).getCapabilities?.(0);
    console.log("\ncaps keys", caps && Object.keys(caps));
    console.log("hasPowerSourceSwitch", caps?.hasPowerSourceSwitch);
    console.log("battery", caps?.battery, "doorbell", caps?.doorbell);
  } catch (e) {
    console.log("caps failed", (e as Error).message);
  }
  await api.close();
}
main();
