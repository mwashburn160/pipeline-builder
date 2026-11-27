// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The Publisher page's tabs (`/dashboard/publisher`): Profile, Listings, Requests and Security. */

import { resolveTabLocation, type GroupedTabsConfig, type TabLocation } from './grouped';

export type PublisherTab = 'profile' | 'listings' | 'requests' | 'security';
export type PublisherSection = 'listings' | 'insights' | 'requests' | 'publish' | 'advisories' | 'fixes';

export const PUBLISHER_TABS: GroupedTabsConfig<PublisherTab, PublisherSection> = {
  groups: {
    profile: [],
    listings: ['listings', 'insights'],
    requests: ['requests', 'publish'],
    security: ['advisories', 'fixes'],
  },
  defaultTab: 'profile',
};

/** Where a Publisher `?tab=` and `?section=` land. */
export function resolvePublisherTab(tab: string | undefined, section: string | undefined): TabLocation<PublisherTab, PublisherSection> {
  return resolveTabLocation(PUBLISHER_TABS, tab, section);
}
