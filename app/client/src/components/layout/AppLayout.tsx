import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { LogOut, Github, Moon, Sun, Monitor, Coffee, Megaphone } from 'lucide-react';
import { useThemeMode } from '@camstack/ui-library';
import { useAuth } from '../../auth';
import { NodelinkIcon } from './NodelinkIcon';
import { NavSidebarItem } from './NavSidebarItem';
import { BottomNav } from './BottomNav';
import { navItems } from './nav-items';
import { NewsModal } from '../../news/NewsModal';
import { useNews } from '../../news/useNews';

const THEME_ICONS = { dark: Moon, light: Sun, system: Monitor } as const;
const THEME_LABELS = { dark: 'Dark', light: 'Light', system: 'System' } as const;

interface AppLayoutProps {
  version?: string;
  updateAvailable?: boolean;
}

export function AppLayout({ version, updateAvailable }: AppLayoutProps) {
  const { state, logout } = useAuth();
  const theme = useThemeMode();
  const { items: newsItems, hasUnread, markAllSeen } = useNews();
  const [newsOpen, setNewsOpen] = useState(false);

  // Auto-open the news modal once when there's unread content. The user can
  // dismiss it; the `Got it` / close handlers call markAllSeen() which
  // persists the latest news id in localStorage.
  useEffect(() => {
    if (hasUnread) setNewsOpen(true);
  }, [hasUnread]);

  const closeNews = () => {
    setNewsOpen(false);
    markAllSeen();
  };

  const ThemeIcon = THEME_ICONS[theme?.mode ?? 'system'];

  return (
    <div className="flex h-screen bg-[var(--color-background)] text-[var(--color-foreground)]">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-44 min-w-[176px] flex-col border-r border-[var(--color-border)] bg-[var(--color-background-elevated)]">
        <div className="flex h-full flex-col p-2">
          {/* Logo */}
          <div className="flex items-center gap-2 p-2 mb-4">
            <NodelinkIcon size={28} />
            <span className="text-sm font-semibold">Nodelink.js</span>
          </div>

          {/* Navigation */}
          <nav className="flex flex-col gap-0.5">
            {navItems.map((item) => (
              <NavSidebarItem key={item.href} {...item} />
            ))}
          </nav>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Bottom controls */}
          <div className="flex flex-col gap-1 border-t border-[var(--color-border)] pt-3 mt-2 px-2.5">
            {/* What's new */}
            <button
              onClick={() => setNewsOpen(true)}
              className="relative flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[11px] text-[var(--color-foreground-subtle)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)] transition-colors"
              title="What's new"
            >
              <Megaphone className="h-3.5 w-3.5" />
              <span>What&apos;s new</span>
              {hasUnread && (
                <span
                  className="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--color-brand)]"
                  aria-label="Unread news"
                />
              )}
            </button>

            {/* Theme toggle */}
            <button
              onClick={() => theme?.toggleMode()}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[11px] text-[var(--color-foreground-subtle)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)] transition-colors"
            >
              <ThemeIcon className="h-3.5 w-3.5" />
              <span>{THEME_LABELS[theme?.mode ?? 'system']}</span>
            </button>

            {/* User + logout */}
            <div className="flex items-center justify-between px-2 py-1.5 text-[11px] text-[var(--color-foreground-subtle)]">
              <span className="truncate">{state.user?.username ?? 'User'}</span>
              <button
                onClick={logout}
                className="hover:text-[var(--color-danger)] transition-colors shrink-0"
                title="Sign out"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* GitHub + Coffee */}
            <div className="flex items-center">
              <a
                href="https://github.com/ApoCaliss92/reolink-baichuan-js"
                target="_blank"
                rel="noopener noreferrer"
                className="flex flex-1 items-center justify-center py-1.5 text-[var(--color-foreground-subtle)] hover:text-[var(--color-foreground)] hover:bg-[var(--color-surface-hover)] rounded-md transition-colors"
                title="GitHub"
              >
                <Github size={14} />
              </a>
              <a
                href="https://buymeacoffee.com/apocaliss92"
                target="_blank"
                rel="noopener noreferrer"
                className="flex flex-1 items-center justify-center py-1.5 text-[var(--color-foreground-subtle)] hover:text-[var(--color-warning)] hover:bg-[var(--color-surface-hover)] rounded-md transition-colors"
                title="Buy me a coffee"
              >
                <Coffee size={14} />
              </a>
            </div>

            {/* Version */}
            {version && (
              <div className="px-2 pb-1 text-[11px] text-[var(--color-foreground-muted)]">
                {version}
                {updateAvailable && (
                  <span className="ml-1.5 text-[var(--color-warning)]">update available</span>
                )}
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto pb-16 md:pb-0">
        <Outlet />
      </main>

      {/* Mobile Bottom Nav */}
      <BottomNav />

      {/* News / What's new modal */}
      <NewsModal open={newsOpen} items={newsItems} onClose={closeNews} />
    </div>
  );
}
