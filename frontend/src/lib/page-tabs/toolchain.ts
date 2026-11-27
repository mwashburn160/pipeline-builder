// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The Toolchain console's tabs (`/dashboard/toolchain`): the three per-release views share Rollout. */

import { resolveTabLocation, type GroupedTabsConfig, type TabLocation } from './grouped';

export type ToolchainTab = 'releases' | 'rollout' | 'history' | 'cleanup';
export type ToolchainSection = 'canary' | 'adoption' | 'affected';

export const TOOLCHAIN_TABS: GroupedTabsConfig<ToolchainTab, ToolchainSection> = {
  groups: {
    releases: [],
    rollout: ['canary', 'adoption', 'affected'],
    history: [],
    cleanup: [],
  },
  defaultTab: 'releases',
};

/** Where a Toolchain `?tab=` and `?section=` land. */
export function resolveToolchainTab(tab: string | undefined, section: string | undefined): TabLocation<ToolchainTab, ToolchainSection> {
  return resolveTabLocation(TOOLCHAIN_TABS, tab, section);
}
