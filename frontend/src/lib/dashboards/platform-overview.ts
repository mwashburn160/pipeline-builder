// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform Overview dashboard — the landing dashboard for operators.
 *
 * Combines platform-service metrics (org/user counts, login activity) with
 * plugin-service metrics already shipped (build success rate, queue depth)
 * to give a single-pane health check.
 */

export type PanelKind = 'stat' | 'line';

export interface PlatformOverviewPanel {
  id: string;
  kind: PanelKind;
  title: string;
  queryKey: string;
  span: 3 | 4 | 6 | 8 | 9 | 12;
  groupBy?: string;
  format?: 'percent' | 'seconds';
}

export const PLATFORM_OVERVIEW_DASHBOARD: { id: string; title: string; panels: PlatformOverviewPanel[] } = {
  id: 'platform-overview',
  title: 'Platform Overview',
  panels: [
    // Top row — four stat tiles
    { id: 'orgs', kind: 'stat', title: 'Organizations', queryKey: 'platform_orgs_total', span: 3 },
    { id: 'users', kind: 'stat', title: 'Users', queryKey: 'platform_users_total', span: 3 },
    { id: 'memberships', kind: 'stat', title: 'Active memberships', queryKey: 'platform_memberships_active_total', span: 3 },
    { id: 'logins-24h', kind: 'stat', title: 'Logins (24h)', queryKey: 'platform_logins_24h', span: 3 },

    // Activity trends
    { id: 'logins-per-min', kind: 'line', title: 'Logins per minute', queryKey: 'platform_logins_per_min', span: 6 },
    { id: 'builds-per-min', kind: 'line', title: 'Plugin builds per minute', queryKey: 'plugin_builds_per_min', span: 6, groupBy: 'status' },

    // Health
    { id: 'success-rate', kind: 'line', title: 'Build success rate (5m)', queryKey: 'plugin_build_success_rate_5m', span: 6, format: 'percent' },
    { id: 'queue-depth', kind: 'line', title: 'Build queue depth', queryKey: 'plugin_queue_depth', span: 6, groupBy: 'state' },
  ],
};
