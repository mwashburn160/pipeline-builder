// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin Builds dashboard definition.
 *
 * Panel definitions are code-local for v1 (see plan's Non-goals: no DB-stored
 * dashboards, no layout editor). To add a panel: append to `panels`.
 * `span` values sum across each row in the 12-col grid; the page lays them
 * out in the order they appear here.
 */

export type PanelKind = 'stat' | 'line';

export interface PluginBuildsPanel {
  id: string;
  kind: PanelKind;
  title: string;
  queryKey: string;
  span: 3 | 4 | 6 | 8 | 9 | 12;
  /** Optional label key for line panel grouping (status, state, etc.). */
  groupBy?: string;
  /** Optional value formatter ('percent' or 'seconds'); default raw number. */
  format?: 'percent' | 'seconds';
}

export const PLUGIN_BUILDS_DASHBOARD: { id: string; title: string; panels: PluginBuildsPanel[] } = {
  id: 'plugin-builds',
  title: 'Plugin Builds',
  panels: [
    // Top row: a stat + three lines
    {
      id: 'builds-24h',
      kind: 'stat',
      title: 'Builds (24h)',
      queryKey: 'plugin_builds_total_24h',
      span: 3,
    },
    {
      id: 'builds-per-min',
      kind: 'line',
      title: 'Builds per minute',
      queryKey: 'plugin_builds_per_min',
      span: 9,
      groupBy: 'status',
    },
    // Middle row: success rate + p95 duration
    {
      id: 'success-rate',
      kind: 'line',
      title: 'Build success rate (5m window)',
      queryKey: 'plugin_build_success_rate_5m',
      span: 6,
      format: 'percent',
    },
    {
      id: 'p95-duration',
      kind: 'line',
      title: 'Build duration p95',
      queryKey: 'plugin_build_p95_duration_sec',
      span: 6,
      format: 'seconds',
    },
    // Bottom: queue depth full-width with state stacking
    {
      id: 'queue-depth',
      kind: 'line',
      title: 'BullMQ queue depth',
      queryKey: 'plugin_queue_depth',
      span: 12,
      groupBy: 'state',
    },
  ],
};
