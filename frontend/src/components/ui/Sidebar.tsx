import Link from 'next/link';
import {
  LayoutDashboard,
  GitBranch,
  Puzzle,
  MessageSquare,
  ScrollText,
  Activity,
  Users,
  Building2,
  BarChart3,
  CreditCard,
  Settings,
  KeyRound,
  Sun,
  Moon,
  LogOut,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { User } from '@/types';

// ---------------------------------------------------------------------------
// Navigation data
// ---------------------------------------------------------------------------

interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  systemAdminOnly?: boolean;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Overview',
    items: [
      { title: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    ],
  },
  {
    label: 'Resources',
    items: [
      { title: 'Pipelines', href: '/dashboard/pipelines', icon: GitBranch },
      { title: 'Plugins', href: '/dashboard/plugins', icon: Puzzle },
    ],
  },
  {
    label: 'Operations',
    items: [
      { title: 'Messages', href: '/dashboard/messages', icon: MessageSquare },
      { title: 'Logs', href: '/dashboard/logs', icon: ScrollText },
      { title: 'Grafana', href: '/dashboard/grafana', icon: Activity, systemAdminOnly: true },
    ],
  },
  {
    label: 'Team',
    items: [
      { title: 'Users', href: '/dashboard/users', icon: Users, adminOnly: true },
      { title: 'Organizations', href: '/dashboard/organizations', icon: Building2, systemAdminOnly: true },
    ],
  },
  {
    label: 'Account',
    items: [
      { title: 'Quotas', href: '/dashboard/quotas', icon: BarChart3 },
      { title: 'Billing', href: '/dashboard/billing', icon: CreditCard },
      { title: 'Settings', href: '/dashboard/settings', icon: Settings },
      { title: 'API Tokens', href: '/dashboard/tokens', icon: KeyRound },
    ],
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SidebarProps {
  isSysAdmin: boolean;
  isAdmin: boolean;
  user: User;
  unreadCount: number;
  currentPath: string;
  isDark: boolean;
  onToggleDark: () => void;
  onLogout: () => void;
}

export function Sidebar({
  isSysAdmin,
  isAdmin,
  user,
  unreadCount,
  currentPath,
  isDark,
  onToggleDark,
  onLogout,
}: SidebarProps) {

  const isActive = (href: string) =>
    href === '/dashboard'
      ? currentPath === '/dashboard'
      : currentPath.startsWith(href);

  const isItemVisible = (item: NavItem) => {
    if (item.systemAdminOnly && !isSysAdmin) return false;
    if (item.adminOnly && !isAdmin) return false;
    return true;
  };

  return (
    <div className="sidebar">
      {/* Brand */}
      <div className="px-4 py-5 border-b border-gray-200 dark:border-gray-700">
        <Link
          href="/"
          className="text-lg font-bold text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
        >
          Pipeline Builder
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV_SECTIONS.map((section) => {
          const visibleItems = section.items.filter(isItemVisible);
          if (visibleItems.length === 0) return null;

          return (
            <div key={section.label}>
              <p className="sidebar-section-label">{section.label}</p>
              {visibleItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`sidebar-nav-item ${active ? 'sidebar-nav-item-active' : 'sidebar-nav-item-default'}`}
                  >
                    <Icon className="w-[18px] h-[18px] flex-shrink-0" />
                    <span className="flex-1">{item.title}</span>
                    {item.title === 'Messages' && unreadCount > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[11px] font-bold text-white bg-red-500 rounded-full">
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-gray-200 dark:border-gray-700 p-4 space-y-3">
        {/* User info */}
        <div className="px-1">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {user.username}
          </p>
          {user.organizationName && (
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {user.organizationName}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleDark}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-sm rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label="Toggle dark mode"
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            <span className="text-xs">{isDark ? 'Light' : 'Dark'}</span>
          </button>
          <button
            onClick={onLogout}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-sm rounded-lg text-gray-600 dark:text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400 transition-colors"
            aria-label="Log out"
          >
            <LogOut className="w-4 h-4" />
            <span className="text-xs">Log out</span>
          </button>
        </div>
      </div>
    </div>
  );
}
