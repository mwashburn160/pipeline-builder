// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Grouped audit-log quick filters ("Ecosystem", "Moderation", "Remediation").
 *
 * A group is sent to `GET /audit` as one `actions=` list — each entry a prefix
 * (ends with `.`) or an exact action, matched anchored on the server
 * (`buildAuditQuery` in platform's audit-service) — so a group is ONE query
 * with the server's own pagination and total.
 */

export type AuditQuickFilterKey = 'ecosystem' | 'moderation' | 'remediation';

export interface AuditQuickFilter {
  key: AuditQuickFilterKey;
  label: string;
  title: string;
  /** `foo.` = prefix match; anything else = exact action. */
  patterns: readonly string[];
}

/** The group definitions — the single source of truth. */
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
  remediation: {
    key: 'remediation',
    label: 'Remediation',
    title: 'Nightly plugin CVE fixes (started, published, approved, rejected, rolled back), their settings, pipeline elections, and whole-plugin delete / restore / purge',
    patterns: [
      'plugin.remediation.',
      'plugin.remediation_level.update',
      'plugin.remediation_settings.update',
      'pipeline.remediation-upgrades.update',
      'plugin.delete-all',
      'plugin.restore-all',
      'plugin.purge-all',
    ],
  },
};

export function isAuditQuickFilterKey(v: string | undefined): v is AuditQuickFilterKey {
  return v === 'ecosystem' || v === 'moderation' || v === 'remediation';
}

/** The `actions` query value for a group. */
export function auditQuickFilterActions(key: AuditQuickFilterKey): string {
  return AUDIT_QUICK_FILTERS[key].patterns.join(',');
}
