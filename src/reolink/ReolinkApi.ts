import { BaichuanClient, type BaichuanClientOptions } from "../client/BaichuanClient.js";
import { ReolinkHttpClient, type ReolinkHttpClientOptions } from "./http/ReolinkHttpClient.js";
import type { ReolinkCmdRequest, ReolinkCmdResponse } from "./http/types.js";
import { buildRtspUrl, type RtspStreamProfile } from "../rtsp/urls.js";

export type ReolinkApiOptions = {
  /** HTTP CGI API (stile reolink_aio). */
  http?: ReolinkHttpClientOptions;
  /** Baichuan/BCUDP (tipico per battery e per alcune operazioni). */
  baichuan?: BaichuanClientOptions;
};

/**
 * API alto livello “stile reolink_aio”.
 *
 * Nota: molte operazioni di reolink_aio sono esposte come comandi HTTP CGI (`cmd`).
 * Qui forniamo:
 * - `http.call(...)` / `http.callMany(...)` per coprire tutto il set comandi
 * - wrapper per casi comuni (info, rete, streams, reboot, NVR channels)
 * - integrazione Baichuan/BCUDP dove serve (o dove l’HTTP non è disponibile)
 */
export class ReolinkApi {
  readonly http: ReolinkHttpClient | undefined;
  readonly baichuan: BaichuanClient | undefined;
  private readonly creds?: { host: string; username: string; password: string };

  constructor(opts: ReolinkApiOptions) {
    this.http = opts.http ? new ReolinkHttpClient(opts.http) : undefined;
    this.baichuan = opts.baichuan ? new BaichuanClient(opts.baichuan) : undefined;

    const base = opts.http ?? opts.baichuan;
    if (base) {
      this.creds = { host: base.host, username: base.username, password: base.password };
    }
  }

  async login(): Promise<void> {
    if (this.http) await this.http.login();
    if (this.baichuan) await this.baichuan.login();
  }

  async logout(): Promise<void> {
    if (this.http) await this.http.logout();
    if (this.baichuan) await this.baichuan.close();
  }

  /** Esegue un comando CGI generico (copre tutte le operazioni supportate da reolink_aio lato HTTP). */
  async call<TValue = unknown, TParam = unknown>(cmd: string, param?: TParam, action = 0): Promise<ReolinkCmdResponse<TValue>[]> {
    if (!this.http) throw new Error("HTTP API non configurata");
    if (param === undefined) return await this.http.call<TValue, TParam>(cmd, { action });
    return await this.http.call<TValue, TParam>(cmd, { action, param });
  }

  async callMany<TValue = unknown>(cmds: ReolinkCmdRequest[]): Promise<ReolinkCmdResponse<TValue>[]> {
    if (!this.http) throw new Error("HTTP API non configurata");
    return await this.http.callMany<TValue>(cmds);
  }

  // --------------------
  // Wrapper comuni (host / channel)
  // --------------------

  async getDevInfo(channel?: number): Promise<ReolinkCmdResponse[]> {
    // reolink_aio: GetDevInfo (host) e GetDevInfo con param channel per NVR
    const param = channel == null ? {} : { channel };
    return await this.call("GetDevInfo", param);
  }

  async getLocalLink(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetLocalLink", param);
  }

  async getNetPort(): Promise<ReolinkCmdResponse[]> {
    return await this.call("GetNetPort", {});
  }

  async setNetPort(netPort: unknown): Promise<ReolinkCmdResponse[]> {
    // netPort struttura dipende dal modello/firmware; lasciamo volutamente flessibile.
    return await this.call("SetNetPort", { NetPort: netPort });
  }

  async reboot(channel?: number): Promise<void> {
    // Preferisci HTTP se presente, altrimenti Baichuan (cmd_id 23).
    if (this.http) {
      const param = channel == null ? {} : { channel };
      const rsp = await this.call("Reboot", param);
      const first = rsp[0];
      if (!first || first.code !== 0) throw new Error(`Reboot fallito: ${JSON.stringify(rsp)}`);
      return;
    }
    if (this.baichuan) {
      const req: { cmdId: number; channel?: number } = { cmdId: 23 };
      if (channel !== undefined) req.channel = channel;
      await this.baichuan.sendXml(req);
      return;
    }
    throw new Error("Nessun trasporto configurato per reboot");
  }

  async getChannelStatus(): Promise<ReolinkCmdResponse[]> {
    return await this.call("GetChannelstatus", undefined, 0);
  }

  async getChnTypeInfo(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetChnTypeInfo", param);
  }

  /**
   * Helper: ritorna una lista di canali “noti” (se la risposta contiene i dati attesi).
   * Per NVR è l’equivalente pratico di “tutte le camere collegate”.
   */
  async listChannels(): Promise<number[]> {
    const rsp = await this.getChannelStatus();
    const v = rsp[0]?.value as any;
    const status = v?.Channelstatus ?? v?.ChannelStatus ?? v?.channelStatus;
    if (!Array.isArray(status)) return [];
    const channels: number[] = [];
    for (const ch of status) {
      const id = ch?.channel ?? ch?.id ?? ch?.channelId;
      if (typeof id === "number") channels.push(id);
    }
    return channels;
  }

  // --------------------
  // Streams
  // --------------------

  async getEnc(channel: number): Promise<ReolinkCmdResponse[]> {
    return await this.call("GetEnc", { channel });
  }

  async setEnc(channel: number, enc: unknown): Promise<ReolinkCmdResponse[]> {
    // come sopra: schema varia, lo manteniamo flessibile
    return await this.call("SetEnc", { channel, Enc: enc });
  }

  /** Costruisce una URL RTSP standard Reolink (path `h264Preview_XX_(main|sub)`). */
  getRtspUrl(params: { channel: number; stream: RtspStreamProfile; rtspPort?: number }): string {
    if (!this.creds) throw new Error("API non configurata");
    const rtspParams: Parameters<typeof buildRtspUrl>[0] = {
      host: this.creds.host,
      username: this.creds.username,
      password: this.creds.password,
      channel: params.channel,
      stream: params.stream,
      ...(params.rtspPort === undefined ? {} : { port: params.rtspPort }),
    };
    return buildRtspUrl(rtspParams);
  }
}

