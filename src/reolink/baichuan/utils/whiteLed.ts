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

export const buildWhiteLedManualPayloadXml = (channel: number, on: boolean): string => {
  // Reolink firmware commonly expects FloodlightManual for cmd 288.
  // When enabling, 180 seconds has historically worked as a default duration.
  return buildFloodlightManualXml(channel, on ? 1 : 0, on ? 180 : 0);
};

export const applyWhiteLedOnOffToXml = (xml: string, on: boolean): string => {
  let modifiedXml = xml;
  const val = on ? 1 : 0;

  // Some payloads use <enable>, others use <state> or <status>.
  if (/<enable>[^<]*<\/enable>/i.test(modifiedXml)) {
    modifiedXml = modifiedXml.replace(/<enable>[^<]*<\/enable>/i, `<enable>${val}</enable>`);
  }
  if (/<state>[^<]*<\/state>/i.test(modifiedXml)) {
    modifiedXml = modifiedXml.replace(/<state>[^<]*<\/state>/i, `<state>${val}</state>`);
  }
  if (/<status>[^<]*<\/status>/i.test(modifiedXml)) {
    modifiedXml = modifiedXml.replace(/<status>[^<]*<\/status>/i, `<status>${val}</status>`);
  }

  return modifiedXml;
};

export const applyWhiteLedBrightnessToXml = (xml: string, brightness: number): string => {
  let modifiedXml = xml;

  if (/<brightness_cur>[^<]*<\/brightness_cur>/i.test(modifiedXml)) {
    modifiedXml = modifiedXml.replace(
      /<brightness_cur>[^<]*<\/brightness_cur>/i,
      `<brightness_cur>${brightness}</brightness_cur>`,
    );
  }

  // If a brightness was set, ensure task is enabled.
  if (/<enable>[^<]*<\/enable>/i.test(modifiedXml)) {
    modifiedXml = modifiedXml.replace(/<enable>[^<]*<\/enable>/i, `<enable>1</enable>`);
  }

  return modifiedXml;
};
