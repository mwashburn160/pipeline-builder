// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit Activity dashboard definition.
 *
 * The recent-events panel accepts URL query params for pre-filtering
 * (event, actor, digest, since, until) — the registry's `buildAuditLogLink`
 * helper targets this dashboard with those params to deep-link from a
 * RecentActionsPanel row to the matching audit event.
 */

export type PanelKind = 'stackedbar' | 'table-logs' | 'table-topk';

export interface AuditActivityPanel {
  id: string;
  kind: PanelKind;
  title: string;
  queryKey: string;
  span: 3 | 4 | 6 | 8 | 9 | 12;
  /** For stackedbar/topk: the label key driving grouping. */
  groupBy?: string;
  /** For table-logs: pass URL params through to the catalog query. */
  acceptUrlFilters?: boolean;
}

export const AUDIT_ACTIVITY_DASHBOARD: { id: string; title: string; panels: AuditActivityPanel[] } = {
  id: 'audit-activity',
  title: 'Audit Activity',
  panels: [
    {
      id: 'events-by-hour',
      kind: 'stackedbar',
      title: 'Audit events per hour by event',
      queryKey: 'audit_events_per_hour_by_event',
      span: 12,
      groupBy: 'event',
    },
    {
      id: 'top-actors',
      kind: 'table-topk',
      title: 'Top actors (24h)',
      queryKey: 'audit_top_actors_24h',
      span: 6,
      groupBy: 'actor',
    },
    {
      id: 'recent-events',
      kind: 'table-logs',
      title: 'Recent events',
      queryKey: 'audit_recent_events',
      span: 6,
      acceptUrlFilters: true,
    },
  ],
};
