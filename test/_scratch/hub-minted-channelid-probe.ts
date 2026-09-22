/* eslint-disable no-console */
/** Does a hub child accept a MINTED header channelId on cmd 5, as the app sends? Read-only. */
import "dotenv/config";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

async function main(): Promise<void> {
  const host = process.env.NVR_HOST ?? "";
  const api = new ReolinkBaichuanApi({
    host,
    username: process.env.NVR_USERNAME ?? "admin",
    password: process.env.NVR_PASSWORD ?? "",
  });
  await api.login();
  const summary = await api.getNvrChannelsSummary({ source: "baichuan" });
  for (const c of summary.devices) {
    console.log(
      `ch${c.channel} name="${c.name ?? "?"}" model=${c.model ?? "?"} battery=${c.isBattery ?? false} sleeping=${c.sleeping ?? "?"} online=${c.online ?? "?"}`,
    );
  }
  await api.close().catch(() => undefined);
  process.exit(0);
}
void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
