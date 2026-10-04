/**
 * Map HaCfg-forwarded AlarmEventList XML (cmd 33) onto simple event types.
 *
 * In Wired Power Mode, Doorbell Gen 2 never POSTs wake/sleep — it forwards
 * normal cmd 33 alarm pushes. Motion is reported as `status=none` +
 * `AItype=other` (same heuristic reolink_aio uses).
 */

import type { ReolinkSimpleEventType } from "../reolink/baichuan/types.js";

const AI_OBJECT_MAP: Record<string, ReolinkSimpleEventType> = {
  people: "people",
  person: "people",
  human: "people",
  vehicle: "vehicle",
  car: "vehicle",
  dog_cat: "animal",
  dog: "animal",
  cat: "animal",
  pet: "animal",
  face: "face",
  package: "package",
};

function xmlTag(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i").exec(xml);
  return (m?.[1] ?? "").trim().toLowerCase();
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Parse one or more `<AlarmEvent>` blocks from a cmd 33 webhook XML body.
 * Returns the union of active simple types for this snapshot (no rising-edge
 * state — each HaCfg POST is independent).
 */
export function mapBaichuanWebhookAlarmXmlToSimpleEvents(
  xml: string,
): ReolinkSimpleEventType[] {
  if (!xml || !/<AlarmEvent\b/i.test(xml)) return [];

  const out = new Set<ReolinkSimpleEventType>();

  for (const match of xml.matchAll(
    /<AlarmEvent\b[^>]*>([\s\S]*?)<\/AlarmEvent>/gi,
  )) {
    const block = match[1] ?? "";
    const status = splitCsv(xmlTag(block, "status"));
    const ai = splitCsv(
      xmlTag(block, "AItype") ||
        xmlTag(block, "aiType") ||
        xmlTag(block, "aitype"),
    );

    const visitor = status.includes("visitor");
    if (visitor) {
      out.add("doorbell");
      continue;
    }

    const objects: ReolinkSimpleEventType[] = [];
    for (const token of ai) {
      if (token === "none" || token === "other") continue;
      const mapped = AI_OBJECT_MAP[token];
      if (mapped) objects.push(mapped);
    }
    if (objects.length > 0) {
      for (const t of objects) out.add(t);
      continue;
    }

    const statusIndicatesMotion = status.some(
      (s) => s !== "none" && s !== "visitor" && s !== "dn" && s !== "daynight",
    );
    // Wired Power doorbell: motion = status none + AItype other.
    const aiIndicatesMotion = ai.some((a) => a !== "none");
    if (statusIndicatesMotion || aiIndicatesMotion) {
      out.add("motion");
    }
  }

  return [...out];
}
