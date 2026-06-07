import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Sun,
  Moon,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
} from 'lucide-react';
import type { User } from '@/types';
import { useFeatures } from '@/hooks/useFeatures';
import { NAV_SECTIONS, QUICK_ACTIONS, isNavItemVisible, type NavItem } from '@/lib/nav';
import { Tooltip } from './Tooltip';
import { OrgSwitcher } from './OrgSwitcher';

/** localStorage key for which nav sections the user has collapsed. */
const NAV_SECTIONS_KEY = 'pb-nav-collapsed-sections:v1';

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

  // Collapsible nav sections (persisted to localStorage). With 6 sections the
  // rail can get long for admins; users hide groups they don't use. Ignored in
  // the icon-only (sidebar-collapsed) mode, where items render as icon rows.
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem(NAV_SECTIONS_KEY);
      if (raw) setCollapsedSections(new Set(JSON.parse(raw) as string[]));
    } catch { /* ignore unavailable/corrupt storage */ }
  }, []);
  const toggleSection = (label: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      try { localStorage.setItem(NAV_SECTIONS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  const isActive = (href: string) =>
    href === '/dashboard'
      ? currentPath === '/dashboard'
      : currentPath.startsWith(href);

  const isItemVisible = (item: NavItem) =>
    isNavItemVisible(item, { isAdmin, isSuperAdmin, isFeatureEnabled: (n) => features.isEnabled(n) });

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

      {/* Organization / team switcher — placed directly under the brand (was
          buried at the bottom of the rail) so switching orgs/teams is easy to
          find. Self-hides when the user belongs to a single org. */}
      {!collapsed && <OrgSwitcher className="px-3 py-2.5 border-b border-gray-200 dark:border-gray-700" />}

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2">
        {/* Quick actions — a compact icon row (was a chunky labelled card that
            duplicated nav and pushed the rail down). Tooltips name each. */}
        {!collapsed && (
          <div className="px-3 pt-1 pb-2 flex items-center gap-1.5">
            {QUICK_ACTIONS.map(({ href, label, icon: Icon, color }) => (
              <Tooltip key={href} content={label}>
                <Link
                  href={href}
                  aria-label={label}
                  className={`flex-1 inline-flex items-center justify-center h-8 rounded-lg ${color} text-white hover:opacity-90 transition-opacity`}
                >
                  <Icon className="h-4 w-4" />
                </Link>
              </Tooltip>
            ))}
          </div>
        )}
        {NAV_SECTIONS.map((section) => {
          const visibleItems = section.items.filter(isItemVisible);
          if (visibleItems.length === 0) return null;

          return (
            <div key={section.label}>
              {!collapsed && (
                <button
                  type="button"
                  onClick={() => toggleSection(section.label)}
                  aria-expanded={!collapsedSections.has(section.label)}
                  className="w-full flex items-center justify-between sidebar-section-label hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                >
                  <span>{section.label}</span>
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${collapsedSections.has(section.label) ? '-rotate-90' : ''}`} />
                </button>
              )}
              {collapsed && <div className="my-2 mx-3 border-t border-gray-200 dark:border-gray-700" />}
              {(collapsed || !collapsedSections.has(section.label)) && visibleItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href)
                  || (item.extraActivePaths?.some((p) => currentPath.startsWith(p)) ?? false);

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

        {/* User info (the org/team switcher moved up under the brand). */}
        {!collapsed && (
          <div className="space-y-2">
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
