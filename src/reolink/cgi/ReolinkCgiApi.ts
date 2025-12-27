import { ReolinkHttpClient, type ReolinkHttpClientOptions } from "../http/ReolinkHttpClient.js";
import type { ReolinkCmdRequest, ReolinkCmdResponse } from "../http/types.js";

export class ReolinkCgiApi {
  readonly client: ReolinkHttpClient;

  constructor(opts: ReolinkHttpClientOptions) {
    this.client = new ReolinkHttpClient(opts);
  }

  async login(): Promise<void> {
    await this.client.login();
  }

  async logout(): Promise<void> {
    await this.client.logout();
  }

  async call<TValue = unknown, TParam = unknown>(cmd: string, param?: TParam, action = 0): Promise<ReolinkCmdResponse<TValue>[]> {
    // evita `param: undefined` con exactOptionalPropertyTypes
    if (param === undefined) return await this.client.call<TValue, TParam>(cmd, { action });
    return await this.client.call<TValue, TParam>(cmd, { action, param });
  }

  async callMany<TValue = unknown>(cmds: ReolinkCmdRequest[]): Promise<ReolinkCmdResponse<TValue>[]> {
    return await this.client.callMany<TValue>(cmds);
  }

  // Wrapper comuni (stesso naming reolink_aio)
  async GetDevInfo(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetDevInfo", param);
  }

  async GetChnTypeInfo(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetChnTypeInfo", param);
  }

  async GetChannelstatus(): Promise<ReolinkCmdResponse[]> {
    // reolink_aio usa "GetChannelstatus" (minuscola s)
    return await this.call("GetChannelstatus", undefined, 0);
  }

  async GetLocalLink(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("GetLocalLink", param);
  }

  async GetNetPort(): Promise<ReolinkCmdResponse[]> {
    return await this.call("GetNetPort", {});
  }

  async SetNetPort(netPort: unknown): Promise<ReolinkCmdResponse[]> {
    return await this.call("SetNetPort", { NetPort: netPort });
  }

  async Reboot(channel?: number): Promise<ReolinkCmdResponse[]> {
    const param = channel == null ? {} : { channel };
    return await this.call("Reboot", param);
  }
}

