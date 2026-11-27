// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The Ecosystem console's tabs (`/dashboard/admin/ecosystem`): its eleven panels in five tabs. */

import { resolveTabLocation, type GroupedTabsConfig, type TabLocation } from './grouped';

export type EcosystemTab = 'publishing' | 'listings' | 'security' | 'storage' | 'managers';
export type EcosystemSection = 'queue' | 'publishers' | 'rules' | 'listings' | 'reviews' | 'reserved'
  | 'advisories' | 'vulnerabilities' | 'kept-images' | 'retention';

export const ECOSYSTEM_TABS: GroupedTabsConfig<EcosystemTab, EcosystemSection> = {
  groups: {
    publishing: ['queue', 'publishers', 'rules'],
    listings: ['listings', 'reviews', 'reserved'],
    security: ['advisories', 'vulnerabilities'],
    storage: ['kept-images', 'retention'],
    managers: [],
  },
  defaultTab: 'publishing',
};

/** Where an Ecosystem `?tab=` and `?section=` land. */
export function resolveEcosystemTab(tab: string | undefined, section: string | undefined): TabLocation<EcosystemTab, EcosystemSection> {
  return resolveTabLocation(ECOSYSTEM_TABS, tab, section);
}
