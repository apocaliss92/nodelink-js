/**
 * Parser for the `<VersionInfo>` block returned by Baichuan cmd_id=80
 * (`BC_CMD_ID_GET_VERSION_INFO`). The camera answers with a top-level
 * `<body><VersionInfo version="1.1">...</VersionInfo></body>` containing all
 * the identifying metadata about the device: friendly name, model code,
 * serial number, firmware/build/AI versions.
 *
 * This is the same info the Reolink mobile app shows in "About this device".
 * It is NOT the same as `cmd_104` (`SystemGeneral`) which holds time/locale.
 */

import { getXmlText } from "../../../protocol/xml";
import type { BaichuanVersionInfo } from "../types";

export type { BaichuanVersionInfo };

/**
 * Parse a `<VersionInfo>` XML block into a typed snapshot. Accepts either
 * the inner block (just `<VersionInfo>...</VersionInfo>`) or the full
 * Baichuan envelope (`<?xml ...?><body><VersionInfo>...</VersionInfo></body>`).
 *
 * @param xml - Raw XML returned by `sendXml({ cmdId: 80 })`.
 * @returns A populated `BaichuanVersionInfo`. Fields the camera didn't
 *          emit are left undefined.
 */
export function parseVersionInfo(xml: string): BaichuanVersionInfo {
  const out: BaichuanVersionInfo = {};
  const set = (key: keyof BaichuanVersionInfo): void => {
    const v = getXmlText(xml, key);
    if (v !== undefined) out[key] = v;
  };
  set("name");
  set("type");
  set("serialNumber");
  set("buildDay");
  set("hardwareVersion");
  set("cfgVersion");
  set("firmwareVersion");
  set("detail");
  set("IEClient");
  set("cc3200Version");
  set("spVersion");
  set("pakSuffix");
  set("itemNo");
  set("aiVersion");
  set("helpVersion");
  return out;
}
