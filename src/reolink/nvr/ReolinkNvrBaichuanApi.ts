import { ReolinkBaichuanApi } from "../baichuan/ReolinkBaichuanApi.js";
import type { BaichuanClientOptions } from "../../client/BaichuanClient.js";

/**
 * API Baichuan specifica per NVR.
 *
 * Nota: l’enumerazione dei canali (camere collegate) è tipicamente più affidabile via CGI
 * (GetChannelstatus). Qui forniamo helper multi-canale assumendo che tu passi esplicitamente
 * i canali o li ottenga via CGI.
 */
export class ReolinkNvrBaichuanApi {
  readonly bc: ReolinkBaichuanApi;

  constructor(opts: BaichuanClientOptions) {
    this.bc = new ReolinkBaichuanApi(opts);
  }

  async login(): Promise<void> {
    await this.bc.login();
  }

  async close(): Promise<void> {
    await this.bc.close();
  }

  async getAllInfo(channels: number[]): Promise<Record<number, Record<string, string>>> {
    const out: Record<number, Record<string, string>> = {};
    for (const ch of channels) {
      out[ch] = await this.bc.getInfo(ch);
    }
    return out;
  }

  async rebootHost(): Promise<void> {
    await this.bc.reboot(undefined);
  }
}

