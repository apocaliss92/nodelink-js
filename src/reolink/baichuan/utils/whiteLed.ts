import type { WhiteLedState } from "../types";
import { buildFloodlightManualXml, getXmlText } from "../../../protocol/xml";

export const parseWhiteLedStateFromXml = (xml: string): WhiteLedState => {
  const enable = getXmlText(xml, "enable");
  const state = getXmlText(xml, "state");
  const status = getXmlText(xml, "status");
  const brightnessText = getXmlText(xml, "brightness_cur");

  const result: WhiteLedState = {
    enabled: enable === "1" || state === "1" || status === "1",
  };

  if (brightnessText !== undefined) {
    result.brightness = Number(brightnessText);
  }

  return result;
};

export const buildWhiteLedManualPayloadXml = (
  channel: number,
  on: boolean,
): string => {
  // Reolink firmware commonly expects FloodlightManual for cmd 288.
  // When enabling, 180 seconds has historically worked as a default duration.
  return buildFloodlightManualXml(channel, on ? 1 : 0, on ? 180 : 0);
};

export const applyWhiteLedOnOffToXml = (xml: string, on: boolean): string => {
  let modifiedXml = xml;
  const val = on ? 1 : 0;

  // Some payloads use <enable>, others use <state> or <status>.
  if (/<enable>[^<]*<\/enable>/i.test(modifiedXml)) {
    modifiedXml = modifiedXml.replace(
      /<enable>[^<]*<\/enable>/i,
      `<enable>${val}</enable>`,
    );
  }
  if (/<state>[^<]*<\/state>/i.test(modifiedXml)) {
    modifiedXml = modifiedXml.replace(
      /<state>[^<]*<\/state>/i,
      `<state>${val}</state>`,
    );
  }
  if (/<status>[^<]*<\/status>/i.test(modifiedXml)) {
    modifiedXml = modifiedXml.replace(
      /<status>[^<]*<\/status>/i,
      `<status>${val}</status>`,
    );
  }
  // FloodlightTask uses <alarmMode> for motion-triggered floodlight
  if (/<alarmMode>[^<]*<\/alarmMode>/i.test(modifiedXml)) {
    modifiedXml = modifiedXml.replace(
      /<alarmMode>[^<]*<\/alarmMode>/i,
      `<alarmMode>${val}</alarmMode>`,
    );
  }

  return modifiedXml;
};

export const applyWhiteLedBrightnessToXml = (
  xml: string,
  brightness: number,
): string => {
  let modifiedXml = xml;

  if (/<brightness_cur>[^<]*<\/brightness_cur>/i.test(modifiedXml)) {
    modifiedXml = modifiedXml.replace(
      /<brightness_cur>[^<]*<\/brightness_cur>/i,
      `<brightness_cur>${brightness}</brightness_cur>`,
    );
  }

  // If a brightness was set, ensure task is enabled.
  if (/<enable>[^<]*<\/enable>/i.test(modifiedXml)) {
    modifiedXml = modifiedXml.replace(
      /<enable>[^<]*<\/enable>/i,
      `<enable>1</enable>`,
    );
  }

  return modifiedXml;
};

/**
 * Parse FloodlightTask XML to extract floodlight-on-motion state.
 * Returns the alarmMode (1 = floodlight turns on when motion detected, 0 = off)
 */
export interface FloodlightTaskState {
  /** Whether floodlight turns on when motion is detected (alarmMode) */
  floodlightOnMotion: boolean;
  /** Whether the task is enabled */
  enabled: boolean;
  /** Current brightness (0-100) */
  brightness?: number;
  /** Duration in seconds */
  duration?: number;
  /** Detection types (e.g., "people,vehicle,dog_cat") */
  detectType?: string;
}

export const parseFloodlightTaskFromXml = (
  xml: string,
): FloodlightTaskState => {
  const alarmMode = getXmlText(xml, "alarmMode");
  const enable = getXmlText(xml, "enable");
  const brightnessText = getXmlText(xml, "brightness_cur");
  const durationText = getXmlText(xml, "duration");
  const detectType = getXmlText(xml, "detectType");

  const result: FloodlightTaskState = {
    floodlightOnMotion: alarmMode === "1",
    enabled: enable === "1",
  };

  if (brightnessText !== undefined) {
    result.brightness = Number(brightnessText);
  }
  if (durationText !== undefined) {
    result.duration = Number(durationText);
  }
  if (detectType !== undefined) {
    result.detectType = detectType;
  }

  return result;
};

/**
 * Apply floodlight-on-motion enable/disable to FloodlightTask XML.
 * Sets both <alarmMode> and <enable> fields.
 */
export const applyFloodlightOnMotionToXml = (
  xml: string,
  on: boolean,
): string => {
  let modifiedXml = xml;
  const val = on ? 1 : 0;

  // FloodlightTask uses both <alarmMode> and <enable> for motion-triggered floodlight
  if (/<alarmMode>[^<]*<\/alarmMode>/i.test(modifiedXml)) {
    modifiedXml = modifiedXml.replace(
      /<alarmMode>[^<]*<\/alarmMode>/i,
      `<alarmMode>${val}</alarmMode>`,
    );
  }
  if (/<enable>[^<]*<\/enable>/i.test(modifiedXml)) {
    modifiedXml = modifiedXml.replace(
      /<enable>[^<]*<\/enable>/i,
      `<enable>${val}</enable>`,
    );
  }

  return modifiedXml;
};

/**
 * Apply floodlight settings (duration, detectType) to FloodlightTask XML.
 */
export const applyFloodlightSettingsToXml = (
  xml: string,
  settings: {
    duration?: number;
    detectType?: string;
    brightness?: number;
  },
): string => {
  let modifiedXml = xml;

  if (settings.duration !== undefined) {
    if (/<duration>[^<]*<\/duration>/i.test(modifiedXml)) {
      modifiedXml = modifiedXml.replace(
        /<duration>[^<]*<\/duration>/i,
        `<duration>${settings.duration}</duration>`,
      );
    }
  }

  if (settings.detectType !== undefined) {
    if (/<detectType>[^<]*<\/detectType>/i.test(modifiedXml)) {
      modifiedXml = modifiedXml.replace(
        /<detectType>[^<]*<\/detectType>/i,
        `<detectType>${settings.detectType}</detectType>`,
      );
    }
  }

  if (settings.brightness !== undefined) {
    if (/<brightness_cur>[^<]*<\/brightness_cur>/i.test(modifiedXml)) {
      modifiedXml = modifiedXml.replace(
        /<brightness_cur>[^<]*<\/brightness_cur>/i,
        `<brightness_cur>${settings.brightness}</brightness_cur>`,
      );
    }
  }

  return modifiedXml;
};
