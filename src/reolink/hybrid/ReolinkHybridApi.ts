import { ReolinkCgiApi } from "../cgi/ReolinkCgiApi";
import { ReolinkBaichuanApi } from "../baichuan/ReolinkBaichuanApi";
import type { ReolinkHttpClientOptions } from "../http/ReolinkHttpClient";
import type { BaichuanClientOptions } from "../../client/BaichuanClient";
import type { ReolinkCmdResponse } from "../http/types";

export type ReolinkHybridApiOptions = {
  cgi?: ReolinkHttpClientOptions;
  baichuan?: BaichuanClientOptions;
};

/**
 * Hybrid API: for each operation, try Baichuan first and fall back to CGI.
 *
 * Session handling:
 * - CGI: token + refresh (lease time) handled by `ReolinkHttpClient`
 * - Baichuan: idempotent login + reconnection handled by the client
 */
export class ReolinkHybridApi {
  readonly cgi: ReolinkCgiApi | undefined;
  readonly baichuan: ReolinkBaichuanApi | undefined;

  constructor(opts: ReolinkHybridApiOptions) {
    this.cgi = opts.cgi ? new ReolinkCgiApi(opts.cgi) : undefined;
    this.baichuan = opts.baichuan ? new ReolinkBaichuanApi(opts.baichuan) : undefined;
  }

  async login(): Promise<void> {
    if (this.baichuan) await this.baichuan.login();
    if (this.cgi) await this.cgi.login();
  }

  async close(): Promise<void> {
    if (this.baichuan) await this.baichuan.close();
    if (this.cgi) await this.cgi.logout();
  }

  // --------------------
  // Wrapper: Baichuan -> CGI fallback
  // --------------------

  async GetDevInfo(channel?: number): Promise<ReolinkCmdResponse[]> {
    if (this.baichuan) {
      try {
        const info = await this.baichuan.getInfo(channel);
        return [{ cmd: "GetDevInfo", code: 0, value: info }];
      } catch {
        // fallback
      }
    }
    if (!this.cgi) throw new Error("No backend available (CGI not configured)");
    return await this.cgi.GetDevInfo(channel);
  }

  async GetChnTypeInfo(channel?: number): Promise<ReolinkCmdResponse[]> {
    // Baichuan: getInfo(channel) uses cmd_id 318, which reolink_aio maps to GetChnTypeInfo
    if (this.baichuan && channel != null) {
      try {
        const info = await this.baichuan.getInfo(channel);
        return [{ cmd: "GetChnTypeInfo", code: 0, value: info }];
      } catch {
        // fallback
      }
    }
    if (!this.cgi) throw new Error("No backend available (CGI not configured)");
    return await this.cgi.GetChnTypeInfo(channel);
  }

  async GetNetPort(): Promise<ReolinkCmdResponse[]> {
    if (this.baichuan) {
      try {
        const ports = await this.baichuan.getNetPort();
        return [{ cmd: "GetNetPort", code: 0, value: ports }];
      } catch {
        // fallback
      }
    }
    if (!this.cgi) throw new Error("No backend available (CGI not configured)");
    return await this.cgi.GetNetPort();
  }

  async SetNetPort(netPort: unknown): Promise<ReolinkCmdResponse[]> {
    if (this.baichuan) {
      try {
        // Supports a subset: onvifEnable/rtmpEnable/rtspEnable
        await this.baichuan.setNetPort(netPort as any);
        return [{ cmd: "SetNetPort", code: 0, value: {} }];
      } catch {
        // fallback
      }
    }
    if (!this.cgi) throw new Error("No backend available (CGI not configured)");
    return await this.cgi.SetNetPort(netPort);
  }

  async Reboot(channel?: number): Promise<void> {
    if (this.baichuan) {
      try {
        await this.baichuan.reboot(channel);
        return;
      } catch {
        // fallback
      }
    }
    if (!this.cgi) throw new Error("No backend available (CGI not configured)");
    const rsp = await this.cgi.Reboot(channel);
    const first = rsp[0];
    if (!first || first.code !== 0) throw new Error(`Reboot failed: ${JSON.stringify(rsp)}`);
  }
}

