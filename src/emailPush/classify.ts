/**
 * Classify an inbound SMTP motion mail into an Email Push inferred type.
 */

import type { EmailPushInferredType } from "./bus.js";

export interface EmailPushClassifyInput {
  subject?: string | null;
  text?: string | null;
}

/**
 * Infer the trigger type from subject/body.
 *
 * Important: camera names like "Doorbell" appear in subjects such as
 * `Motion Detected from Doorbell at …`. Matching bare `/doorbell/` before
 * motion phrases mis-classifies every motion mail as a doorbell press.
 */
export function classifyEmailPushMessage(
  input: EmailPushClassifyInput,
): EmailPushInferredType {
  const subject = (input.subject ?? "").toLowerCase();
  const text = (input.text ?? "").toLowerCase();
  const haystack = `${subject} ${text}`;

  if (/person|people|human/.test(haystack)) return "people";
  if (/vehicle|car|truck/.test(haystack)) return "vehicle";
  if (/dog[_\s-]?cat|pet|animal/.test(haystack)) return "animal";
  if (/face/.test(haystack)) return "face";
  if (/package|parcel/.test(haystack)) return "package";

  // Explicit doorbell / visitor phrases (before generic motion).
  if (
    /ring(?:ing)?\s+button|doorbell\s+(?:press|ring|button)|visitor\s+at|someone\s+rang/.test(
      haystack,
    )
  ) {
    return "doorbell";
  }

  // Motion / alarm / detect — wins over a camera named "Doorbell" in the From phrase.
  if (/motion|alarm|alert|detect/.test(haystack)) return "motion";

  // Bare "doorbell" only when the mail is not clearly a motion-from-<name> subject.
  if (
    /\bdoorbell\b/.test(haystack) &&
    !/\bfrom\s+[^\n]*doorbell/.test(haystack)
  ) {
    return "doorbell";
  }

  return "other";
}
