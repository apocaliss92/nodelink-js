import { ReolinkBaichuanApi } from "../baichuan/ReolinkBaichuanApi.js";
import type { BaichuanClientOptions } from "../../client/BaichuanClient.js";

/**
 * API Baichuan specifica per NVR.
 *
 * Note: enumerating channels (connected cameras) is typically more reliable via CGI
 * (GetChannelstatus). Here we provide multi-channel helpers assuming you pass channels explicitly
 * (or obtain them via CGI).
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

