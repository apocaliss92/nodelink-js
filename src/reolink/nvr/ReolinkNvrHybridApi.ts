import { ReolinkNvrCgiApi } from "./ReolinkNvrCgiApi.js";
import { ReolinkNvrBaichuanApi } from "./ReolinkNvrBaichuanApi.js";
import type { ReolinkHttpClientOptions } from "../http/ReolinkHttpClient.js";
import type { BaichuanClientOptions } from "../../client/BaichuanClient.js";

export type ReolinkNvrHybridApiOptions = {
  cgi?: ReolinkHttpClientOptions;
  baichuan?: BaichuanClientOptions;
};

/**
 * API NVR ibrida:
 * - usa CGI per enumerare canali e per i comandi non coperti da Baichuan
 * - prova Baichuan per le operazioni per-canale quando possibile
 */
export class ReolinkNvrHybridApi {
  readonly cgi: ReolinkNvrCgiApi | undefined;
  readonly baichuan: ReolinkNvrBaichuanApi | undefined;

  constructor(opts: ReolinkNvrHybridApiOptions) {
    this.cgi = opts.cgi ? new ReolinkNvrCgiApi(opts.cgi) : undefined;
    this.baichuan = opts.baichuan ? new ReolinkNvrBaichuanApi(opts.baichuan) : undefined;
  }

  async login(): Promise<void> {
    if (this.baichuan) await this.baichuan.login();
    if (this.cgi) await this.cgi.login();
  }

  async close(): Promise<void> {
    if (this.baichuan) await this.baichuan.close();
    if (this.cgi) await this.cgi.logout();
  }

  async listChannels(): Promise<number[]> {
    if (!this.cgi) throw new Error("NVR: CGI non configurato (necessario per enumerare canali)");
    return await this.cgi.listChannels();
  }

  async getAllConnectedCamerasInfo(): Promise<Record<number, unknown>> {
    const channels = await this.listChannels();

    // prefer Baichuan per le info per-canale, fallback a CGI
    const out: Record<number, unknown> = {};
    for (const ch of channels) {
      if (this.baichuan) {
        try {
          out[ch] = await this.baichuan.bc.getInfo(ch);
          continue;
        } catch {
          // fallback CGI
        }
      }
      if (!this.cgi) throw new Error("NVR: CGI non configurato");
      out[ch] = await this.cgi.cgi.GetDevInfo(ch);
    }
    return out;
  }
}

