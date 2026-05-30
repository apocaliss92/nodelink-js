/**
 * Visibility gate for the email-push UI surfaces. The feature is now
 * always enabled (testing-ready); the hook is kept so existing call sites
 * keep working without churn. Manual SMTP server settings (port, domain,
 * auth, etc.) remain editable from Settings → Email Push.
 */
export function useEmailPushFeature(): { enabled: boolean; loading: boolean } {
  return { enabled: true, loading: false };
}
