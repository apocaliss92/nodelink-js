import { Camera, FileText, Settings, BookOpen, BarChart3, Activity } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  label: string;
  icon: LucideIcon;
  href: string;
}

export const navItems: NavItem[] = [
  { label: 'Cameras', icon: Camera, href: '/' },
  { label: 'Logs', icon: FileText, href: '/logs' },
  { label: 'Settings', icon: Settings, href: '/settings' },
  { label: 'Docs', icon: BookOpen, href: '/docs' },
  { label: 'Capture', icon: Activity, href: '/capture' },
  { label: 'Reports', icon: BarChart3, href: '/reports' },
];
