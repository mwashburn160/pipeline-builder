// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { TabBar, tabPanelProps } from './TabBar';

export interface GroupedTabItem<G extends string, S extends string> {
  id: G;
  label: ReactNode;
  /** Plain-text name, for the sub-tab row's accessible name ("Security sections"). */
  name: string;
  /** Visible sub-tabs. With fewer than two, no sub-tab row shows. */
  sections?: readonly { id: S; label: ReactNode }[];
}

interface GroupedTabsProps<G extends string, S extends string> {
  items: readonly GroupedTabItem<G, S>[];
  tab: G;
  section: S | null;
  onSelect: (tab: G, section?: S) => void;
  /** Id prefix for the tab/panel pairs; the sub-tab row uses `<prefix>-<tab>`. */
  idPrefix: string;
  /** Accessible name of the top-level row (e.g. "Plugin sections"). */
  ariaLabel: string;
  /** Sub-tabs shown but not selectable (e.g. locked for a missing permission). */
  disabledSectionIds?: readonly S[];
  className?: string;
  /** The active tab's (and sub-tab's) content. */
  children: ReactNode;
}

/**
 * A page's tabs in two levels: the underline {@link TabBar} for the top-level
 * tabs, and under it the active tab's sub-tabs as the `pill` bar (the same
 * stacking the Organization settings sections use). The content sits in the
 * tabpanel of the innermost level shown.
 */
export function GroupedTabs<G extends string, S extends string>({
  items, tab, section, onSelect, idPrefix, ariaLabel, disabledSectionIds, className = 'mb-4', children,
}: GroupedTabsProps<G, S>) {
  const active = items.find((item) => item.id === tab);
  const sections = active?.sections ?? [];
  const subPrefix = `${idPrefix}-${tab}`;
  const showSections = sections.length > 1 && section !== null;

  return (
    <>
      <TabBar
        items={items.map(({ id, label }) => ({ id, label }))}
        activeId={tab}
        onSelect={(id) => onSelect(id as G)}
        idPrefix={idPrefix}
        ariaLabel={ariaLabel}
        className={className}
      />
      <div {...tabPanelProps(idPrefix, tab)}>
        {showSections ? (
          <>
            <TabBar
              variant="pill"
              items={sections}
              activeId={section}
              onSelect={(id) => onSelect(tab, id as S)}
              disabledIds={disabledSectionIds}
              idPrefix={subPrefix}
              ariaLabel={`${active?.name ?? ''} sections`}
              className="mb-4"
            />
            <div {...tabPanelProps(subPrefix, section)}>{children}</div>
          </>
        ) : children}
      </div>
    </>
  );
}
