import { Outlet } from 'react-router-dom';
import { LogOut, Github } from 'lucide-react';
import { useAuth } from '../../auth';
import { NodelinkIcon } from './NodelinkIcon';
import { NavSidebarItem } from './NavSidebarItem';
import { BottomNav } from './BottomNav';
import { navItems } from './nav-items';

interface AppLayoutProps {
  version?: string;
  updateAvailable?: boolean;
}

export function AppLayout({ version, updateAvailable }: AppLayoutProps) {
  const { state, logout } = useAuth();

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

          {/* Footer */}
          <div className="flex flex-col gap-1 border-t border-[var(--color-border)] pt-2 mt-2">
            {state.user && (
              <div className="px-2 text-[11px] text-[var(--color-foreground-muted)] truncate">
                {state.user.username}
              </div>
            )}
            <div className="flex items-center gap-1 px-2">
              <a
                href="https://github.com/ApoCaliss92/reolink-baichuan-js"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-foreground-subtle)] hover:text-[var(--color-foreground)] transition-colors"
              >
                <Github size={14} />
              </a>
              {state.enabled && (
                <button
                  onClick={logout}
                  className="text-[var(--color-foreground-subtle)] hover:text-[var(--color-danger)] transition-colors"
                  title="Sign out"
                >
                  <LogOut size={14} />
                </button>
              )}
            </div>
            {version && (
              <div className="px-2 text-[10px] text-[var(--color-foreground-subtle)]">
                {version}
                {updateAvailable && (
                  <span className="ml-1 text-[var(--color-warning)]">update</span>
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
    </div>
  );
}
