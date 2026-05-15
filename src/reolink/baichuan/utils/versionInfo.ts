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

/**
 * Snapshot of `<VersionInfo>` returned by cmd_id=80.
 *
 * Every field is optional because firmware variants and models include
 * different subsets. The parser preserves the raw string the camera sent;
 * empty XML elements (e.g. `<cc3200Version></cc3200Version>`) come through
 * as the empty string so callers can distinguish "absent" (undefined) from
 * "explicitly empty" ("").
 */
export interface BaichuanVersionInfo {
  /** User-assigned name (matches the OSD camera name). */
  name?: string;
  /** Model code, e.g. `"E1 Zoom"`, `"RLC-810A"`. */
  type?: string;
  /** Hardware serial number. */
  serialNumber?: string;
  /** Build identifier, typically a date string like `"build 2503281992"`. */
  buildDay?: string;
  /** Internal hardware revision, e.g. `"IPC_NT14NA48MPSD6"`. */
  hardwareVersion?: string;
  /** Config-format version Reolink uses to know what schema the device speaks. */
  cfgVersion?: string;
  /** Firmware version, e.g. `"v3.2.0.4741_2503281992"`. */
  firmwareVersion?: string;
  /** Extended hardware detail (often hardwareVersion + region/sku suffix). */
  detail?: string;
  /** IE-Client identifier (legacy plug-in tag, usually `"IEClient"`). */
  IEClient?: string;
  /** Legacy MCU firmware version (present on some Reolink wireless models). */
  cc3200Version?: string;
  /** Signal-processor firmware version (rarely populated). */
  spVersion?: string;
  /** File extension Reolink expects for firmware updates (`"pak"`). */
  pakSuffix?: string;
  /** Reolink item / SKU number, e.g. `"E340"`. */
  itemNo?: string;
  /** AI-model bundle version (the on-device people/vehicle/animal detector). */
  aiVersion?: string;
  /** Diagnostic helper string the app sends to support, e.g. `"blackPointsLevel=0"`. */
  helpVersion?: string;
}

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
