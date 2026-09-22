// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { REMOTE_AUDIT_ACTIONS } from '@pipeline-builder/api-core';
import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { config } from '../config/index.js';
import { PLATFORM_AUDIT_ACTIONS } from '../constants/audit-actions.js';

/**
 * Every audit action, as a runtime list: platform's own plus the remote subset
 * the other services emit through `POST /audit/events` (validated there against
 * api-core's `isRemoteAuditAction`). {@link AuditAction} is derived from it; the
 * array is the source because a TypeScript union cannot be enumerated.
 */
export const ALL_AUDIT_ACTIONS = [...PLATFORM_AUDIT_ACTIONS, ...REMOTE_AUDIT_ACTIONS] as const;

/**
 * Union of every audit action, derived from {@link ALL_AUDIT_ACTIONS} so the two
 * can never disagree.
 */
export type AuditAction = (typeof ALL_AUDIT_ACTIONS)[number];

/**
 * Audit event document stored in MongoDB.
 *
 * Field semantics:
 * - `orgId` — the actor's JWT-claimed org at the time of the action.
 * - `affectedOrgId` — the org that was OPERATED ON. Same as `orgId` for normal
 *   in-org actions. When a sysadmin (whose `orgId` is the system org) touches
 *   another org's resources, `affectedOrgId` carries the impacted org so the
 *   audit log answers "what did a sysadmin do to org X?" (SOC2 evidence for
 *   impersonation-style access).
 */
export interface AuditEventData {
  action: AuditAction;
  actorId: string;
  actorEmail?: string;
  /** Actor's per-org role at action time ('owner' | 'admin' | 'member'). */
  actorRole?: string;
  /**
   * The actor's org, as a STRING and under this name — unlike the
   * `organizationId: ObjectId` every other model uses. Both are part of the
   * tamper-evident record: the field is hashed into each row's chain entry and
   * is the `orgId` every service sends to `POST /audit/events`, so renaming or
   * retyping it would break verification of every stored row and the remote
   * ingest contract.
   */
  orgId?: string;
  affectedOrgId?: string;
  targetType?: string;
  targetId?: string;
  /** Permission role involved (org.role.* actions). Promoted out of
   *  `details` so reviewers can filter "who touched role X". */
  roleId?: string;
  /** Sysadmin who initiated an impersonation session, when the actor is
   *  acting under an impersonation token. Lets reviewers unmask "viewed-as". */
  impersonatorId?: string;
  /** Did the action succeed or fail? Defaults to 'success'; failure-path
   *  call sites (login.failed, plugin.build.failed/timeout) pass 'failure'. */
  outcome?: 'success' | 'failure';
  details?: Record<string, unknown>;
  ip?: string;
  /** Client User-Agent (truncated + control-chars stripped). Forensic signal
   *  for correlating an action to a device/session. */
  userAgent?: string;
  /** Correlation id (nginx `x-request-id`, or generated). Ties the event to
   *  its HTTP request and to structured log lines for the same request. */
  requestId?: string;
  /** Distributed trace id (OpenTelemetry active span) when tracing is on.
   *  Correlates the action across services end-to-end. */
  traceId?: string;
  /** TAMPER-EVIDENCE: HMAC-SHA256 (key = `AUDIT_CHAIN_HMAC_KEY`, held outside
   *  the DB) of this event's immutable fields plus `seq` and `prevHash` (see
   *  `helpers/audit-chain.ts`). Lets a verifier detect any post-hoc mutation of
   *  a stored row — and, because the key isn't in the DB, a DB writer can't
   *  re-chain around an edit. */
  hash?: string;
  /** TAMPER-EVIDENCE: 1-based position in the per-tenant chain. Assigned from
   *  the chain head under a UNIQUE `(affectedOrgId, seq)` index, so the chain
   *  is ordered by sequence, never by wall-clock `createdAt`; a missing number
   *  is a deleted row. */
  seq?: number;
  /** TAMPER-EVIDENCE: the `hash` of the most recent PRIOR event in the same
   *  per-tenant chain (chain key = `affectedOrgId ?? orgId`), or `null` for the
   *  first event in a chain. A missing/re-pointed link reveals a deleted or
   *  reordered row. */
  prevHash?: string | null;
  /** DEDUP: the stable `Idempotency-Key` the remote-audit client stamps on each
   *  emission (and reuses across its 5xx/timeout retries); platform-local
   *  `audit()` stamps one too so a spooled retry dedups. UNIQUE PER ORG
   *  (`orgId`, `idempotencyKey`) so a re-delivered event collides at the DB —
   *  even across replicas — while one tenant can never pre-claim (and so
   *  suppress, or read back) another tenant's key. */
  idempotencyKey?: string;
  /** DISPLAY-ONLY: the ISO-8601 instant the action ACTUALLY happened, as
   *  stamped by the remote-audit client at emission time. Differs from
   *  `createdAt` (ingest time) when the client spooled the event through a
   *  platform outage and re-delivered it later. Stored purely for reviewers;
   *  it is deliberately NOT the chain-ordering field and is NOT part of the
   *  tamper-evidence hash — the chain still orders/appends by ingest
   *  `createdAt`, so a spool-delayed re-delivery chains in ingest order.
   *  Reviewers fall back to `createdAt` when it is unset. */
  occurredAt?: Date;
  createdAt: Date;
}

export type AuditEventDocument = HydratedDocument<AuditEventData>;

/** A stored audit row as a lean read returns it. */
export type StoredAuditEvent = AuditEventData & { _id: Types.ObjectId };

const auditEventSchema = new Schema<AuditEventData>( {
  action: { type: String, required: true, index: true },
  actorId: { type: String, required: true, index: true },
  actorEmail: { type: String },
  actorRole: { type: String },
  orgId: { type: String, index: true },
  affectedOrgId: { type: String, index: true },
  targetType: { type: String },
  targetId: { type: String, index: true },
  // Sparse: only role/impersonation/correlation events set these, so the
  // index skips the (vast majority of) documents that leave them unset.
  roleId: { type: String, index: { sparse: true } },
  impersonatorId: { type: String, index: { sparse: true } },
  outcome: { type: String, enum: ['success', 'failure'] },
  details: { type: Schema.Types.Mixed },
  ip: { type: String },
  userAgent: { type: String },
  requestId: { type: String, index: { sparse: true } },
  traceId: { type: String },
  // TAMPER-EVIDENCE hash chain (see helpers/audit-chain.ts). `hash` is
  // deliberately NOT `required`: a digest failure still writes the row (with a
  // sentinel) rather than rejecting it. The tail pointer lives in the
  // `audit_chain_heads` collection; `(affectedOrgId, seq)` below orders the chain.
  hash: { type: String },
  seq: { type: Number },
  prevHash: { type: String, default: null },
  idempotencyKey: { type: String },
  // DISPLAY-ONLY emission timestamp (see the interface field). A PLAIN stored
  // field: deliberately NO index — indexing it would invite using it as a
  // sort/ordering key, but the tamper-evident chain must keep ordering by
  // ingest `createdAt`. It is not part of the hashed field set either, so a
  // spool-delayed value never perturbs the chain.
  occurredAt: { type: Date },
},
{
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'audit_events',
},
);

// Compound indexes for org-scoped queries sorted by time. Both
// `orgId` (actor's org) and `affectedOrgId` (the operated-on org) get one
//  the "what did sysadmins do to my org" query filters on affectedOrgId.
auditEventSchema.index({ orgId: 1, createdAt: -1 });
auditEventSchema.index({ affectedOrgId: 1, createdAt: -1 });

// DEDUP backstop — UNIQUE per org on the ingest idempotency key. Partial (not
// sparse: a sparse COMPOUND index still indexes every row that has `orgId`) so
// only events that carry a key are constrained; scoped by `orgId` (the emitting
// tenant) so a key can only collide with that same tenant's own emissions.
auditEventSchema.index(
  { orgId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true } } },
);

// CHAIN SEQUENCE — UNIQUE on (affectedOrgId, seq). The append path takes
// `seq = head.seq + 1`; two replicas racing for the same slot collide here
// (E11000) and the loser re-reads the advanced head and retries, so the chain
// can never fork. Also the verify walk's ordering index (ascending seq).
auditEventSchema.index({ affectedOrgId: 1, seq: 1 }, { unique: true });

// TTL index — auto-delete events after `config.audit.retentionDays` days
// (default 90, overridable via AUDIT_RETENTION_DAYS at boot). Reading from
// `config` keeps the env-parse in one place.
auditEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: config.audit.retentionDays * 86400 },
);

export default model<AuditEventData>('AuditEvent', auditEventSchema);
