// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Grouped audit-log quick filters ("Ecosystem", "Moderation").
 *
 * A group is sent to `GET /audit` as one `actions=` list — each entry a prefix
 * (ends with `.`) or an exact action, matched anchored on the server
 * (`buildAuditQuery` in platform's audit-service) — so a group is ONE query
 * with the server's own pagination and total.
 */

export type AuditQuickFilterKey = 'ecosystem' | 'moderation';

export interface AuditQuickFilter {
  key: AuditQuickFilterKey;
  label: string;
  title: string;
  /** `foo.` = prefix match; anything else = exact action. */
  patterns: readonly string[];
}

/** The group definitions — the single source of truth (plan §5c "UI"). */
export const AUDIT_QUICK_FILTERS: Readonly<Record<AuditQuickFilterKey, AuditQuickFilter>> = {
  ecosystem: {
    key: 'ecosystem',
    label: 'Ecosystem',
    title: 'Publishers, listings, publish requests, installs and install policy',
    patterns: [
      'publisher.',
      'plugin.listing.',
      'plugin.request.',
      'plugin.install.',
      'org.plugin-install-policy.update',
    ],
  },
  moderation: {
    key: 'moderation',
    label: 'Moderation',
    title: 'System-org ecosystem decisions: submissions, request decisions, review moderation, publisher suspension/verification, ecosystem config',
    patterns: [
      'plugin.submission.',
      'plugin.request.approve',
      'plugin.request.reject',
      'plugin.request.auto-approve',
      'plugin.request.second-approve',
      'plugin.review.hold',
      'plugin.review.release',
      'plugin.review.remove',
      'publisher.suspend',
      'publisher.unsuspend',
      'publisher.verify.',
      'ecosystem.',
    ],
  },
};

export function isAuditQuickFilterKey(v: string | undefined): v is AuditQuickFilterKey {
  return v === 'ecosystem' || v === 'moderation';
}

function matchesPattern(action: string, pattern: string): boolean {
  return pattern.endsWith('.') ? action.startsWith(pattern) : action === pattern;
}

/** Whether `action` belongs to the group (prefix/exact semantics). */
export function matchesAuditQuickFilter(action: string, key: AuditQuickFilterKey): boolean {
  return AUDIT_QUICK_FILTERS[key].patterns.some((p) => matchesPattern(action, p));
}

/** The `actions` query value for a group. */
export function auditQuickFilterActions(key: AuditQuickFilterKey): string {
  return AUDIT_QUICK_FILTERS[key].patterns.join(',');
}
