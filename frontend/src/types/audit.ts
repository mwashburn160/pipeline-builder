// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared shape for a persisted audit-log event as returned by the platform
 * `/api/audit` surface.
 *
 * This is the single source of truth for the audit-event row across the
 * frontend — the audit page, the sysadmin home feed, the grant-history
 * timeline, and the `listAuditEvents` API return all consume it. Consumers
 * that only read a subset of columns simply ignore the fields they don't use;
 * every field beyond the always-present `_id`/`action`/`actorId`/`createdAt`
 * is therefore optional so a narrower consumer stays satisfied.
 *
 * NOTE: intentionally named `AuditLogEvent` (not `AuditEvent`) to avoid
 * colliding with api-core's unrelated registry-correlation `AuditEvent`.
 */
export interface AuditLogEvent {
  _id: string;
  action: string;
  actorId: string;
  actorEmail?: string;
  actorRole?: string;
  orgId?: string;
  affectedOrgId?: string;
  targetType?: string;
  targetId?: string;
  groupId?: string;
  impersonatorId?: string;
  outcome?: 'success' | 'failure';
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  traceId?: string;
  createdAt: string;
}

/** Result of a hash-chain tamper-verify (`GET /api/audit/verify`). */
export interface AuditChainVerification {
  /** True iff the chain hashed cleanly end-to-end. */
  ok: boolean;
  /** Event id where the chain first broke (present only when `ok` is false). */
  brokenAt?: string;
  /** Number of events walked while verifying. */
  count: number;
}
