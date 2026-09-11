// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Build a deep-link into the native Audit Activity dashboard for a registry
 * mutation (copy / delete). Used by RecentActionsPanel so the operator can
 * verify the audit event landed without leaving Pipeline Builder.
 *
 * The dashboard reads the MongoDB audit trail, where image-registry records
 * these mutations as `registry.image.*`; the recent-events panel filters on
 * `event` (exact action). The panel's default 1h range covers the
 * this-session actions RecentActionsPanel lists.
 */
export function buildAuditLogLink(kind: 'copy' | 'delete'): string {
  const event = kind === 'copy' ? 'registry.image.copy' : 'registry.image.delete';
  return `/dashboard/observability/audit-activity?${new URLSearchParams({ event }).toString()}`;
}
