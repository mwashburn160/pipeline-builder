import { useState } from 'react';
import Link from 'next/link';
import {
  LayoutDashboard,
  GitBranch,
  Puzzle,
  Shield,
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
  Download,
  Mail,
  Sun,
  Moon,
  LogOut,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  AlertTriangle,
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
  children?: NavItem[];
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
      { title: 'Build Queue', href: '/dashboard/build-queue', icon: Container, systemAdminOnly: true },
      { title: 'Build Triage', href: '/dashboard/triage', icon: AlertTriangle, systemAdminOnly: true },
    ],
  },
  {
    label: 'Insights',
    items: [
      { title: 'Reports', href: '/dashboard/reports', icon: FileBarChart },
      { title: 'Plugin Reports', href: '/dashboard/plugin-reports', icon: FileBarChart },
      { title: 'Compliance', href: '/dashboard/compliance', icon: Shield, adminOnly: true },
      { title: 'Logs', href: '/dashboard/logs', icon: ScrollText },
      { title: 'Grafana', href: '/dashboard/grafana', icon: Activity, systemAdminOnly: true },
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
  const [expandedItems, setExpandedItems] = useState<Set<string>>(() => {
    // Auto-expand parents whose children match the current path
    const expanded = new Set<string>();
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        if (item.children?.some(c => currentPath.startsWith(c.href))) {
          expanded.add(item.title);
        }
      }
    }
    return expanded;
  });

  const toggleExpand = (title: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  };

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
                const hasChildren = item.children && item.children.length > 0;
                const isExpanded = expandedItems.has(item.title);
                const childActive = hasChildren && item.children!.some(c => isActive(c.href));
                const active = hasChildren ? childActive : isActive(item.href);

                // Parent with children — render as expandable group
                if (hasChildren && !collapsed) {
                  const visibleChildren = item.children!.filter(isItemVisible);
                  if (visibleChildren.length === 0) return null;

                  return (
                    <div key={item.title}>
                      <button
                        type="button"
                        onClick={() => toggleExpand(item.title)}
                        className={`sidebar-nav-item relative w-full ${active ? 'sidebar-nav-item-active' : 'sidebar-nav-item-default'}`}
                      >
                        {active && (
                          <span className="absolute left-1 top-1/2 h-6 w-1 -translate-y-1/2 rounded-full bg-blue-500/80 dark:bg-blue-400/80" />
                        )}
                        <Icon className="w-[18px] h-[18px] flex-shrink-0" />
                        <span className="flex-1 text-left">{item.title}</span>
                        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                      </button>
                      {isExpanded && (
                        <div className="ml-4 border-l border-gray-200 dark:border-gray-700">
                          {visibleChildren.map((child) => {
                            const ChildIcon = child.icon;
                            const childIsActive = isActive(child.href);
                            return (
                              <Link
                                key={child.href}
                                href={child.href}
                                aria-current={childIsActive ? 'page' : undefined}
                                className={`sidebar-nav-item relative text-[13px] py-1.5 ${childIsActive ? 'sidebar-nav-item-active' : 'sidebar-nav-item-default'}`}
                              >
                                <ChildIcon className="w-4 h-4 flex-shrink-0" />
                                <span className="flex-1">{child.title}</span>
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                // Collapsed parent with children — show first child on click, tooltip lists all
                if (hasChildren && collapsed) {
                  return (
                    <Tooltip key={item.title} content={item.title}>
                      <span className="relative block">
                        <Link
                          href={item.href}
                          className={`sidebar-nav-item relative justify-center px-0 mx-1 ${active ? 'sidebar-nav-item-active' : 'sidebar-nav-item-default'}`}
                        >
                          {active && (
                            <span className="absolute left-1 top-1/2 h-6 w-1 -translate-y-1/2 rounded-full bg-blue-500/80 dark:bg-blue-400/80" />
                          )}
                          <Icon className="w-[18px] h-[18px] flex-shrink-0" />
                        </Link>
                      </span>
                    </Tooltip>
                  );
                }

                // Regular item (no children)
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
