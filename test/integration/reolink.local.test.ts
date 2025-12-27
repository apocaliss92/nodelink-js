import { describe, expect, it } from "vitest";
import { hasIntegrationEnv, getEnv } from "./env.js";
import { ReolinkCgiApi } from "../../src/reolink/cgi/ReolinkCgiApi.js";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi.js";
import { ReolinkHybridApi } from "../../src/reolink/hybrid/ReolinkHybridApi.js";

const describeIf = (cond: boolean) => (cond ? describe : describe.skip);

describeIf(hasIntegrationEnv())("integration: Reolink camera (local)", () => {
  const host = getEnv("REOLINK_HOST")!;
  const username = getEnv("REOLINK_USER")!;
  const password = getEnv("REOLINK_PASS")!;

  const cgiPort = getEnv("REOLINK_CGI_PORT") ? Number(getEnv("REOLINK_CGI_PORT")) : undefined;
  const useHttps = getEnv("REOLINK_CGI_HTTPS") === "1";

  const bcTransport = (getEnv("REOLINK_BC_TRANSPORT") as "tcp" | "udp" | "auto" | undefined) ?? "tcp";
  const bcUid = getEnv("REOLINK_UID");

  it("CGI: login + GetDevInfo", async () => {
    const cgiOpts: any = { host, username, password, useHttps };
    if (cgiPort !== undefined) cgiOpts.port = cgiPort;
    const api = new ReolinkCgiApi(cgiOpts);
    await api.login();
    const rsp = await api.GetDevInfo();
    expect(rsp[0]?.code).toBe(0);
    await api.logout();
  });

  it("Baichuan: login + ping", async () => {
    const api = new ReolinkBaichuanApi({
      host,
      username,
      password,
      transport: bcTransport,
      ...(bcTransport !== "udp" && bcTransport !== "auto"
        ? {}
        : bcUid
          ? { udp: { mode: "uid", uid: bcUid, broadcast: true } }
          : {}),
    });
    await api.login();
    await api.ping();
    await api.close();
  });

  it("Hybrid: GetNetPort + Reboot (does not reboot unless REOLINK_ALLOW_REBOOT=1)", async () => {
    const api = new ReolinkHybridApi({
      cgi: ((): any => {
        const o: any = { host, username, password, useHttps };
        if (cgiPort !== undefined) o.port = cgiPort;
        return o;
      })(),
      baichuan: {
        host,
        username,
        password,
        transport: bcTransport,
        ...(bcTransport !== "udp" && bcTransport !== "auto"
          ? {}
          : bcUid
            ? { udp: { mode: "uid", uid: bcUid, broadcast: true } }
            : {}),
      },
    });
    await api.login();
    const ports = await api.GetNetPort();
    expect(ports[0]?.code).toBe(0);

    if (getEnv("REOLINK_ALLOW_REBOOT") === "1") {
      await api.Reboot();
    }
    await api.close();
  });
});

