// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabBarItem {
  id: string;
  label: ReactNode;
  /** When set, the tab renders as a router `<Link>` (navigation tabs). When
   *  absent, it renders as a `<button>` that calls `onSelect` (in-page state tabs). */
  href?: string;
}

interface TabBarProps {
  items: readonly TabBarItem[];
  activeId: string;
  /** Called for non-`href` (button) tabs. Ignored for link tabs. */
  onSelect?: (id: string) => void;
  /** Ids of tabs that are non-interactive (e.g. locked mid-operation). Rendered
   *  dimmed; clicks/navigation are suppressed. */
  disabledIds?: readonly string[];
  className?: string;
  /**
   * Prefix for the tab/panel id pair. When set, each state tab gets
   * `id="<prefix>-tab-<id>"` and `aria-controls="<prefix>-panel-<id>"`, so a
   * screen reader can jump from the tab to the content it shows. Put
   * {@link tabPanelProps}(prefix, activeId) on the panel element to complete the
   * pair. Without it the tabs still work; they just can't point at a panel.
   */
  idPrefix?: string;
  /** Accessible name for the tab list (e.g. "Report sections"). */
  ariaLabel?: string;
}

/** DOM id of a state tab, for a given {@link TabBarProps.idPrefix}. */
export function tabId(idPrefix: string, id: string): string {
  return `${idPrefix}-tab-${id}`;
}

/** DOM id of the panel a state tab controls. */
function tabPanelId(idPrefix: string, id: string): string {
  return `${idPrefix}-panel-${id}`;
}

/**
 * Props for the element holding the active tab's content, so it becomes the
 * `tabpanel` the tab's `aria-controls` names: `<div {...tabPanelProps('settings', tab)}>`.
 */
export function tabPanelProps(idPrefix: string, activeId: string) {
  return {
    role: 'tabpanel' as const,
    id: tabPanelId(idPrefix, activeId),
    'aria-labelledby': tabId(idPrefix, activeId),
    tabIndex: 0,
  };
}

/**
 * Single underline tab-bar primitive shared by both interaction models:
 *  - state tabs (buttons + `onSelect`) — e.g. Reports/Billing sub-tabs. These
 *    follow the WAI-ARIA tabs pattern: a `tablist` of `tab`s with
 *    `aria-selected`, ONE tab stop (roving `tabIndex`), and Left/Right/Home/End
 *    to move between tabs. Moving selects (automatic activation) — every panel
 *    here renders from state already on the page.
 *  - navigation tabs (router links via `href`) — e.g. the Builds queue/triage
 *    tabs. These are a `nav` of links, not a tablist: each goes to a different
 *    page, so the current one is `aria-current="page"` and Tab walks them.
 *    One `href` makes the whole bar a nav; don't mix the two in one bar.
 * Replaces the two near-duplicate bars (`ReportTabs`, `BuildsTabs`), which now
 * delegate here so the markup lives in one place.
 */
export function TabBar({ items, activeId, onSelect, disabledIds, className = '', idPrefix, ariaLabel }: TabBarProps) {
  const isNav = items.some((item) => item.href);
  const generatedPrefix = useId();
  const prefix = idPrefix ?? generatedPrefix;
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const isDisabled = (id: string) => disabledIds?.includes(id) ?? false;
  const enabled = items.filter((item) => !isDisabled(item.id));
  // The single tab stop: the selected tab, or the first usable one if the
  // selection isn't among the items (so the list is never unreachable).
  const tabStopId = enabled.some((item) => item.id === activeId) ? activeId : enabled[0]?.id;

  const classFor = (active: boolean, disabled: boolean) =>
    // Same missing-focus-ring problem as IconButton: tabs were keyboard
    // reachable but gave no visible focus. `rounded-sm` keeps the ring
    // tight to the label without disturbing the underline.
    `py-2.5 px-1 border-b-2 font-medium text-sm transition-colors rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${
      active
        ? 'border-blue-500 text-blue-600 dark:text-blue-400'
        : 'border-transparent text-fg-muted hover:text-fg hover:border-gray-300 dark:hover:border-gray-600'
    }${disabled ? ' opacity-50 cursor-not-allowed' : ''}`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (enabled.length === 0) return;
    const current = enabled.findIndex((item) => item.id === (e.target as HTMLElement).dataset.tabId);
    let next: number;
    switch (e.key) {
      case 'ArrowRight': next = current < 0 ? 0 : (current + 1) % enabled.length; break;
      case 'ArrowLeft': next = current < 0 ? enabled.length - 1 : (current - 1 + enabled.length) % enabled.length; break;
      case 'Home': next = 0; break;
      case 'End': next = enabled.length - 1; break;
      default: return;
    }
    e.preventDefault();
    const target = enabled[next];
    tabRefs.current.get(target.id)?.focus();
    if (target.id !== activeId) onSelect?.(target.id);
  };

  if (isNav) {
    return (
      <div className={`border-b border-gray-200 dark:border-gray-700 mb-6 ${className}`}>
        <nav className="-mb-px flex space-x-6" aria-label={ariaLabel}>
          {items.map((item) => {
            const active = item.id === activeId;
            const disabled = isDisabled(item.id);
            const cls = classFor(active, disabled);
            // A disabled link would still navigate, so render it as an inert span.
            if (!item.href || disabled) {
              return <span key={item.id} aria-disabled="true" className={cls}>{item.label}</span>;
            }
            return (
              <Link key={item.id} href={item.href} aria-current={active ? 'page' : undefined} className={cls}>
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    );
  }

  return (
    <div className={`border-b border-gray-200 dark:border-gray-700 mb-6 ${className}`}>
      <div role="tablist" aria-label={ariaLabel} aria-orientation="horizontal" className="-mb-px flex space-x-6" onKeyDown={onKeyDown}>
        {items.map((item) => {
          const active = item.id === activeId;
          const disabled = isDisabled(item.id);
          return (
            <button
              key={item.id}
              ref={(el) => {
                if (el) tabRefs.current.set(item.id, el);
                else tabRefs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={tabId(prefix, item.id)}
              aria-selected={active}
              aria-controls={idPrefix ? tabPanelId(idPrefix, item.id) : undefined}
              tabIndex={item.id === tabStopId ? 0 : -1}
              data-tab-id={item.id}
              disabled={disabled}
              onClick={() => onSelect?.(item.id)}
              className={classFor(active, disabled)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
