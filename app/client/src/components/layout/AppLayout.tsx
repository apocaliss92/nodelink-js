import { Outlet } from 'react-router-dom';
import { LogOut, Github, Moon, Sun, Monitor } from 'lucide-react';
import { useThemeMode } from '@apocaliss92/camstack-ui';
import { useAuth } from '../../auth';
import { NodelinkIcon } from './NodelinkIcon';
import { NavSidebarItem } from './NavSidebarItem';
import { BottomNav } from './BottomNav';
import { navItems } from './nav-items';

const THEME_ICONS = { dark: Moon, light: Sun, system: Monitor } as const;
const THEME_LABELS = { dark: 'Dark', light: 'Light', system: 'System' } as const;

interface AppLayoutProps {
  version?: string;
  updateAvailable?: boolean;
}

export function AppLayout({ version, updateAvailable }: AppLayoutProps) {
  const { state, logout } = useAuth();
  const theme = useThemeMode();

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
          <div className="flex flex-col gap-0.5 border-t border-[var(--color-border)] pt-2 mt-2">
            {/* Theme toggle */}
            <button
              onClick={() => theme?.toggleMode()}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12px] text-[var(--color-foreground-subtle)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)] transition-colors"
            >
              <ThemeIcon className="h-3.5 w-3.5" />
              <span>{THEME_LABELS[theme?.mode ?? 'system']}</span>
            </button>

            {/* User + logout */}
            <button
              onClick={() => { if (state.enabled) logout(); }}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12px] text-[var(--color-foreground-subtle)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-danger)] transition-colors"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="truncate">{state.user?.username ?? 'User'}</span>
            </button>

            {/* Footer links + version */}
            <div className="flex items-center justify-between px-2.5 pt-1">
              <a
                href="https://github.com/ApoCaliss92/reolink-baichuan-js"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-foreground-subtle)] hover:text-[var(--color-foreground)] transition-colors"
              >
                <Github size={12} />
              </a>
              {version && (
                <span className="text-[10px] text-[var(--color-foreground-subtle)]">
                  {version}
                  {updateAvailable && (
                    <span className="ml-1 text-[var(--color-warning)]">update</span>
                  )}
                </span>
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto pb-16 md:pb-0">
        <Outlet />
      </main>

      {/* Mobile Bottom Nav */}
      <BottomNav />
    </div>
  );
}
