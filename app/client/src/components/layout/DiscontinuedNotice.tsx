import { ExternalLink } from 'lucide-react';

/** Where the Manager UI's successor documents Reolink support. */
export const CAMSTACK_REOLINK_DOCS_URL = 'https://camstack-docs.zentik.app/docs/camera-settings/reolink';

/** Fixed sidebar notice: the Manager UI is no longer developed; CamStack replaces it. */
export function DiscontinuedNotice() {
  return (
    <div className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-2 text-[11px] leading-snug text-[var(--color-foreground-subtle)]">
      <p className="font-semibold text-[var(--color-foreground)]">Development stopped</p>
      <p className="mt-1">This Manager UI is no longer developed. It continues in CamStack.</p>
      <a
        href={CAMSTACK_REOLINK_DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1.5 inline-flex items-center gap-1 text-[var(--color-brand)] hover:underline"
      >
        CamStack docs <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
