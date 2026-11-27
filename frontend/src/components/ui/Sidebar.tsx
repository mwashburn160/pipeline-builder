import { useState, useEffect, useMemo } from 'react';
import type { Permission } from '@pipeline-builder/api-core/permissions';
import Link from 'next/link';
import {
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
import { SIDEBAR_SECTIONS, QUICK_ACTIONS, activeNavItem, groupNavItems, isNavItemVisible, navItemLockedFeature, type NavItem } from '@/lib/nav';
import { isSystemOrgActive } from '@/lib/ecosystem-access';
import { Tooltip } from './Tooltip';

/** localStorage key for which nav sections and sub-groups the user has collapsed. */
const NAV_SECTIONS_KEY = 'pb-nav-collapsed-sections:v1';

/** Collapse-state key of a sub-group (a section's own key is its label). */
const groupKey = (section: string, group?: string): string => (group ? `${section}/${group}` : section);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SidebarProps {
  isSuperAdmin: boolean;
  isAdmin: boolean;
  user: User;
  unreadCount: number;
  /** The current URL, query included (`router.asPath`): a row may name one tab
   *  of a page (`/dashboard/settings?tab=organization`). */
  currentPath: string;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function Sidebar({
  isSuperAdmin,
  isAdmin,
  user,
  unreadCount,
  currentPath,
  collapsed = false,
  onToggleCollapsed,
}: SidebarProps) {
  const billingEnabled = useBillingEnabled();
  const { isEnabled: isFeatureEnabled } = useFeatures();
  const { isReadOnly } = useAuth();
  // A quick action is available only if permitted AND not a write blocked by a
  // read-only impersonation session (matches nav.ts's documented `can()` intent).
  const quickActionAllowed = (perm?: Permission) =>
    !perm || (hasPermission(user, perm) && !(isReadOnly && isMutationPermission(perm)));

  const navCtx = { isAdmin, isSuperAdmin, hasPermission: (p: Permission) => hasPermission(user, p), billingEnabled, isFeatureEnabled, isSystemOrg: isSystemOrgActive(user) };

  // `paletteOnly` entries are sub-pages of a listed item: ⌘K finds them by
  // name, the sidebar leaves them to their parent's row.
  const isItemVisible = (item: NavItem) => !item.paletteOnly && isNavItemVisible(item, navCtx);
  const sections = SIDEBAR_SECTIONS
    .map((section) => ({ section, items: section.items.filter(isItemVisible) }))
    .filter(({ items }) => items.length > 0);

  // ONE active row: the most specific match among the rows actually rendered,
  // so a tab row (Plugin retention) wins over its page (Ecosystem).
  const active = activeNavItem(sections.flatMap(({ items }) => items), currentPath);
  const activeSection = sections.find(({ items }) => active && items.includes(active))?.section.label;
  const activeKey = active && activeSection ? groupKey(activeSection, active.group) : undefined;

  // Collapsible sections and sub-groups (persisted to localStorage). With six
  // sections the rail gets long for admins; users hide groups they don't use.
  // Ignored in the icon-only (sidebar-collapsed) mode, where items render as
  // icon rows. A section or group holding the current page is opened on
  // arrival, so the highlighted row is never hidden.
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    let stored: string[] = [];
    try {
      const raw = localStorage.getItem(NAV_SECTIONS_KEY);
      if (raw) stored = JSON.parse(raw) as string[];
    } catch { /* ignore unavailable/corrupt storage */ }
    setCollapsedKeys(new Set(stored));
  }, []);
  const revealKeys = useMemo(
    () => (activeSection ? [activeSection, ...(activeKey ? [activeKey] : [])] : []),
    [activeSection, activeKey],
  );
  useEffect(() => {
    setCollapsedKeys((prev) => {
      if (!revealKeys.some((k) => prev.has(k))) return prev;
      const next = new Set(prev);
      for (const k of revealKeys) next.delete(k);
      return next;
    });
  }, [revealKeys]);
  const toggleKey = (key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem(NAV_SECTIONS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const isActive = item === active;
    // An entitlement the plan doesn't include never removes the row —
    // it dims it, marks it with a padlock and says so in the
    // accessible name. The link still works: the page behind it
    // renders the FeatureLock upsell in place.
    const locked = !!navItemLockedFeature(item, navCtx);
    const unread = item.showsUnreadCount && unreadCount > 0 ? (unreadCount > 99 ? '99+' : String(unreadCount)) : null;

    const linkContent = (
      <Link
        href={item.href}
        aria-current={isActive ? 'page' : undefined}
        className={`sidebar-nav-item relative ${isActive ? 'sidebar-nav-item-active' : 'sidebar-nav-item-default'} ${collapsed ? 'justify-center px-0 mx-1' : ''} ${locked ? 'opacity-60' : ''}`}
      >
        {isActive && (
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
        {!collapsed && unread && (
          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-2xs font-bold text-white bg-red-500 rounded-full">
            {unread}
            <span className="sr-only"> unread</span>
          </span>
        )}
        {/* The collapsed rail's unread marker is a bare red dot — colour
            alone says nothing to a screen reader (or to someone who
            can't tell the red apart), so it carries the count as text. */}
        {collapsed && unread && (
          <>
            <span aria-hidden="true" className="absolute top-0 right-0 w-2.5 h-2.5 bg-red-500 rounded-full" />
            <span className="sr-only">{`${unread} unread`}</span>
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
  };

  /** A section's rows, under sub-group headings when it declares groups. */
  const renderGroups = (sectionLabel: string, items: NavItem[]) =>
    groupNavItems(items).map(({ group, items: groupItems }) => {
      if (!group) return groupItems.map(renderItem);
      const key = groupKey(sectionLabel, group);
      const isGroupCollapsed = collapsedKeys.has(key);
      return (
        <div key={key}>
          <button
            type="button"
            onClick={() => toggleKey(key)}
            aria-expanded={!isGroupCollapsed}
            className="w-full flex items-center justify-between sidebar-subgroup-label hover:text-fg transition-colors"
          >
            <span className="flex items-center gap-1.5">
              {group}
              {isGroupCollapsed && (
                <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-2xs font-semibold rounded-full bg-surface-muted text-fg-muted">
                  {groupItems.length}
                </span>
              )}
            </span>
            <ChevronDown aria-hidden="true" className={`w-3 h-3 transition-transform ${isGroupCollapsed ? '-rotate-90' : ''}`} />
          </button>
          {!isGroupCollapsed && groupItems.map(renderItem)}
        </div>
      );
    });

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
        {sections.map(({ section, items }) => {
          // `alwaysExpanded` sections ignore persisted collapse state and render
          // without a toggle, so navigation can't be hidden by a stale setting.
          const isSectionCollapsed = !section.alwaysExpanded && collapsedKeys.has(section.label);

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
                    onClick={() => toggleKey(section.label)}
                    aria-expanded={!isSectionCollapsed}
                    className="w-full flex items-center justify-between sidebar-section-label hover:text-fg transition-colors"
                  >
                    <span className="flex items-center gap-1.5">
                      {section.label}
                      {/* Count of hidden items so a collapsed section reads as
                          "collapsed", not "empty/missing". */}
                      {isSectionCollapsed && (
                        <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-2xs font-semibold rounded-full bg-surface-muted text-fg-muted">
                          {items.length}
                        </span>
                      )}
                    </span>
                    <ChevronDown aria-hidden="true" className={`w-3.5 h-3.5 transition-transform ${isSectionCollapsed ? '-rotate-90' : ''}`} />
                  </button>
                )
              )}
              {collapsed && <div className="my-2 mx-3 border-t border-default" />}
              {/* The icon-only rail has no room for sub-group headings. */}
              {collapsed ? items.map(renderItem) : !isSectionCollapsed && renderGroups(section.label, items)}
            </div>
          );
        })}
      </nav>

      {/* Expanding from the icon-only rail: the brand row has no space for a
          control when it is 64px wide, so the toggle lives here in that mode
          only. Who you are, the theme and sign-out live in the top bar's
          avatar menu. */}
      {onToggleCollapsed && collapsed && (
        <div className="border-t border-default p-3 flex justify-center">
          <Tooltip content="Expand sidebar">
            <button
              onClick={onToggleCollapsed}
              className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors"
              aria-label="Expand sidebar"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
