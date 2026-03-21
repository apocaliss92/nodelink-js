import { useNavigate, useLocation } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';

interface NavSidebarItemProps {
  label: string;
  icon: LucideIcon;
  href: string;
  badge?: string | number;
}

export function NavSidebarItem({ label, icon: Icon, href, badge }: NavSidebarItemProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const active = location.pathname === href;

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(href);
  };

  return (
    <a
      href={href}
      onClick={handleClick}
      data-active={active || undefined}
      className="group flex h-7 items-center gap-2 rounded-sm px-2 text-[11px] font-medium transition-colors text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)] data-[active]:border-l-2 data-[active]:border-[var(--color-primary)] data-[active]:bg-[var(--color-primary)]/[0.08] data-[active]:text-[var(--color-foreground)]"
    >
      <Icon size={14} />
      <span>{label}</span>
      {badge != null && (
        <span className="ml-auto rounded-full bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px]">
          {badge}
        </span>
      )}
    </a>
  );
}
