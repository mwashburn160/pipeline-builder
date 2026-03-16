import Link from 'next/link';
import {
  LayoutDashboard,
  GitBranch,
  Puzzle,
  MessageSquare,
  ScrollText,
  Activity,
  Container,
  FileBarChart,
  Users,
  UsersRound,
  Building2,
  BarChart3,
  CreditCard,
  Settings,
  KeyRound,
  HelpCircle,
  Mail,
  Sun,
  Moon,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { User } from '@/types';
import { useFeatures } from '@/hooks/useFeatures';
import { Tooltip } from './Tooltip';

// ---------------------------------------------------------------------------
// Navigation data
// ---------------------------------------------------------------------------

interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  systemAdminOnly?: boolean;
  requiredFeature?: string;
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
      { title: 'Reports', href: '/dashboard/reports', icon: FileBarChart },
      { title: 'Logs', href: '/dashboard/logs', icon: ScrollText },
      { title: 'Build Queue', href: '/dashboard/build-queue', icon: Container, systemAdminOnly: true },
      { title: 'Grafana', href: '/dashboard/grafana', icon: Activity, systemAdminOnly: true },
    ],
  },
  {
    label: 'Team',
    items: [
      { title: 'Members', href: '/dashboard/members', icon: UsersRound, adminOnly: true },
      { title: 'Users', href: '/dashboard/users', icon: Users, adminOnly: true },
      { title: 'Invitations', href: '/dashboard/invitations', icon: Mail, adminOnly: true },
      { title: 'Organizations', href: '/dashboard/organizations', icon: Building2, systemAdminOnly: true },
    ],
  },
  {
    label: 'Account',
    items: [
      { title: 'Quotas', href: '/dashboard/quotas', icon: BarChart3 },
      { title: 'Billing', href: '/dashboard/billing', icon: CreditCard, requiredFeature: 'billing' },
      { title: 'Settings', href: '/dashboard/settings', icon: Settings },
      { title: 'API Tokens', href: '/dashboard/tokens', icon: KeyRound },
      { title: 'Help', href: '/dashboard/help', icon: HelpCircle },
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
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
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
  collapsed = false,
  onToggleCollapsed,
}: SidebarProps) {
  const features = useFeatures();

  const isActive = (href: string) =>
    href === '/dashboard'
      ? currentPath === '/dashboard'
      : currentPath.startsWith(href);

  const isItemVisible = (item: NavItem) => {
    if (item.systemAdminOnly && !isSysAdmin) return false;
    if (item.adminOnly && !isAdmin) return false;
    if (item.requiredFeature && !features.isEnabled(item.requiredFeature)) return false;
    return true;
  };

  return (
    <div className={`sidebar transition-all duration-200 ${collapsed ? 'w-16' : 'w-64'}`}>
      {/* Brand */}
      <div className={`border-b border-gray-200 dark:border-gray-700 ${collapsed ? 'px-2 py-5' : 'px-4 py-5'}`}>
        <Link
          href="/"
          className="text-lg font-bold text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
        >
          {collapsed ? (
            <Tooltip content="Pipeline Builder" position="right">
              <span className="flex justify-center">PB</span>
            </Tooltip>
          ) : (
            'Pipeline Builder'
          )}
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV_SECTIONS.map((section) => {
          const visibleItems = section.items.filter(isItemVisible);
          if (visibleItems.length === 0) return null;

          return (
            <div key={section.label}>
              {!collapsed && <p className="sidebar-section-label">{section.label}</p>}
              {collapsed && <div className="my-2 mx-3 border-t border-gray-200 dark:border-gray-700" />}
              {visibleItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                const linkContent = (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`sidebar-nav-item ${active ? 'sidebar-nav-item-active' : 'sidebar-nav-item-default'} ${collapsed ? 'justify-center px-0 mx-1' : ''}`}
                  >
                    <Icon className="w-[18px] h-[18px] flex-shrink-0" />
                    {!collapsed && <span className="flex-1">{item.title}</span>}
                    {!collapsed && item.title === 'Messages' && unreadCount > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[11px] font-bold text-white bg-red-500 rounded-full">
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </span>
                    )}
                    {collapsed && item.title === 'Messages' && unreadCount > 0 && (
                      <span className="absolute top-0 right-0 w-2.5 h-2.5 bg-red-500 rounded-full" />
                    )}
                  </Link>
                );

                return collapsed ? (
                  <Tooltip key={item.href} content={item.title} position="right">
                    <span className="relative block">{linkContent}</span>
                  </Tooltip>
                ) : (
                  <span key={item.href}>{linkContent}</span>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-gray-200 dark:border-gray-700 p-4 space-y-3">
        {/* Collapse toggle (desktop only) */}
        {onToggleCollapsed && (
          <button
            onClick={onToggleCollapsed}
            className="w-full flex items-center justify-center gap-2 px-3 py-1.5 text-sm rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
            {!collapsed && <span className="text-xs">Collapse</span>}
          </button>
        )}

        {/* User info */}
        {!collapsed && (
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
        )}

        {/* Actions */}
        <div className={`flex items-center ${collapsed ? 'flex-col' : ''} gap-2`}>
          {collapsed ? (
            <>
              <Tooltip content={isDark ? 'Light mode' : 'Dark mode'} position="right">
                <button
                  onClick={onToggleDark}
                  className="p-2 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  aria-label="Toggle dark mode"
                >
                  {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                </button>
              </Tooltip>
              <Tooltip content="Log out" position="right">
                <button
                  onClick={onLogout}
                  className="p-2 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400 transition-colors"
                  aria-label="Log out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </Tooltip>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
