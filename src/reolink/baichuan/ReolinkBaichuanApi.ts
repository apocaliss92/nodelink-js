import { BaichuanClient, type BaichuanClientOptions } from "../../client/BaichuanClient.js";
import { xmlEscape, getXmlText } from "../../protocol/xml.js";

export type ReolinkBaichuanPorts = Record<string, Record<string, number>>;

function getXmlTexts(xml: string, tags: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags) {
    const v = getXmlText(xml, t);
    if (v !== undefined) out[t] = v;
  }
  return out;
}

export class ReolinkBaichuanApi {
  readonly client: BaichuanClient;

  constructor(opts: BaichuanClientOptions) {
    this.client = new BaichuanClient(opts);
  }

  async login(): Promise<void> {
    await this.client.login();
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Bc cmd_id generico, ritorna XML (se presente). */
  async sendXml(params: Parameters<BaichuanClient["sendXml"]>[0]): Promise<string> {
    await this.client.login();
    return await this.client.sendXml(params);
  }

  // --------------------
  // Operazioni principali (da reolink_aio/baichuan.py)
  // --------------------

  /** GetNetPort via Baichuan: cmd_id 37 */
  async getPorts(): Promise<ReolinkBaichuanPorts> {
    const xml = await this.sendXml({ cmdId: 37 });
    // Parser minimale: estrae <RtspPort><enable>...</enable><port>...</port>...
    const ports: ReolinkBaichuanPorts = {};
    const protoBlocks = xml.matchAll(/<([A-Za-z]+)Port[^>]*>([\s\S]*?)<\/\1Port>/g);
    for (const m of protoBlocks) {
      const proto = (m[1] ?? "").toLowerCase();
      const inner = m[2] ?? "";
      const kv: Record<string, number> = {};
      for (const kvp of inner.matchAll(/<([A-Za-z]+)>(-?\d+)<\/\1>/g)) {
        const k = (kvp[1] ?? "").toLowerCase();
        const v = Number(kvp[2]);
        if (Number.isFinite(v)) kv[k] = v;
      }
      if (Object.keys(kv).length) ports[proto] = kv;
    }
    return ports;
  }

  /** SetNetPort via Baichuan: cmd_id 36 (abilita/disabilita rtsp/rtmp/onvif/http/https) */
  async setPortEnabled(params: { port: "rtsp" | "rtmp" | "onvif" | "http" | "https"; enable: boolean }): Promise<void> {
    const tag = `${params.port[0]!.toUpperCase()}${params.port.slice(1)}Port`;
    const xml =
      `<?xml version="1.0" encoding="UTF-8" ?>` +
      `<body>` +
      `<${tag} version="1.1">` +
      `<enable>${params.enable ? 1 : 0}</enable>` +
      `</${tag}>` +
      `</body>`;
    await this.sendXml({ cmdId: 36, payloadXml: xml });
  }

  /** GetDevInfo via Baichuan: host cmd_id 80, channel cmd_id 318 */
  async getInfo(channel?: number): Promise<Record<string, string>> {
    const req: { cmdId: number; channel?: number } = { cmdId: channel == null ? 80 : 318 };
    if (channel !== undefined) req.channel = channel;
    const xml = await this.sendXml(req);
    // chiavi che reolink_aio usa: type, hardwareVersion, firmwareVersion, itemNo, serialNumber, name
    return getXmlTexts(xml, ["type", "hardwareVersion", "firmwareVersion", "itemNo", "serialNumber", "name"]);
  }

  /** GetEnc via Baichuan: cmd_id 56 (ritorna XML raw). */
  async getEncXml(channel: number): Promise<string> {
    return await this.sendXml({ cmdId: 56, channel });
  }

  /** SetEnc via Baichuan: cmd_id 57 (invia XML raw). */
  async setEncXml(channel: number, encXml: string): Promise<void> {
    await this.sendXml({ cmdId: 57, channel, payloadXml: encXml });
  }

  /** SetNetPort helper “bulk” come reolink_aio: accetta NetPort con onvifEnable/rtmpEnable/rtspEnable. */
  async setNetPort(netPort: { onvifEnable?: number; rtmpEnable?: number; rtspEnable?: number }): Promise<void> {
    if (netPort.onvifEnable != null) await this.setPortEnabled({ port: "onvif", enable: netPort.onvifEnable === 1 });
    if (netPort.rtmpEnable != null) await this.setPortEnabled({ port: "rtmp", enable: netPort.rtmpEnable === 1 });
    if (netPort.rtspEnable != null) await this.setPortEnabled({ port: "rtsp", enable: netPort.rtspEnable === 1 });
  }

  /** Reboot via Baichuan: cmd_id 23 */
  async reboot(channel?: number): Promise<void> {
    const req: { cmdId: number; channel?: number } = { cmdId: 23 };
    if (channel !== undefined) req.channel = channel;
    await this.sendXml(req);
  }

  /** Ping via Baichuan: cmd_id 93 (header-only / no payload) */
  async ping(): Promise<void> {
    await this.sendXml({ cmdId: 93 });
  }

  /** GetLocalLink via Baichuan: cmd_id 104 (general info) – in molte cam include MAC/rete. */
  async getGeneralXml(channel?: number): Promise<string> {
    const req: { cmdId: number; channel?: number } = { cmdId: 104 };
    if (channel !== undefined) req.channel = channel;
    return await this.sendXml(req);
  }

  /** SetGeneralXml via Baichuan: cmd_id 105 */
  async setGeneralXml(channel: number | undefined, xml: string): Promise<void> {
    await this.sendXml({ cmdId: 105, ...(channel === undefined ? {} : { channel }), payloadXml: xml });
  }

  /** Helper per costruire una Extension canale in XML (per payload che la richiede). */
  static buildChannelExtensionXml(channel: number): string {
    return `<?xml version="1.0" encoding="UTF-8" ?>` + `<Extension version="1.1"><channelId>${xmlEscape(String(channel))}</channelId></Extension>`;
  }
}

