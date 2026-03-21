import { useNavigate, useLocation } from 'react-router-dom';
import { navItems } from './nav-items';

export function BottomNav() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-[var(--color-border)] bg-[var(--color-background-elevated)] md:hidden">
      {navItems.map((item) => {
        const active = location.pathname === item.href;
        return (
          <button
            key={item.href}
            onClick={() => navigate(item.href)}
            className={[
              'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] transition-colors',
              active
                ? 'text-[var(--color-primary)]'
                : 'text-[var(--color-foreground-subtle)]',
            ].join(' ')}
          >
            <item.icon size={18} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
