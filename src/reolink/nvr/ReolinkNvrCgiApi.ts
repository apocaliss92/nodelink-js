import { ReolinkCgiApi } from "../cgi/ReolinkCgiApi.js";
import type { ReolinkHttpClientOptions } from "../http/ReolinkHttpClient.js";
import type { ReolinkCmdResponse } from "../http/types.js";

function extractChannelsFromChannelStatus(rsp: ReolinkCmdResponse[]): number[] {
  if (!rsp || rsp.length === 0) return [];
  
  const v: any = rsp[0]?.value;
  if (!v) return [];
  
  // Try different variants of the field name.
  // Note: some NVRs use "status" instead of "Channelstatus".
  let status = v?.status ?? v?.Channelstatus ?? v?.ChannelStatus ?? v?.channelStatus ?? v?.channelstatus;
  
  // If it's not an array, the value itself might be the array.
  if (!Array.isArray(status)) {
    // Check if v itself is an array.
    if (Array.isArray(v)) {
      status = v;
    } else {
      // Try other common fields.
      status = v?.channels ?? v?.Channels ?? v?.channel ?? v?.Channel;
      if (!Array.isArray(status)) {
        // Try numeric keys that indicate channels (e.g. channel0, channel1, ...).
        const channelKeys = Object.keys(v).filter(k => 
          /^channel\d+$/i.test(k) || /^ch\d+$/i.test(k)
        );
        if (channelKeys.length > 0) {
          status = channelKeys.map(k => {
            const ch = v[k];
            return typeof ch === "object" && ch !== null ? ch : { channel: parseInt(k.replace(/\D/g, "")) };
          });
        }
      }
    }
  }
  
  if (!Array.isArray(status)) return [];
  
  const out: number[] = [];
  for (const ch of status) {
    // If ch is a number directly.
    if (typeof ch === "number" && Number.isFinite(ch)) {
      out.push(ch);
      continue;
    }
    // If ch is an object, look for channel/id/channelId.
    if (typeof ch === "object" && ch !== null) {
      const id = ch?.channel ?? ch?.id ?? ch?.channelId ?? ch?.Channel ?? ch?.ID ?? ch?.ChannelId;
      if (typeof id === "number" && Number.isFinite(id)) {
        out.push(id);
      }
    }
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

