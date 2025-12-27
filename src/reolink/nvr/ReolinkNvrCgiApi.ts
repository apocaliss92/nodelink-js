import { ReolinkCgiApi } from "../cgi/ReolinkCgiApi.js";
import type { ReolinkHttpClientOptions } from "../http/ReolinkHttpClient.js";
import type { ReolinkCmdResponse } from "../http/types.js";

function extractChannelsFromChannelStatus(rsp: ReolinkCmdResponse[]): number[] {
  const v: any = rsp[0]?.value;
  const status = v?.Channelstatus ?? v?.ChannelStatus ?? v?.channelStatus ?? v?.channelstatus;
  if (!Array.isArray(status)) return [];
  const out: number[] = [];
  for (const ch of status) {
    const id = ch?.channel ?? ch?.id ?? ch?.channelId;
    if (typeof id === "number" && Number.isFinite(id)) out.push(id);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * NVR-specific CGI API.
 * Provides multi-channel helpers to fetch info about all connected cameras.
 */
export class ReolinkNvrCgiApi {
  readonly cgi: ReolinkCgiApi;

  constructor(opts: ReolinkHttpClientOptions) {
    this.cgi = new ReolinkCgiApi(opts);
  }

  async login(): Promise<void> {
    await this.cgi.login();
  }

  async logout(): Promise<void> {
    await this.cgi.logout();
  }

  async listChannels(): Promise<number[]> {
    const rsp = await this.cgi.GetChannelstatus();
    return extractChannelsFromChannelStatus(rsp);
  }

  async getChannelStatus(): Promise<ReolinkCmdResponse[]> {
    return await this.cgi.GetChannelstatus();
  }

  async getAllDevInfo(): Promise<Record<number, ReolinkCmdResponse[]>> {
    const channels = await this.listChannels();
    const out: Record<number, ReolinkCmdResponse[]> = {};
    for (const ch of channels) {
      out[ch] = await this.cgi.GetDevInfo(ch);
    }
    return out;
  }

  async getAllChnTypeInfo(): Promise<Record<number, ReolinkCmdResponse[]>> {
    const channels = await this.listChannels();
    const out: Record<number, ReolinkCmdResponse[]> = {};
    for (const ch of channels) {
      out[ch] = await this.cgi.GetChnTypeInfo(ch);
    }
    return out;
  }

  async rebootHost(): Promise<void> {
    const rsp = await this.cgi.Reboot(undefined);
    const first = rsp[0];
    if (!first || first.code !== 0) throw new Error(`NVR reboot failed: ${JSON.stringify(rsp)}`);
  }
}

