// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Build a deep-link into the native Audit Activity dashboard for a
 * specific registry mutation (copy / delete). Used by RecentActionsPanel
 * so the operator can verify the audit event landed without leaving
 * Pipeline Builder.
 *
 * Previously this targeted Grafana Explore (`/grafana/explore?...`); that
 * surface is removed in this PR. The native dashboard reads the same
 * query params on mount and pre-filters its recent-events table.
 */

const TIME_WINDOW_MS = 5 * 60_000; // 5 minutes either side of the event

interface CopyAuditLink {
  kind: 'copy';
  /** ISO timestamp when the copy occurred. */
  at: string;
  digest?: string;
  source?: string;
  target?: string;
}

interface DeleteAuditLink {
  kind: 'delete';
  at: string;
  digest?: string;
  repo?: string;
  ref?: string;
}

export type AuditLinkSpec = CopyAuditLink | DeleteAuditLink;

/**
 * Build a `/dashboard/observability/audit-activity?...` URL pre-filtered
 * to the given event. Returns null when the spec is missing the timestamp
 * we need to compute the time window (caller should hide the link in that
 * case — RecentActionsPanel already guards on this).
 */
export function buildAuditLogLink(spec: AuditLinkSpec): string | null {
  if (!spec.at) return null;

  const event = spec.kind === 'copy' ? 'registry.tag.copy' : 'registry.tag.delete';
  const eventTime = new Date(spec.at).getTime();
  const since = new Date(eventTime - TIME_WINDOW_MS).toISOString();
  const until = new Date(eventTime + TIME_WINDOW_MS).toISOString();

  const params = new URLSearchParams();
  params.set('event', event);
  // `since` / `until` are read by the page and used to constrain the
  // server-side query. Digest is sent through but the recent-events panel
  // doesn't currently filter on it (audit_recent_events catalog entry
  // doesn't expose digest as a templated var — kept here for forward-compat
  // when a digest-based filter is added).
  params.set('since', since);
  params.set('until', until);
  if (spec.digest) params.set('digest', spec.digest);

  return `/dashboard/observability/audit-activity?${params.toString()}`;
}
