import { ReolinkCgiApi } from "../cgi/ReolinkCgiApi.js";
import type { ReolinkHttpClientOptions } from "../http/ReolinkHttpClient.js";
import type { ReolinkCmdResponse } from "../http/types.js";

function extractChannelsFromChannelStatus(rsp: ReolinkCmdResponse[]): number[] {
  if (!rsp || rsp.length === 0) return [];
  
  const v: any = rsp[0]?.value;
  if (!v) return [];
  
  // Prova diverse varianti del nome del campo
  // Nota: alcuni NVR usano "status" invece di "Channelstatus"
  let status = v?.status ?? v?.Channelstatus ?? v?.ChannelStatus ?? v?.channelStatus ?? v?.channelstatus;
  
  // Se non è un array, potrebbe essere che il valore stesso sia l'array
  if (!Array.isArray(status)) {
    // Prova se v stesso è un array
    if (Array.isArray(v)) {
      status = v;
    } else {
      // Prova altri campi comuni
      status = v?.channels ?? v?.Channels ?? v?.channel ?? v?.Channel;
      if (!Array.isArray(status)) {
        // Prova se ci sono campi numerici che indicano canali (es. channel0, channel1, etc.)
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
    // Se ch è un numero direttamente
    if (typeof ch === "number" && Number.isFinite(ch)) {
      out.push(ch);
      continue;
    }
    // Se ch è un oggetto, cerca il campo channel/id/channelId
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

