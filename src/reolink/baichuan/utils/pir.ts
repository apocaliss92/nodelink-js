import { getXmlText } from "../../../protocol/xml";
import type { PirState } from "../types";

const parseBoolishNumber = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const t = v.trim().toLowerCase();
  if (t === "true") return 1;
  if (t === "false") return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

const parseEnabled = (v: string | undefined): boolean => {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t === "1" || t === "true";
};

export const parsePirInfoFromXml = (params: { xml: string; channel: number }): PirState => {
  const { xml, channel } = params;

  const enable = getXmlText(xml, "enable");
  const sensitive = getXmlText(xml, "sensiValue");
  const reduceAlarm = getXmlText(xml, "reduceFalseAlarm");
  const interval = getXmlText(xml, "interval");
  const intervalMax = getXmlText(xml, "intervalSecMax");

  const state: PirState["state"] = { channel };

  const enableN = parseBoolishNumber(enable);
  if (enableN !== undefined) state.enable = enableN;

  if (sensitive !== undefined) {
    const n = Number(sensitive);
    if (Number.isFinite(n)) state.sensitive = n;
  }

  const reduceAlarmN = parseBoolishNumber(reduceAlarm);
  if (reduceAlarmN !== undefined) state.reduceAlarm = reduceAlarmN;

  const intervalN = parseBoolishNumber(interval);
  if (intervalN !== undefined) state.interval = intervalN;

  const intervalMaxN = parseBoolishNumber(intervalMax);
  if (intervalMaxN !== undefined) state.intervalMax = intervalMaxN;

  return {
    enabled: parseEnabled(enable),
    state,
  };
};
