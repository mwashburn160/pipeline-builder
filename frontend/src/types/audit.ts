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
  /** Permission Role the action touched (`org.role.*`), promoted out of
   *  `details` so reviewers can filter "who touched role X". */
  roleId?: string;
  impersonatorId?: string;
  outcome?: 'success' | 'failure';
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  traceId?: string;
  createdAt: string;
}

/** Why a chain verification failed (mirrors platform's `AuditChainBreak`). */
export type AuditChainBreak =
  | 'hash-mismatch'
  | 'broken-link'
  | 'sequence-gap'
  | 'head-mismatch'
  | 'tail-truncated'
  | 'published-head-invalid';

/** Result of a hash-chain tamper-verify (`GET /api/audit/verify`). */
export interface AuditChainVerification {
  /** True iff the chain hashed cleanly end-to-end and still reaches its heads. */
  ok: boolean;
  /** Event id where the chain first broke (row-level breaks only — a truncated
   *  tail has no surviving row to point at). */
  brokenAt?: string;
  /** Machine-readable failure reason (present only when `ok` is false). */
  reason?: AuditChainBreak;
  /** Number of events walked while verifying. */
  count: number;
  /** Highest chain sequence number walked. */
  lastSeq?: number;
  /** Comparison against the write-once published chain head, when configured. */
  publishedHead?: {
    status: 'matched' | 'absent' | 'expired' | 'pruned' | 'unavailable';
    seq?: number;
    exportedAt?: string;
    stale?: boolean;
  };
}
