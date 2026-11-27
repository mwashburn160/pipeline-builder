// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The Plugins page's tabs (`/dashboard/plugins`): five tabs, Security holding four sub-tabs. */

import { resolveTabLocation, type GroupedTabsConfig, type TabLocation } from './grouped';

export type PluginsTab = 'mine' | 'catalog' | 'installs' | 'security' | 'builds';
export type PluginsSection = 'vulnerabilities' | 'remediations' | 'policy' | 'approvals';

export const PLUGINS_TABS: GroupedTabsConfig<PluginsTab, PluginsSection> = {
  groups: {
    mine: [],
    catalog: [],
    installs: [],
    security: ['vulnerabilities', 'remediations', 'policy', 'approvals'],
    builds: [],
  },
  defaultTab: 'mine',
};

/** Where a Plugins `?tab=` and `?section=` land. */
export function resolvePluginsTab(tab: string | undefined, section: string | undefined): TabLocation<PluginsTab, PluginsSection> {
  return resolveTabLocation(PLUGINS_TABS, tab, section);
}
