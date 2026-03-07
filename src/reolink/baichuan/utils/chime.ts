import { getXmlText } from "../../../protocol/xml";
import { getXmlBlocks } from "../xmlUtils";
import type {
  ChimeAlarmCfg,
  ChimeCfg,
  ChimeDevice,
  ChimeParams,
  HardwiredChimeState,
  WirelessChimeSilentState,
} from "../types";

// --------------------
// XML builders
// --------------------

/** Build XML for DingDongOpt option 2 (getParam) - get chime name/vol/led. */
export const buildDingDongGetParamsXml = (chimeId: number): string => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<dingdongDeviceOpt version="1.1">
<id>${chimeId}</id>
<opt>getParam</opt>
</dingdongDeviceOpt>
</body>`;

/** Build XML for DingDongOpt option 3 (setParam) - set chime name/vol/led. */
export const buildDingDongSetParamsXml = (
  chimeId: number,
  params: { volLevel?: number; ledState?: number; name?: string },
): string => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<dingdongDeviceOpt version="1.1">
<opt>setParam</opt>
<id>${chimeId}</id>
${params.volLevel !== undefined ? `<volLevel>${params.volLevel}</volLevel>` : ""}
${params.ledState !== undefined ? `<ledState>${params.ledState}</ledState>` : ""}
${params.name !== undefined ? `<name>${params.name}</name>` : ""}
</dingdongDeviceOpt>
</body>`;

/** Build XML for DingDongOpt option 4 (ringWithMusic) - trigger chime ring. */
export const buildDingDongRingXml = (
  chimeId: number,
  musicId: number,
): string => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<dingdongDeviceOpt version="1.1">
<id>${chimeId}</id>
<opt>ringWithMusic</opt>
<musicId>${musicId}</musicId>
</dingdongDeviceOpt>
</body>`;

/** Build XML for SetDingDongCfg (cmd_id 487) - set per-event ringtone/enable. */
export const buildSetDingDongCfgXml = (
  chimeId: number,
  eventType: string,
  state: 0 | 1,
  musicId: number,
): string => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<dingdongCfg version="1.1">
<deviceCfg>
<id>${chimeId}</id>
<alarminCfg>
<valid>${state}</valid>
<musicId>${musicId}</musicId>
<type>${eventType}</type>
</alarminCfg>
</deviceCfg>
</dingdongCfg>
</body>`;

/** Build XML for GetDingDongCtrl (cmd_id 483) - get hardwired chime state. */
export const buildGetDingDongCtrlXml = (): string => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<dingdongCtrl version="1.1">
<opt>machineStateGet</opt>
</dingdongCtrl>
</body>`;

/** Build XML for SetDingDongCtrl (cmd_id 483) - set hardwired chime state. */
export const buildSetDingDongCtrlXml = (
  chimeType: string,
  enabled: 0 | 1,
  time: number,
): string => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<dingdongCtrl version="1.1">
<opt>machineStateSet</opt>
<type>${chimeType}</type>
<bopen>${enabled}</bopen>
<bsave>1</bsave>
<time>${time}</time>
</dingdongCtrl>
</body>`;

/** Build XML for QuickReplyPlay (cmd_id 349) - play audio file on doorbell. */
export const buildQuickReplyPlayXml = (
  channel: number,
  fileId: number,
): string => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<audioFileInfo version="1.1">
<channelId>${channel}</channelId>
<id>${fileId}</id>
<timeout>0</timeout>
</audioFileInfo>
</body>`;

// --------------------
// XML parsers
// --------------------

/** Parse GetDingDongList response XML into an array of ChimeDevice. */
export const parseDingDongListFromXml = (xml: string): ChimeDevice[] => {
  const devices: ChimeDevice[] = [];
  const blocks = getXmlBlocks(xml, "dingdongDeviceInfo");
  for (const block of blocks) {
    // Some firmware uses <deviceId>/<deviceName>/<netState>, others use <id>/<name>/<netstate>
    const idText = getXmlText(block, "deviceId") ?? getXmlText(block, "id");
    const name = getXmlText(block, "deviceName") ?? getXmlText(block, "name") ?? "";
    const netStateText = getXmlText(block, "netState") ?? getXmlText(block, "netstate");
    if (idText === undefined) continue;
    const id = Number(idText);
    if (!Number.isFinite(id)) continue;
    devices.push({
      id,
      name,
      netState: netStateText !== undefined ? Number(netStateText) : 0,
    });
  }
  return devices;
};

/** Parse DingDongOpt option 2 (getParam) response XML into ChimeParams. */
export const parseDingDongParamsFromXml = (xml: string): ChimeParams => {
  const name = getXmlText(xml, "name");
  const volLevelText = getXmlText(xml, "volLevel");
  const ledStateText = getXmlText(xml, "ledState");

  const result: ChimeParams = {};
  if (name !== undefined) result.name = name;
  if (volLevelText !== undefined) {
    const n = Number(volLevelText);
    if (Number.isFinite(n)) result.volLevel = n;
  }
  if (ledStateText !== undefined) {
    const n = Number(ledStateText);
    if (Number.isFinite(n)) result.ledState = n;
  }
  return result;
};

/** Parse GetDingDongCfg response XML into an array of ChimeCfg. */
export const parseDingDongCfgFromXml = (xml: string): ChimeCfg[] => {
  const configs: ChimeCfg[] = [];
  const deviceBlocks = getXmlBlocks(xml, "deviceCfg");
  for (const deviceBlock of deviceBlocks) {
    // Some firmware uses <ringId>, others use <id>
    const idText = getXmlText(deviceBlock, "ringId") ?? getXmlText(deviceBlock, "id");
    if (idText === undefined) continue;
    const id = Number(idText);
    if (!Number.isFinite(id)) continue;

    const typeMap: Record<string, ChimeAlarmCfg> = {};
    const alarmBlocks = getXmlBlocks(deviceBlock, "alarminCfg");
    for (const alarmBlock of alarmBlocks) {
      const type = getXmlText(alarmBlock, "type");
      if (!type) continue;
      const validText = getXmlText(alarmBlock, "switch") ?? getXmlText(alarmBlock, "valid");
      const musicIdText = getXmlText(alarmBlock, "musicId");
      typeMap[type] = {
        valid: validText !== undefined ? Number(validText) : 0,
        musicId: musicIdText !== undefined ? Number(musicIdText) : 0,
      };
    }

    configs.push({ id, type: typeMap });
  }
  return configs;
};

/** Parse GetDingDongCtrl / SetDingDongCtrl response XML into HardwiredChimeState. */
export const parseHardwiredChimeFromXml = (xml: string): HardwiredChimeState => {
  const type = getXmlText(xml, "type") ?? "";
  const bopenText = getXmlText(xml, "bopen") ?? getXmlText(xml, "enable");
  const timeText = getXmlText(xml, "time");

  return {
    type,
    enabled: bopenText === "1",
    time: timeText !== undefined ? Number(timeText) : 0,
  };
};

/** Build XML for GetDingDongSilent (cmd_id 609) - get wireless chime silent mode. */
export const buildGetDingDongSilentXml = (chimeId: number): string => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<dingdongSilentMode version="1.1">
<id>${chimeId}</id>
</dingdongSilentMode>
</body>`;

/** Build XML for SetDingDongSilent (cmd_id 610) - set wireless chime silent mode.
 *
 * @param chimeId - The wireless chime device ID
 * @param time - Silence duration in seconds. 0 = not silenced (chime active), >0 = silenced for this many seconds.
 */
export const buildSetDingDongSilentXml = (chimeId: number, time: number): string => `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<dingdongSilentMode version="1.1">
<id>${chimeId}</id>
<time>${time}</time>
<type>63</type>
</dingdongSilentMode>
</body>`;

/** Parse GetDingDongSilent / SetDingDongSilent response XML into WirelessChimeSilentState. */
export const parseWirelessChimeSilentFromXml = (xml: string, chimeId: number): WirelessChimeSilentState => {
  const timeText = getXmlText(xml, "time");
  const time = timeText !== undefined ? Number(timeText) : 0;
  return {
    id: chimeId,
    time,
    active: time === 0,
  };
};
