import { ReolinkCgiApi } from "../cgi/ReolinkCgiApi.js";
import { ReolinkBaichuanApi } from "../baichuan/ReolinkBaichuanApi.js";
import type { ReolinkHttpClientOptions } from "../http/ReolinkHttpClient.js";
import type { BaichuanClientOptions } from "../../client/BaichuanClient.js";
import type { ReolinkCmdResponse } from "../http/types.js";

export type ReolinkHybridApiOptions = {
  cgi?: ReolinkHttpClientOptions;
  baichuan?: BaichuanClientOptions;
};

/**
 * API “ibrida”: per ogni operazione prova prima Baichuan e poi fa fallback a CGI.
 * Gestisce autonomamente le sessioni:
 * - CGI: token + refresh (lease time) gestito da `ReolinkHttpClient`
 * - Baichuan: login idempotente e reconnessione gestita dal client
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
  // Wrapper: prova Baichuan -> fallback CGI
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
    if (!this.cgi) throw new Error("Nessun backend disponibile (CGI non configurato)");
    return await this.cgi.GetDevInfo(channel);
  }

  async GetChnTypeInfo(channel?: number): Promise<ReolinkCmdResponse[]> {
    // Baichuan: getInfo(channel) usa cmd_id 318, che in reolink_aio è mappato a GetChnTypeInfo
    if (this.baichuan && channel != null) {
      try {
        const info = await this.baichuan.getInfo(channel);
        return [{ cmd: "GetChnTypeInfo", code: 0, value: info }];
      } catch {
        // fallback
      }
    }
    if (!this.cgi) throw new Error("Nessun backend disponibile (CGI non configurato)");
    return await this.cgi.GetChnTypeInfo(channel);
  }

  async GetNetPort(): Promise<ReolinkCmdResponse[]> {
    if (this.baichuan) {
      try {
        const ports = await this.baichuan.getPorts();
        return [{ cmd: "GetNetPort", code: 0, value: ports }];
      } catch {
        // fallback
      }
    }
    if (!this.cgi) throw new Error("Nessun backend disponibile (CGI non configurato)");
    return await this.cgi.GetNetPort();
  }

  async SetNetPort(netPort: unknown): Promise<ReolinkCmdResponse[]> {
    if (this.baichuan) {
      try {
        // supporta subset: onvifEnable/rtmpEnable/rtspEnable
        await this.baichuan.setNetPort(netPort as any);
        return [{ cmd: "SetNetPort", code: 0, value: {} }];
      } catch {
        // fallback
      }
    }
    if (!this.cgi) throw new Error("Nessun backend disponibile (CGI non configurato)");
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
    if (!this.cgi) throw new Error("Nessun backend disponibile (CGI non configurato)");
    const rsp = await this.cgi.Reboot(channel);
    const first = rsp[0];
    if (!first || first.code !== 0) throw new Error(`Reboot fallito: ${JSON.stringify(rsp)}`);
  }
}

