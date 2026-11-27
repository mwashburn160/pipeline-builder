// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Reports page's tabs (`/dashboard/reports`): Overview, Delivery, Quality,
 * Security and Stakeholder, holding the ten reports by topic. A sub-tab id is
 * the report's id, so the report components keep their names.
 */

import { resolveTabLocation, type GroupedTabsConfig, type TabLocation } from './grouped';

export type ReportsTab = 'overview' | 'delivery' | 'quality' | 'security' | 'stakeholder';
/** One report. `security` and `stakeholder` are whole tabs, with no sub-tabs. */
export type ReportId = 'pipelines' | 'plugins' | 'teams' | 'dora' | 'delivery' | 'flow' | 'scorecard' | 'insights'
  | 'security' | 'stakeholder';
export type ReportsSection = Exclude<ReportId, 'security' | 'stakeholder'>;

export const REPORTS_TABS: GroupedTabsConfig<ReportsTab, ReportsSection> = {
  groups: {
    overview: ['pipelines', 'plugins', 'teams'],
    // `delivery` first: the tab opens on the runner-reliability report.
    delivery: ['delivery', 'dora', 'flow'],
    quality: ['scorecard', 'insights'],
    security: [],
    stakeholder: [],
  },
  defaultTab: 'overview',
};

/** Where a Reports `?tab=` and `?section=` land. */
export function resolveReportsTab(tab: string | undefined, section: string | undefined): TabLocation<ReportsTab, ReportsSection> {
  return resolveTabLocation(REPORTS_TABS, tab, section);
}

/** The report a settled location shows. */
export function reportAt(location: TabLocation<ReportsTab, ReportsSection>): ReportId {
  if (location.tab === 'security' || location.tab === 'stakeholder') return location.tab;
  return location.section ?? REPORTS_TABS.groups[location.tab][0];
}
