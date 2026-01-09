import "dotenv/config";
import { ReolinkCgiApi } from "../../dist/index.js";

const host = process.env.NVR_HOST;
const username = process.env.NVR_USERNAME || "admin";
const password = process.env.NVR_PASSWORD;

if (host == null || host === "" || password == null || password === "") {
  throw new Error("Missing NVR_HOST/NVR_PASSWORD");
}

const cgi = new ReolinkCgiApi({ host, username, password, timeoutMs: 30000 });
await cgi.login();

const rsp = await cgi.callMany([
  { cmd: "GetTime", action: 0, param: {} },
  { cmd: "GetDevInfo", action: 0, param: {} },
]);

console.log(JSON.stringify(rsp, null, 2));

await cgi.logout().catch(() => {});
