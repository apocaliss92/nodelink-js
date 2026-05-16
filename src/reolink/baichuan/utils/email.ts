import type {
  EmailConfig,
  EmailConfigPatch,
  EmailTaskConfig,
  EmailTaskScheduleItem,
  EmailAttachmentType,
  EmailTextType,
} from "../types";
import {
  ensureXmlHeader,
  getXmlText,
  xmlEscape,
} from "../../../protocol/xml";

const parseInt01 = (text: string | undefined): 0 | 1 | undefined => {
  if (text === undefined) return undefined;
  return text.trim() === "1" ? 1 : 0;
};

const parseNumberSafe = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
};

const VALID_ATTACHMENT_TYPES: EmailAttachmentType[] = [
  "picture",
  "video",
  "none",
];
const VALID_TEXT_TYPES: EmailTextType[] = ["withText", "noText"];

const normalizeAttachmentType = (
  text: string | undefined,
): EmailAttachmentType => {
  const t = (text ?? "").trim();
  return (VALID_ATTACHMENT_TYPES as readonly string[]).includes(t)
    ? (t as EmailAttachmentType)
    : "picture";
};

const normalizeTextType = (text: string | undefined): EmailTextType => {
  const t = (text ?? "").trim();
  return (VALID_TEXT_TYPES as readonly string[]).includes(t)
    ? (t as EmailTextType)
    : "withText";
};

/**
 * Parse the `<Email>` block returned by GetEmail (cmdId=42).
 */
export function parseEmailConfigFromXml(xml: string): EmailConfig {
  const cfg: EmailConfig = {
    smtpServer: getXmlText(xml, "smtpServer") ?? "",
    userName: getXmlText(xml, "userName") ?? "",
    password: getXmlText(xml, "password") ?? "",
    address1: getXmlText(xml, "address1") ?? "",
    address2: getXmlText(xml, "address2") ?? "",
    address3: getXmlText(xml, "address3") ?? "",
    smtpPort: parseNumberSafe(getXmlText(xml, "smtpPort")) ?? 0,
    sendNickname: getXmlText(xml, "sendNickname") ?? "",
    attachment: parseInt01(getXmlText(xml, "attachment")) ?? 0,
    attachmentType: normalizeAttachmentType(getXmlText(xml, "attachmentType")),
    textType: normalizeTextType(getXmlText(xml, "textType")),
    ssl: parseInt01(getXmlText(xml, "ssl")) ?? 0,
    interval: parseNumberSafe(getXmlText(xml, "interval")) ?? 30,
  };

  const senderMaxLen = parseNumberSafe(getXmlText(xml, "senderMaxLen"));
  if (senderMaxLen !== undefined) cfg.senderMaxLen = senderMaxLen;
  const pwdMaxLen = parseNumberSafe(getXmlText(xml, "pwdMaxLen"));
  if (pwdMaxLen !== undefined) cfg.pwdMaxLen = pwdMaxLen;
  const ability = parseNumberSafe(getXmlText(xml, "emailAttachAbility"));
  if (ability !== undefined) cfg.emailAttachAbility = ability;

  return cfg;
}

/**
 * Merge a patch into the current `<Email>` XML (read-modify-write).
 * Returns the resulting body XML ready for SetEmail / TestEmail.
 *
 * Reolink's SetEmail expects the FULL `<Email>` block (the camera rejects
 * partial blocks), so we never strip unmentioned fields.
 */
export function buildSetEmailXml(
  current: EmailConfig,
  patch: EmailConfigPatch,
): string {
  const merged: EmailConfig = { ...current, ...patch };

  // The capability fields (senderMaxLen/pwdMaxLen/emailAttachAbility) come
  // from the GET response and are not echoed back in the SET — strip them.
  return ensureXmlHeader(
    `<body>` +
      `<Email version="1.1">` +
      `<smtpServer>${xmlEscape(merged.smtpServer)}</smtpServer>` +
      `<userName>${xmlEscape(merged.userName)}</userName>` +
      `<password>${xmlEscape(merged.password)}</password>` +
      `<address1>${xmlEscape(merged.address1)}</address1>` +
      `<address2>${xmlEscape(merged.address2)}</address2>` +
      `<address3>${xmlEscape(merged.address3)}</address3>` +
      `<smtpPort>${merged.smtpPort}</smtpPort>` +
      `<sendNickname>${xmlEscape(merged.sendNickname)}</sendNickname>` +
      `<attachment>${merged.attachment}</attachment>` +
      `<attachmentType>${merged.attachmentType}</attachmentType>` +
      `<textType>${merged.textType}</textType>` +
      `<ssl>${merged.ssl}</ssl>` +
      `<interval>${merged.interval}</interval>` +
      `</Email>` +
      `</body>`,
  );
}

/**
 * Parse the `<EmailTask>` block returned by GetEmailTask (cmdId=217).
 */
export function parseEmailTaskFromXml(xml: string): EmailTaskConfig {
  const channelId = parseNumberSafe(getXmlText(xml, "channelId")) ?? 0;
  const enable = parseInt01(getXmlText(xml, "enable")) ?? 0;

  const items: EmailTaskScheduleItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1] ?? "";
    items.push({
      type: getXmlText(block, "type") ?? "none",
      valueTable: getXmlText(block, "valueTable") ?? "",
    });
  }

  return { channelId, enable, typeScheduleList: items };
}

/**
 * Build the 168-char `valueTable` schedule bitmap (7 days × 24 hours)
 * from a human-friendly description.
 *
 * Days are indexed 0..6 where 0 = Sunday (Reolink convention — same as
 * JavaScript `Date.getDay()`). Hours are 0..23.
 *
 * Examples:
 * ```ts
 * // Always on (24/7)
 * buildEmailScheduleValueTable({ kind: "always" });
 *
 * // Only weekdays, 8:00-18:00
 * buildEmailScheduleValueTable({
 *   kind: "windows",
 *   windows: [{ days: [1, 2, 3, 4, 5], startHour: 8, endHour: 18 }],
 * });
 *
 * // Always off
 * buildEmailScheduleValueTable({ kind: "never" });
 * ```
 *
 * `endHour` is **exclusive** — `{ startHour: 8, endHour: 18 }` enables
 * 08:00..17:59. Use `endHour: 24` to include the full last hour of the day.
 */
export function buildEmailScheduleValueTable(
  spec:
    | { kind: "always" }
    | { kind: "never" }
    | {
        kind: "windows";
        windows: Array<{
          days: number[];
          startHour: number;
          endHour: number;
        }>;
      },
): string {
  if (spec.kind === "always") return "1".repeat(168);
  const grid: string[] = new Array(168).fill("0");
  if (spec.kind === "never") return grid.join("");

  for (const w of spec.windows) {
    const startH = Math.max(0, Math.min(24, w.startHour));
    const endH = Math.max(startH, Math.min(24, w.endHour));
    for (const d of w.days) {
      if (d < 0 || d > 6) continue;
      for (let h = startH; h < endH; h++) {
        grid[d * 24 + h] = "1";
      }
    }
  }
  return grid.join("");
}

/**
 * Build the SetEmailTask XML body (cmdId=216).
 *
 * Reolink expects the FULL typeScheduleList — keep all 7 (or more) slots
 * from the GET response and only flip the ones you care about. Slots you
 * don't track must be sent back with their previous type/valueTable to
 * avoid the camera dropping them.
 */
export function buildSetEmailTaskXml(task: EmailTaskConfig): string {
  const items = task.typeScheduleList
    .map(
      (item) =>
        `<item>` +
        `<type>${xmlEscape(item.type)}</type>` +
        `<valueTable>${xmlEscape(item.valueTable)}</valueTable>` +
        `</item>`,
    )
    .join("");

  return ensureXmlHeader(
    `<body>` +
      `<EmailTask version="1.1">` +
      `<channelId>${task.channelId}</channelId>` +
      `<enable>${task.enable}</enable>` +
      `<typeScheduleList>${items}</typeScheduleList>` +
      `</EmailTask>` +
      `</body>`,
  );
}
