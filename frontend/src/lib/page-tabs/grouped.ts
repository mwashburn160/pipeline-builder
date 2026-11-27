// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Two-level page tabs: at most five top-level tabs (`?tab=`), each optionally
 * holding sub-tabs (`?section=`), e.g. `/dashboard/plugins?tab=security&section=remediations`.
 */

/** Where a page's tabs point: the top-level tab and, when it has them, the sub-tab. */
export interface TabLocation<G extends string, S extends string> {
  tab: G;
  /** `null` = the tab's first (visible) sub-tab, or a tab without sub-tabs. */
  section: S | null;
}

export interface GroupedTabsConfig<G extends string, S extends string> {
  /** Top-level tab ids → their sub-tab ids, in display order (empty: no sub-tabs). */
  groups: Readonly<Record<G, readonly S[]>>;
  /** The landing tab when the URL names none (or nothing known). */
  defaultTab: G;
}

/** Query key of the sub-tab. One name across every grouped page. */
export const SECTION_KEY = 'section';

const has = <K extends string>(record: Readonly<Record<K, unknown>>, key: string): key is K =>
  Object.prototype.hasOwnProperty.call(record, key);

/**
 * The location a `?tab=` / `?section=` pair names. Anything but a tab id is the
 * default tab, and a section the tab does not hold is its first sub-tab.
 */
export function resolveTabLocation<G extends string, S extends string>(
  config: GroupedTabsConfig<G, S>,
  rawTab: string | undefined,
  rawSection: string | undefined,
): TabLocation<G, S> {
  if (rawTab && has(config.groups, rawTab)) {
    const sections = config.groups[rawTab] as readonly string[];
    return { tab: rawTab, section: rawSection && sections.includes(rawSection) ? (rawSection as S) : null };
  }
  return { tab: config.defaultTab, section: null };
}

/** Which tabs and sub-tabs the viewer may open. Omitted = all of them. */
export interface TabVisibility<G extends string, S extends string> {
  tabs?: readonly G[];
  sections?: (tab: G) => readonly S[];
}

/**
 * Narrow a location to what the viewer may see: a hidden tab falls to the first
 * visible one, and a hidden or unnamed sub-tab to the tab's first visible one.
 */
export function settleTabLocation<G extends string, S extends string>(
  config: GroupedTabsConfig<G, S>,
  location: TabLocation<G, S>,
  visibility: TabVisibility<G, S> = {},
): TabLocation<G, S> {
  const tabs = visibility.tabs ?? (Object.keys(config.groups) as G[]);
  const tab = tabs.includes(location.tab) ? location.tab : (tabs[0] ?? config.defaultTab);
  const sections = visibility.sections ? visibility.sections(tab) : config.groups[tab];
  const keep = tab === location.tab && location.section && sections.includes(location.section);
  return { tab, section: keep ? location.section : (sections[0] ?? null) };
}

/** The canonical query for a location: `{ tab, section }`, without `section` for a tab that has none. */
export function tabQuery<G extends string, S extends string>(location: TabLocation<G, S>): Record<string, string> {
  return location.section ? { tab: location.tab, [SECTION_KEY]: location.section } : { tab: location.tab };
}
