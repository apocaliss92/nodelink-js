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

const cmds = [
  "GetHddInfo",
  "GetHddInfo2",
  "GetDiskInfo",
  "GetStorageInfo",
  "GetStorageStatus",
  "GetHddStorage",
  "GetHddCfg",
  "GetRec",
];

const body = cmds.map((cmd) => ({ cmd, action: 0, param: {} }));
const rsp = await cgi.callMany(body);

const simplified = rsp.map((r) => ({
  cmd: r.cmd,
  code: r.code,
  keys: r.value && typeof r.value === "object" ? Object.keys(r.value) : undefined,
  value: r.value,
}));

console.log(JSON.stringify(simplified, null, 2));

await cgi.logout().catch(() => {});
