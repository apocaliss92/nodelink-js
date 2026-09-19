import { describe, expect, it, vi } from "vitest";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

/**
 * A channel-scoped command names its channel in the Extension.
 *
 * Two packet captures on 2026-09-19 — a Home Hub (Magicam, channel 3) and a
 * standalone camera (channel 0), different transports, different firmwares —
 * agree without a single exception:
 *
 *   per-channel commands   44, 45, 25, 26, 52, 53, 109, 115, 296, 299,
 *                          318, 319, 574, 10, 104   → ALWAYS carry
 *                          <Extension><channelId>N</channelId></Extension>
 *   device-global commands LOGIN, PING, GET_VERSION_INFO, GET_UID,
 *                          GET_HDD_INFO_LIST, GET_STREAM_INFO_LIST, …
 *                          → never carry one
 *
 * and the frame HEADER's channelId is a message counter in both: it walks
 * 12,13,14,… and 94,97,99,… while the Extension holds the real channel.
 *
 * This library put the channel in the header and sent no Extension on 77 of
 * its calls, 43 of them writes. The one we caught first was the OSD: on a hub
 * child NOTHING about the overlay worked, the plain `enable` toggle included,
 * because the write never named the channel it was for. `getDayNightThreshold`
 * answering 400 on that same NVR — retried three times, every ten seconds — is
 * very likely the same fault wearing a different symptom.
 *
 * So the rule lives in `sendXml`, once: a call that names a channel and does
 * not supply its own Extension gets one. A caller that wants something else
 * still passes `extensionXml` and wins.
 */

interface Sent {
  cmdId: number;
  channel?: number;
  extensionXml?: string;
  payloadXml?: string;
}

function harnessed(): { api: ReolinkBaichuanApi; sent: Sent[] } {
  const sent: Sent[] = [];
  const api = Object.create(ReolinkBaichuanApi.prototype) as ReolinkBaichuanApi;
  // `client` is a getter on the prototype, so it has to be shadowed on the
  // instance rather than assigned.
  Object.defineProperty(api, "client", {
    configurable: true,
    value: {
      loggedIn: true,
      sendFrame: vi.fn(async (p: Sent) => {
        sent.push(p);
        return {
          header: { responseCode: 200, channelId: 0 },
          body: Buffer.alloc(0),
        };
      }),
      tryDecryptXml: () => "",
      enc: null,
    },
  });
  return { api, sent };
}

describe("sendXml channel addressing", () => {
  it("adds the channel Extension when a command names a channel", async () => {
    const { api, sent } = harnessed();
    await api.sendXml({ cmdId: 296, channel: 3 });
    expect(sent[0]?.extensionXml).toContain("<channelId>3</channelId>");
  });

  it("addresses channel 0 explicitly, as both captures do", async () => {
    // The standalone's every cmd 44/45 carried `<channelId>0</channelId>`.
    // Channel zero is a channel, not an absence.
    const { api, sent } = harnessed();
    await api.sendXml({ cmdId: 44, channel: 0 });
    expect(sent[0]?.extensionXml).toContain("<channelId>0</channelId>");
  });

  it("leaves a device-global command alone", async () => {
    const { api, sent } = harnessed();
    await api.sendXml({ cmdId: 93 });
    expect(sent[0]?.extensionXml).toBeUndefined();
  });

  it("never overrides an Extension the caller built itself", async () => {
    const { api, sent } = harnessed();
    const mine = "<Extension><channelId>7</channelId><chnType>0</chnType></Extension>";
    await api.sendXml({ cmdId: 318, channel: 3, extensionXml: mine });
    expect(sent[0]?.extensionXml).toBe(mine);
  });
});
