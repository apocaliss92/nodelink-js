import type { BaichuanClient } from "../../../client/BaichuanClient";
import { buildPtzPresetXmlV2 } from "../../../protocol/xml";
import type { PtzCommand } from "../types";

export type PtzDirection = "up" | "down" | "left" | "right" | "stop";

export const resolvePtzDirection = (command: PtzCommand): PtzDirection => {
  if (command.action === "stop") return "stop";

  const cmdMap: Record<string, Exclude<PtzDirection, "stop">> = {
    Left: "left",
    Right: "right",
    Up: "up",
    Down: "down",
  };

  const mapped = cmdMap[command.command];
  if (!mapped) {
    throw new Error(`Unsupported PTZ command for MSG_ID_PTZ_CONTROL: ${command.command}`);
  }

  return mapped;
};

export const resolvePtzSpeed = (direction: PtzDirection, rawSpeed: number | undefined): number => {
  if (direction === "stop") return 0;

  if (rawSpeed === undefined) return 32;

  if (rawSpeed > 0 && rawSpeed <= 1) {
    return Math.max(1, rawSpeed * 64);
  }

  return rawSpeed;
};

export const extractFrameErrorDetails = (params: {
  client: BaichuanClient;
  frame: { body: Buffer; header: { channelId: number; responseCode: number } };
  maxChars?: number;
}): string => {
  if (params.frame.body.length === 0) return "";

  try {
    const tryDecryptXml = (params.client as unknown as { tryDecryptXml?: (...args: any[]) => string | undefined }).tryDecryptXml;
    if (!tryDecryptXml) return "";

    const errorXml = tryDecryptXml.call(params.client, params.frame.body, params.frame.header.channelId, (params.client as any).enc);
    if (!errorXml) return "";

    const maxChars = params.maxChars ?? 200;
    return ` - Error details: ${errorXml.substring(0, maxChars)}`;
  } catch {
    return "";
  }
};

export const buildDeletePtzPresetAttempts = (params: {
  channelId: number;
  presetId: number;
  currentName?: string;
}): Array<{ payloadXml: string; label: string }> => {
  return [
    {
      label: "command=delPos",
      payloadXml: buildPtzPresetXmlV2(params.channelId, params.presetId, "delPos"),
    },
    {
      label: "enable=0 (no name)",
      payloadXml: buildPtzPresetXmlV2(params.channelId, params.presetId, "setPos", { enable: 0 }),
    },
    {
      label: "name='' (no enable)",
      payloadXml: buildPtzPresetXmlV2(params.channelId, params.presetId, "setPos", { name: "" }),
    },
    {
      label: "enable=0 name=''",
      payloadXml: buildPtzPresetXmlV2(params.channelId, params.presetId, "setPos", { name: "", enable: 0 }),
    },
    ...(params.currentName
      ? [
          {
            label: "enable=0 name=current",
            payloadXml: buildPtzPresetXmlV2(params.channelId, params.presetId, "setPos", {
              name: params.currentName,
              enable: 0,
            }),
          },
        ]
      : []),
    {
      label: "enable=0 name='Preset N'",
      payloadXml: buildPtzPresetXmlV2(params.channelId, params.presetId, "setPos", {
        name: `Preset ${params.presetId}`,
        enable: 0,
      }),
    },
  ];
};

export const isPresetEffectivelyDeleted = (preset: { name?: unknown; enable?: unknown } | undefined): boolean => {
  if (!preset) return true;

  const nameEmpty = preset.name !== undefined && String(preset.name).trim() === "";
  const disabled = preset.enable !== undefined && String(preset.enable).trim() === "0";

  return nameEmpty || disabled;
};

export const runDeletePtzPresetAttempts = async (params: {
  attempts: Array<{ payloadXml: string; label: string }>;
  send: (payloadXml: string, label: string) => Promise<{ responseCode: number }>;
  verify?: () => Promise<boolean>;
}): Promise<{ any200: boolean; verified: boolean; lastError: unknown }> => {
  let lastError: unknown;
  let any200 = false;
  let verified = false;

  for (const a of params.attempts) {
    try {
      const res = await params.send(a.payloadXml, a.label);

      if (res.responseCode !== 200) {
        throw new Error(`PTZ preset delete rejected (response_code ${res.responseCode})`);
      }

      any200 = true;

      if (params.verify) {
        try {
          if (await params.verify()) {
            verified = true;
            return { any200, verified, lastError };
          }
        } catch (e) {
          // Soft failure: continue with the next attempt.
          lastError = e;
        }
      }
    } catch (e) {
      lastError = e;
    }
  }

  return { any200, verified, lastError };
};
