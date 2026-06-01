import Link from 'next/link';
import {
  LayoutDashboard,
  GitBranch,
  Puzzle,
  Shield,
  MessageSquare,
  ScrollText,
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
  Download,
  Mail,
  Sun,
  Moon,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  AlertTriangle,
  Boxes,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { User } from '@/types';
import { useFeatures } from '@/hooks/useFeatures';
import { Tooltip } from './Tooltip';
import { OrgSwitcher } from './OrgSwitcher';

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

const QUICK_ACTIONS: { href: string; label: string; icon: LucideIcon; color: string }[] = [
  { href: '/dashboard/pipelines', label: 'Create Pipeline', icon: Plus, color: 'bg-blue-600' },
  { href: '/dashboard/plugins', label: 'Add Plugin', icon: Plus, color: 'bg-amber-500' },
  { href: '/dashboard/downloads', label: 'Get the CLI', icon: Download, color: 'bg-green-600' },
];

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Overview',
    items: [
      { title: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
      { title: 'Messages', href: '/dashboard/messages', icon: MessageSquare },
    ],
  },
  {
    label: 'Build',
    items: [
      { title: 'Pipelines', href: '/dashboard/pipelines', icon: GitBranch },
      { title: 'Plugins', href: '/dashboard/plugins', icon: Puzzle },
      { title: 'Registry', href: '/dashboard/registry', icon: Boxes, systemAdminOnly: true },
      { title: 'Build Queue', href: '/dashboard/build-queue', icon: Container, systemAdminOnly: true },
      { title: 'Build Triage', href: '/dashboard/triage', icon: AlertTriangle, adminOnly: true },
    ],
  },
  {
    label: 'Insights',
    items: [
      { title: 'Reports', href: '/dashboard/reports', icon: FileBarChart },
      { title: 'Compliance', href: '/dashboard/compliance', icon: Shield, adminOnly: true },
      { title: 'Logs', href: '/dashboard/logs', icon: ScrollText },
      // Observability is visible to any authenticated user. Server-side
      // $ORG substitution scopes their view to their own org's metrics;
      // sysadmins see all orgs.
      { title: 'Observability', href: '/dashboard/observability', icon: BarChart3 },
    ],
  },
  {
    label: 'Organization',
    items: [
      { title: 'Members', href: '/dashboard/team', icon: UsersRound, adminOnly: true },
      { title: 'Invitations', href: '/dashboard/invitations', icon: Mail, adminOnly: true },
      { title: 'Quotas', href: '/dashboard/quotas', icon: BarChart3 },
      { title: 'Billing', href: '/dashboard/billing', icon: CreditCard, requiredFeature: 'billing' },
      { title: 'All Users', href: '/dashboard/users', icon: Users, systemAdminOnly: true },
      { title: 'All Organizations', href: '/dashboard/organizations', icon: Building2, systemAdminOnly: true },
    ],
  },
  {
    label: 'Settings',
    items: [
      { title: 'Profile', href: '/dashboard/settings', icon: Settings },
      { title: 'API Tokens', href: '/dashboard/tokens', icon: KeyRound },
      { title: 'Downloads', href: '/dashboard/downloads', icon: Download },
      { title: 'Help', href: '/dashboard/help', icon: HelpCircle },
    ],
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SidebarProps {
  isSuperAdmin: boolean;
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
  isSuperAdmin,
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
    if (item.systemAdminOnly && !isSuperAdmin) return false;
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
          className="text-lg font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors tracking-tight"
        >
          {collapsed ? (
            <Tooltip content="Pipeline Builder">
              <span className="flex justify-center">PB</span>
            </Tooltip>
          ) : (
            'Pipeline Builder'
          )}
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2">
        {!collapsed && (
          <div className="px-3">
            <div className="mb-4 rounded-2xl border border-blue-200/60 dark:border-blue-800/50 bg-blue-50/70 dark:bg-blue-900/20 p-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-blue-600/80 dark:text-blue-300/80">
                Quick Actions
              </p>
              <div className="mt-2 space-y-2">
                {QUICK_ACTIONS.map(({ href, label, icon: Icon, color }) => (
                  <Link
                    key={href}
                    href={href}
                    className="flex items-center gap-2 rounded-xl bg-white/80 dark:bg-gray-900/70 px-3 py-2 text-sm font-medium text-gray-900 dark:text-gray-100 shadow-sm hover:shadow-md transition-shadow"
                  >
                    <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${color} text-white`}>
                      <Icon className="h-4 w-4" />
                    </span>
                    {label}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        )}
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
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`sidebar-nav-item relative ${active ? 'sidebar-nav-item-active' : 'sidebar-nav-item-default'} ${collapsed ? 'justify-center px-0 mx-1' : ''}`}
                  >
                    {active && (
                      <span className="absolute left-1 top-1/2 h-6 w-1 -translate-y-1/2 rounded-full bg-blue-500/80 dark:bg-blue-400/80" />
                    )}
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
                  <Tooltip key={item.href} content={item.title}>
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

        {/* Org switcher + User info */}
        {!collapsed && (
          <div className="space-y-2">
            <OrgSwitcher />
            <div className="px-1">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {user.username}
              </p>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className={`flex items-center ${collapsed ? 'flex-col' : ''} gap-2`}>
          {collapsed ? (
            <>
              <Tooltip content={isDark ? 'Light mode' : 'Dark mode'}>
                <button
                  onClick={onToggleDark}
                  className="p-2 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  aria-label="Toggle dark mode"
                >
                  {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                </button>
              </Tooltip>
              <Tooltip content="Log out">
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
