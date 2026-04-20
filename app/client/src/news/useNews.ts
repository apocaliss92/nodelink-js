/**
 * useNews — tracks whether the user has seen the latest news item.
 *
 * Rule:
 *   - The "latest id" is `NEWS_ITEMS[0].id` (items are ordered newest-first).
 *   - LocalStorage key `LAST_SEEN_KEY` stores the last id the user dismissed.
 *   - `hasUnread` is true when the stored id differs from the latest id.
 *   - `markAllSeen()` writes the latest id back to localStorage and flips
 *     `hasUnread` to false immediately.
 *
 * The modal auto-opens on mount when `hasUnread === true`. A sidebar button
 * can also open it manually regardless of the seen state.
 */

import { useCallback, useEffect, useState } from "react";
import { NEWS_ITEMS } from "./news-items";

const LAST_SEEN_KEY = "nodelink.lastSeenNewsId";

function readLastSeen(): string | null {
  try {
    return window.localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

function writeLastSeen(id: string): void {
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, id);
  } catch {
    // ignore quota / private mode failures
  }
}

export function useNews() {
  const latestId = NEWS_ITEMS[0]?.id ?? null;
  const [hasUnread, setHasUnread] = useState<boolean>(() => {
    if (!latestId) return false;
    return readLastSeen() !== latestId;
  });

  // If news items ship via a build that happens while the tab is open,
  // re-evaluate on focus so the badge shows up without reload.
  useEffect(() => {
    if (!latestId) return;
    const onFocus = () => setHasUnread(readLastSeen() !== latestId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [latestId]);

  const markAllSeen = useCallback(() => {
    if (!latestId) return;
    writeLastSeen(latestId);
    setHasUnread(false);
  }, [latestId]);

  return {
    items: NEWS_ITEMS,
    hasUnread,
    markAllSeen,
  } as const;
}
