// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import type { ReactNode } from 'react';

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
  className?: string;
}

/**
 * Single underline tab-bar primitive shared by both interaction models:
 *  - state tabs (buttons + `onSelect`) — e.g. Reports/Billing sub-tabs
 *  - navigation tabs (router links via `href`) — e.g. the Builds queue/triage tabs
 * Replaces the two near-duplicate bars (`ReportTabs`, `BuildsTabs`), which now
 * delegate here so the markup lives in one place.
 */
export function TabBar({ items, activeId, onSelect, className = '' }: TabBarProps) {
  return (
    <div className={`border-b border-gray-200 dark:border-gray-700 mb-6 ${className}`}>
      <nav className="-mb-px flex space-x-6">
        {items.map((item) => {
          const active = item.id === activeId;
          const cls = `py-2.5 px-1 border-b-2 font-medium text-sm transition-colors ${
            active
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
          }`;
          return item.href ? (
            <Link key={item.id} href={item.href} aria-current={active ? 'page' : undefined} className={cls}>
              {item.label}
            </Link>
          ) : (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect?.(item.id)}
              aria-current={active ? 'page' : undefined}
              className={cls}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
