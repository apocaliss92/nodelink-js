import { ReolinkNvrCgiApi } from "./ReolinkNvrCgiApi";
import { ReolinkNvrBaichuanApi } from "./ReolinkNvrBaichuanApi";
import type { ReolinkHttpClientOptions } from "../http/ReolinkHttpClient";
import type { BaichuanClientOptions } from "../../client/BaichuanClient";

export type ReolinkNvrHybridApiOptions = {
  cgi?: ReolinkHttpClientOptions;
  baichuan?: BaichuanClientOptions;
};

/**
 * NVR hybrid API:
 * - uses CGI to enumerate channels and for commands not covered by Baichuan
 * - tries Baichuan for per-channel operations when possible
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
    if (!this.cgi) throw new Error("NVR: CGI not configured (required to enumerate channels)");
    return await this.cgi.listChannels();
  }

  async getAllConnectedCamerasInfo(): Promise<Record<number, unknown>> {
    const channels = await this.listChannels();

    // Prefer Baichuan for per-channel info, fallback to CGI
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
      if (!this.cgi) throw new Error("NVR: CGI not configured");
      out[ch] = await this.cgi.cgi.GetDevInfo(ch);
    }
    return out;
  }
}

