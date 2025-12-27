import { describe, expect, it } from "vitest";
import { ReolinkNvrCgiApi } from "../src/reolink/nvr/ReolinkNvrCgiApi.js";

describe("nvr helpers", () => {
  it("extracts channels from GetChannelstatus-like response (smoke via public method)", async () => {
    // Non possiamo chiamare rete qui; testiamo indirettamente che listChannels non esploda
    // quando il backend viene mockato.
    const api = new ReolinkNvrCgiApi({ host: "127.0.0.1", username: "u", password: "p", useHttps: false });
    // monkeypatch minimal: sostituiamo GetChannelstatus
    (api as any).cgi.GetChannelstatus = async () => [{ cmd: "GetChannelstatus", code: 0, value: { Channelstatus: [{ channel: 1 }, { channel: 0 }] } }];
    const channels = await api.listChannels();
    expect(channels).toEqual([0, 1]);
  });
});

