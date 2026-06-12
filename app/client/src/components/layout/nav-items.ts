import { Camera, FileText, Settings, BookOpen, BarChart3, Activity } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  label: string;
  icon: LucideIcon;
  href: string;
  /** Hidden under Docker — shown only on local/bare-metal installs. */
  localOnly?: boolean;
}

export const navItems: NavItem[] = [
  { label: 'Cameras', icon: Camera, href: '/' },
  { label: 'Logs', icon: FileText, href: '/logs' },
  { label: 'Settings', icon: Settings, href: '/settings' },
  { label: 'Docs', icon: BookOpen, href: '/docs' },
  { label: 'Capture', icon: Activity, href: '/capture', localOnly: true },
  { label: 'Reports', icon: BarChart3, href: '/reports' },
];

/**
 * Filter the nav items for the current runtime. `localOnly` items (Capture) are
 * dropped under Docker, where the feature needs host networking + raw caps.
 */
export function visibleNavItems(captureAvailable: boolean): NavItem[] {
  return navItems.filter((item) => !item.localOnly || captureAvailable);
}
