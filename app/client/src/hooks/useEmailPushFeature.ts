import { useEffect, useState } from "react";
import { trpcQuery } from "../api";

/**
 * Single source of truth for whether the email-push UI surfaces (camera
 * settings tab, manager settings panel, news caveats) should be visible.
 *
 * The feature is intentionally hidden by default and gated by a flag in
 * `settings.json` (`emailPush.featureEnabled`) that has no UI toggle —
 * flip it manually when you want to experiment with the SMTP intake.
 */
export function useEmailPushFeature(): { enabled: boolean; loading: boolean } {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await trpcQuery<{ featureEnabled?: boolean }>(
          "emailPush.getSettings",
        );
        if (!cancelled) setEnabled(Boolean(cfg?.featureEnabled));
      } catch {
        if (!cancelled) setEnabled(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { enabled, loading };
}
