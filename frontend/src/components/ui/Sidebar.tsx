import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Sun,
  Moon,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  Lock,
} from 'lucide-react';
import { hasPermission, isMutationPermission } from '@/lib/auth-helpers';
import { useAuth } from '@/hooks/useAuth';
import { type User } from '@/types';
import { useBillingEnabled } from '@/hooks/useBillingEnabled';
import { useFeatures } from '@/hooks/useFeatures';
import { NAV_SECTIONS, QUICK_ACTIONS, isNavItemVisible, navItemLockedFeature, type NavItem } from '@/lib/nav';
import { Tooltip } from './Tooltip';

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
  const billingEnabled = useBillingEnabled();
  const { isEnabled: isFeatureEnabled } = useFeatures();
  const { isReadOnly } = useAuth();
  // A quick action is available only if permitted AND not a write blocked by a
  // read-only impersonation session (matches nav.ts's documented `can()` intent).
  const quickActionAllowed = (perm?: string) =>
    !perm || (hasPermission(user, perm) && !(isReadOnly && isMutationPermission(perm)));

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

  const navCtx = { isAdmin, isSuperAdmin, hasPermission: (p: string) => hasPermission(user, p), billingEnabled, isFeatureEnabled };

  // `paletteOnly` entries are sub-pages of a listed item: ⌘K finds them by
  // name, the sidebar leaves them to their parent's row.
  const isItemVisible = (item: NavItem) => !item.paletteOnly && isNavItemVisible(item, navCtx);

  return (
    <div className={`sidebar transition-all duration-200 ${collapsed ? 'w-16' : 'w-64'}`}>
      {/* Brand row. The collapse control lives here rather than in the footer:
          it belongs with the rail it resizes, and moving it up returned a row of
          vertical space to the nav — which is what the footer was spending it on. */}
      <div className={`flex h-12 items-center border-b border-default ${collapsed ? 'justify-center px-2' : 'gap-2 px-4'}`}>
        <Link
          href="/"
          className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-fg hover:text-brand transition-colors"
        >
          {collapsed ? (
            <Tooltip content="Pipeline Builder">
              <span className="flex justify-center">PB</span>
            </Tooltip>
          ) : (
            'Pipeline Builder'
          )}
        </Link>
        {onToggleCollapsed && !collapsed && (
          <Tooltip content="Collapse sidebar">
            <button
              onClick={onToggleCollapsed}
              className="shrink-0 rounded-lg p-1.5 text-fg-subtle hover:bg-surface-muted hover:text-fg transition-colors"
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2">
        {/* Quick actions — a compact icon row (was a chunky labelled card that
            duplicated nav and pushed the rail down). Tooltips name each. */}
        {!collapsed && (
          <div className="px-3 pt-1 pb-2 flex items-center gap-1.5">
            {QUICK_ACTIONS.filter((qa) => quickActionAllowed(qa.requiredPermission)).map(({ href, label, icon: Icon, color }) => (
              <Tooltip key={href} content={label}>
                <Link
                  href={href}
                  aria-label={label}
                  className={`flex-1 inline-flex h-8 items-center justify-center rounded-lg text-sm transition-colors ${color}`}
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

          // `alwaysExpanded` sections ignore persisted collapse state and render
          // without a toggle, so navigation can't be hidden by a stale setting.
          const isSectionCollapsed = !section.alwaysExpanded && collapsedSections.has(section.label);

          return (
            <div key={section.label}>
              {!collapsed && (
                section.alwaysExpanded ? (
                  <div className="w-full flex items-center sidebar-section-label">
                    <span>{section.label}</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleSection(section.label)}
                    aria-expanded={!isSectionCollapsed}
                    className="w-full flex items-center justify-between sidebar-section-label hover:text-fg transition-colors"
                  >
                    <span className="flex items-center gap-1.5">
                      {section.label}
                      {/* Count of hidden items so a collapsed section reads as
                          "collapsed", not "empty/missing". */}
                      {isSectionCollapsed && (
                        <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-2xs font-semibold rounded-full bg-surface-muted text-fg-muted">
                          {visibleItems.length}
                        </span>
                      )}
                    </span>
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isSectionCollapsed ? '-rotate-90' : ''}`} />
                  </button>
                )
              )}
              {collapsed && <div className="my-2 mx-3 border-t border-default" />}
              {(collapsed || !isSectionCollapsed) && visibleItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href)
                  || (item.extraActivePaths?.some((p) => currentPath.startsWith(p)) ?? false);
                // An entitlement the plan doesn't include never removes the row —
                // it dims it, marks it with a padlock and says so in the
                // accessible name. The link still works: the page behind it
                // renders the FeatureLock upsell in place.
                const locked = !!navItemLockedFeature(item, navCtx);

                const linkContent = (
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`sidebar-nav-item relative ${active ? 'sidebar-nav-item-active' : 'sidebar-nav-item-default'} ${collapsed ? 'justify-center px-0 mx-1' : ''} ${locked ? 'opacity-60' : ''}`}
                  >
                    {active && (
                      <span aria-hidden className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full bg-brand" />
                    )}
                    <Icon className="w-[18px] h-[18px] flex-shrink-0" aria-hidden="true" />
                    {/* Icon-only rail: the tooltip is hover-only (and describes,
                        not names), so the link carries its title as hidden text. */}
                    <span className={collapsed ? 'sr-only' : 'flex-1'}>{item.title}</span>
                    {/* The padlock is decorative; the sr-only clause is what a
                        screen reader hears, so "locked" is never colour/icon
                        alone — in the collapsed rail too, where the label is
                        already hidden. */}
                    {locked && (
                      <>
                        <Lock className="w-3.5 h-3.5 flex-shrink-0 opacity-80" aria-hidden="true" />
                        <span className="sr-only"> — not included in your plan</span>
                      </>
                    )}
                    {!collapsed && item.title === 'Messages' && unreadCount > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-2xs font-bold text-white bg-red-500 rounded-full">
                        {unreadCount > 99 ? '99+' : unreadCount}
                        <span className="sr-only"> unread</span>
                      </span>
                    )}
                    {/* The collapsed rail's unread marker is a bare red dot — colour
                        alone says nothing to a screen reader (or to someone who
                        can't tell the red apart), so it carries the count as text. */}
                    {collapsed && item.title === 'Messages' && unreadCount > 0 && (
                      <>
                        <span aria-hidden="true" className="absolute top-0 right-0 w-2.5 h-2.5 bg-red-500 rounded-full" />
                        <span className="sr-only">{`${unreadCount > 99 ? '99+' : unreadCount} unread`}</span>
                      </>
                    )}
                  </Link>
                );

                return collapsed ? (
                  <Tooltip key={item.href} content={locked ? `${item.title} — not included in your plan` : item.title}>
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

      {/* Footer — who you are signed in as, and the two session controls.
          One row at rest: the avatar carries the identity, the icon buttons
          carry the actions, and neither needs a full-width labelled button. */}
      <div className="border-t border-default p-3">
        <div className={`flex items-center gap-2 ${collapsed ? 'flex-col' : ''}`}>
          {!collapsed && (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {/* Initials from whatever the token actually carries: `username`
                  is typed as required but arrives from a JWT, and a session
                  without one must still render a rail, not a blank page. */}
              <span
                aria-hidden
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-muted text-2xs font-semibold uppercase text-fg-muted"
              >
                {(user.username || user.email || '?').slice(0, 2)}
              </span>
              <p className="min-w-0 truncate text-sm font-medium text-fg">{user.username}</p>
            </div>
          )}
          <Tooltip content={isDark ? 'Light mode' : 'Dark mode'}>
            <button
              onClick={onToggleDark}
              className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors"
              aria-label="Toggle dark mode"
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </Tooltip>
          <Tooltip content="Log out">
            <button
              onClick={onLogout}
              className="rounded-lg p-1.5 text-fg-muted hover:bg-danger-bg hover:text-danger transition-colors"
              aria-label="Log out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </Tooltip>
          {/* Expanding from the icon-only rail: the brand row has no space for
              a control when it is 64px wide, so the toggle lives here in that
              mode only. */}
          {onToggleCollapsed && collapsed && (
            <Tooltip content="Expand sidebar">
              <button
                onClick={onToggleCollapsed}
                className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors"
                aria-label="Expand sidebar"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

    </div>
  );
}
