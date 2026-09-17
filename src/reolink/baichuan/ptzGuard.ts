/**
 * The PTZ guard point — the "monitoring point" of the official Reolink app.
 *
 * A guard point is a position the camera returns to on its own after `timeout`
 * seconds of inactivity, AND a position it can be SENT to on command. That
 * second half is what makes it this vendor's real "home": nothing else in the
 * Baichuan PTZ surface offers one, so a consumer wanting "go home" had to pick
 * an arbitrary preset slot and hope the installer had used it that way.
 *
 * This library already declared the ability leaf (`supportGuardPointImage`) and
 * mapped none of the commands.
 *
 * ## Provenance
 *
 * Captured from the official app against an E1 Outdoor PoE (firmware
 * v3.1.0.5223) on 2026-09-17, decrypted with the session key derived from the
 * login handshake. Every field below was observed on the wire.
 *
 * Two details are kept verbatim rather than tidied:
 *
 *  - floats are SCIENTIFIC with a two-digit exponent on the WRITE
 *    (`0.000000e+00`) and plain (`0`) on the READ;
 *  - the READ extension carries `chnType`; the WRITE extension does not.
 *
 * ## Not observed
 *
 * Only `mode: global` ever appeared, and `xpos/ypos/height/width` were zero in
 * every frame including the enabled ones — consistent with `needSetPos` meaning
 * "take the head's CURRENT position" and the quartet belonging to another mode.
 * That is an inference, not a measurement, so nothing here writes a non-zero
 * rectangle.
 */

export interface PtzGuardStatus {
  /** The camera returns here by itself after `timeoutSeconds`. */
  enabled: boolean;
  /** A guard point is stored. Independent of {@link enabled}. */
  valid: boolean;
  timeoutSeconds: number;
  mode: string;
  imageName: string;
}

export interface PtzGuardSetInput {
  channelId: number;
  enabled: boolean;
  timeoutSeconds: number;
  /**
   * Pin the guard point to the head's CURRENT position. Observed only on the
   * first set of the captured session — see {@link buildPtzGuardSetXml}.
   */
  setPosition: boolean;
}

/**
 * The captured write notation: `0.000000e+00`.
 *
 * JavaScript's `toExponential` emits a ONE-digit exponent (`e+0`); C's `%e`,
 * which is what the camera's own app speaks, pads to two. One character, and
 * exactly the kind of difference a firmware parser rejects.
 */
function wireFloat(value: number): string {
  return value.toExponential(6).replace(/e([+-])(\d)$/, "e$10$2");
}

/**
 * The per-request extension. `chnType` is present on the read and absent on the
 * write in every captured frame; the asymmetry is preserved rather than
 * unified, because a field the camera's own app sends is cheaper to keep than
 * to re-discover after a firmware starts caring.
 */
export function buildPtzGuardExtensionXml(
  channelId: number,
  direction: "read" | "write",
): string {
  const chnType = direction === "read" ? `\n<chnType>0</chnType>` : "";
  return `<?xml version="1.0" encoding="UTF-8" ?>\n<Extension version="1.1">\n<channelId>${channelId}</channelId>${chnType}\n</Extension>\n`;
}

function guardBody(
  channelId: number,
  command: string,
  fields: readonly string[],
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    "<body>",
    '<PtzGuard version="1.1">',
    `<channelId>${channelId}</channelId>`,
    ...fields,
    `<command>${command}</command>`,
    "<imageName></imageName>",
    `<xpos>${wireFloat(0)}</xpos>`,
    `<ypos>${wireFloat(0)}</ypos>`,
    `<height>${wireFloat(0)}</height>`,
    `<width>${wireFloat(0)}</width>`,
    "<mode>global</mode>",
    "</PtzGuard>",
    "</body>",
    "",
  ].join("\n");
}

/** Send the head to the guard point NOW. */
export function buildPtzGuardGoXml(channelId: number): string {
  return guardBody(channelId, "toGrd", [
    "<benable>0</benable>",
    "<timeout>68</timeout>",
  ]);
}

/**
 * Configure the guard point.
 *
 * `needSetPos` is emitted ONLY when `setPosition` is true. In the capture it
 * appeared on the first set and never again: sending it on every edit would
 * re-pin the point to wherever the head happens to be, silently moving a
 * position the operator had already placed.
 */
export function buildPtzGuardSetXml(input: PtzGuardSetInput): string {
  return guardBody(input.channelId, "setGrd", [
    `<benable>${input.enabled ? 1 : 0}</benable>`,
    `<timeout>${Math.round(input.timeoutSeconds)}</timeout>`,
    ...(input.setPosition ? ["<needSetPos>1</needSetPos>"] : []),
  ]);
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m === null ? null : (m[1] ?? "").trim();
}

/**
 * Read the camera back.
 *
 * `null` when the reply carries no readable `PtzGuard` — never a default. A
 * fabricated "no guard configured" is indistinguishable from a real one, and
 * this answer is what decides whether a consumer moves the head.
 */
export function parsePtzGuardXml(xml: string): PtzGuardStatus | null {
  if (!xml.includes("<PtzGuard")) return null;
  const enabled = tag(xml, "benable");
  const valid = tag(xml, "bvalid");
  const timeout = tag(xml, "timeout");
  if (enabled === null || valid === null || timeout === null) return null;
  const timeoutSeconds = Number.parseInt(timeout, 10);
  if (!Number.isFinite(timeoutSeconds)) return null;
  return {
    enabled: enabled === "1",
    valid: valid === "1",
    timeoutSeconds,
    mode: tag(xml, "mode") ?? "global",
    imageName: tag(xml, "imageName") ?? "",
  };
}
