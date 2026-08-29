import { getXmlText } from "../../../protocol/xml";
import type {
  BatteryInfo,
  BatteryPowerSourceMode,
  SwitchPowerSourceResult,
} from "../types";

/**
 * Power-source switching for battery cameras / battery doorbells
 * (`SwitchBatteryAdapterMode`, cmd_id 805).
 *
 * This is NOT the same as the "wired working mode" (Continuous / on-event)
 * setting: it tells the device which power source it should assume, which is
 * what the Reolink app calls "Wired Power" vs "Battery Power". The app itself
 * reads the power/battery settings BEFORE sending this command, so on some
 * firmwares it can never reach the switch when the read fails — sending
 * cmd 805 directly works around that.
 *
 * On an NVR/Hub the command must be addressed to the hub with the camera's
 * channel id.
 */

const MODES: readonly BatteryPowerSourceMode[] = ["battery", "adapter"];

/** Build the XML payload for SwitchBatteryAdapterMode (cmd_id 805). */
export const buildSwitchBatteryAdapterModeXml = (
  mode: BatteryPowerSourceMode,
  dryRun = false,
): string => {
  if (!MODES.includes(mode)) {
    throw new Error(
      `Invalid power source mode "${mode}" (expected "battery" or "adapter")`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<SwitchBatteryAdapterMode version="1.1">
<mode>${mode}</mode>
<dryRun>${dryRun ? 1 : 0}</dryRun>
</SwitchBatteryAdapterMode>
</body>`;
};

/**
 * Parse a SwitchBatteryAdapterMode response.
 *
 * Firmwares observed so far answer with responseCode 200 and an EMPTY body on
 * success, so an empty payload is treated as accepted. When a body is present
 * we honour `<rspCode>` (anything other than 0/200 means rejected) and the
 * echoed `<mode>`.
 */
export const parseSwitchBatteryAdapterModeResponse = (
  xml: string,
  requestedMode: BatteryPowerSourceMode,
  dryRun: boolean,
): SwitchPowerSourceResult => {
  const body = (xml ?? "").trim();
  if (!body) return { mode: requestedMode, dryRun, accepted: true };

  const echoed = getXmlText(body, "mode");
  const mode = MODES.includes(echoed as BatteryPowerSourceMode)
    ? (echoed as BatteryPowerSourceMode)
    : requestedMode;

  const rspCodeText = getXmlText(body, "rspCode");
  const rspCode = rspCodeText != null ? Number(rspCodeText) : undefined;
  const accepted =
    rspCode == null || !Number.isFinite(rspCode)
      ? true
      : rspCode === 0 || rspCode === 200;

  return {
    mode,
    dryRun,
    accepted,
    ...(rspCode != null && Number.isFinite(rspCode) ? { rspCode } : {}),
  };
};

/**
 * Derive the power source currently in use from a BatteryInfo payload.
 *
 * `adapterStatus` is the firmware's own view of the charging port:
 * - `adapter`     → mains/transformer powered (wired mode)
 * - `solarPanel`  → solar charging, still battery powered
 * - `none`        → running on battery
 *
 * Returns `undefined` when the device does not report `adapterStatus`.
 */
export const powerSourceFromBatteryInfo = (
  battery: Pick<BatteryInfo, "adapterStatus">,
): BatteryPowerSourceMode | undefined => {
  const status = battery.adapterStatus;
  if (status == null || status === "") return undefined;
  return status.toLowerCase() === "adapter" ? "adapter" : "battery";
};
