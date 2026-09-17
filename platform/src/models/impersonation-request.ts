// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Document, Schema, model, Types } from 'mongoose';

/**
 * One request to open an impersonation ("view as user") session.
 *
 * EVERY impersonation goes through this record — there is deliberately no
 * "fast path" that issues a token without one. What differs between an
 * unchallenged session and a consented one is only WHY it reached `approved`
 * (`approvalReason`), never whether a record exists. That keeps a single state
 * machine to reason about and audit, instead of two code paths that drift.
 *
 * Shaped after `JoinRequest` (the org-join approval flow), which solves the same
 * problem: a request someone else decides, with a decision recorded on it.
 */

/**
 * `pending`  — awaiting a decision (only reachable once a consent policy exists).
 * `approved` — may be redeemed for a token.
 * `denied`   — refused by the approver; terminal.
 * `consumed` — redeemed; the token was issued. Terminal for redemption, which is
 *              what makes an approval single-use.
 * `expired`  — the approval window elapsed unredeemed; terminal.
 * `revoked`  — the session was ended early; terminal.
 * `undeliverable` — nobody could be asked: every challenge notification failed.
 *              Terminal, and deliberately DISTINCT from `expired` — a request
 *              that silently lapsed would read to the operator as a refusal.
 */
export type ImpersonationRequestStatus =
  | 'pending' | 'approved' | 'denied' | 'consumed' | 'expired' | 'revoked' | 'undeliverable';
export const IMPERSONATION_REQUEST_STATUSES: readonly ImpersonationRequestStatus[] =
  ['pending', 'approved', 'denied', 'consumed', 'expired', 'revoked', 'undeliverable'];

/**
 * Why a request reached `approved`. The audit trail's most load-bearing field:
 * it is the difference between "nobody was asked" and "someone said yes".
 *
 * `policy_open`        — the target org does not require consent.
 * `ancestor_authority` — the requester administers an ancestor of the target's
 *                        org, so no challenge is sent (a parent already manages
 *                        its teams; asking a team to consent to its own parent
 *                        would invert that).
 * `consent`            — a human approved the challenge.
 * `breakglass`         — emergency access taken over a consent requirement.
 */
export type ImpersonationApprovalReason =
  | 'policy_open' | 'ancestor_authority' | 'consent' | 'breakglass';
export const IMPERSONATION_APPROVAL_REASONS: readonly ImpersonationApprovalReason[] =
  ['policy_open', 'ancestor_authority', 'consent', 'breakglass'];

/**
 * Who the challenge is pointed at.
 *
 * `user`      — the impersonated user themselves. The default: the person with
 *               the most direct interest answers. Also self-approval, which is
 *               why an org can forbid it.
 * `org_admin` — every admin of the pinned org; first to decide wins. For when
 *               the user is unreachable, inactive, or shouldn't be the judge.
 */
export type ImpersonationApproverMode = 'user' | 'org_admin';
export const IMPERSONATION_APPROVER_MODES: readonly ImpersonationApproverMode[] = ['user', 'org_admin'];

export interface ImpersonationRequestDocument extends Document {
  /**
   * The string form of `_id` — Mongoose's default `id` virtual, present on every
   * hydrated document. Declared because this Mongoose version's `Document` type
   * doesn't carry it, and the request id is passed around (audit events, API
   * responses, redemption) as a string.
   */
  id: string;
  /** The operator asking — a sysadmin today, an ancestor-org admin later. */
  requesterId: Types.ObjectId;
  /** The user whose view is being reproduced. */
  targetUserId: Types.ObjectId;
  /**
   * The org this session is PINNED to. Absent when the target has no resolvable
   * membership; the token is then issued with no org context rather than landing
   * on some other org they belong to (see `issueImpersonationToken`).
   */
  orgId?: string;
  /** Operator-stated justification. Read by the target org, so treat as untrusted display text. */
  reason?: string;
  /**
   * Emergency access taken over a consent requirement. A break-glass request is
   * decided by a SECOND SYSADMIN (four-eyes), never by the tenant — it exists
   * precisely for when the tenant cannot or should not be asked.
   */
  breakglass?: boolean;
  status: ImpersonationRequestStatus;
  approvalReason?: ImpersonationApprovalReason;
  /** Where the challenge was sent. Unset when nobody was asked. */
  approverMode?: ImpersonationApproverMode;
  /** The specific user challenged under `user` mode. */
  approverUserId?: Types.ObjectId;
  /**
   * The `jti` of the token issued for this session, set on redemption.
   *
   * This is what makes a session revocable INDIVIDUALLY. Revoking via the
   * user's `tokenVersion` would invalidate the target's own sessions at the
   * same time — the person ending a support session would be logged out of
   * their own account.
   */
  jti?: string;
  /** Who decided, when a human did. Unset for auto-approvals. */
  decidedBy?: Types.ObjectId;
  decidedAt?: Date;
  /** Who ended the session early, and when. */
  revokedBy?: Types.ObjectId;
  revokedAt?: Date;
  /** When an unredeemed approval stops being redeemable. */
  expiresAt: Date;
  /** When the token was actually issued. */
  consumedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** How long an approval stays redeemable. */
export const IMPERSONATION_REQUEST_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Cap on the operator's stated reason — it is rendered to the target org. */
export const IMPERSONATION_REASON_MAX = 500;

const impersonationRequestSchema = new Schema<ImpersonationRequestDocument>(
  {
    requesterId: { type: Schema.Types.ObjectId, required: true, index: true },
    targetUserId: { type: Schema.Types.ObjectId, required: true, index: true },
    orgId: { type: String },
    reason: { type: String, maxlength: IMPERSONATION_REASON_MAX },
    breakglass: { type: Boolean },
    status: {
      type: String,
      enum: IMPERSONATION_REQUEST_STATUSES as unknown as string[],
      default: 'pending',
      required: true,
    },
    approvalReason: { type: String, enum: IMPERSONATION_APPROVAL_REASONS as unknown as string[] },
    approverMode: { type: String, enum: IMPERSONATION_APPROVER_MODES as unknown as string[] },
    approverUserId: { type: Schema.Types.ObjectId },
    jti: { type: String },
    decidedBy: { type: Schema.Types.ObjectId },
    decidedAt: { type: Date },
    revokedBy: { type: Schema.Types.ObjectId },
    revokedAt: { type: Date },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date },
  },
  { timestamps: true, collection: 'impersonation_requests' },
);

// An operator may hold only ONE live request against a given user. Without this
// a requester can stack challenges and spam the target until they approve
// reflexively — consent fatigue is the cheapest attack on a consent gate. A
// re-request supersedes the pending one rather than adding to it.
// PARTIAL index: only `pending` rows are constrained, so the full history of
// decided requests is retained for audit.
impersonationRequestSchema.index(
  { requesterId: 1, targetUserId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

// Break-glass rate limit: count one sysadmin's recent emergency accesses.
impersonationRequestSchema.index({ requesterId: 1, breakglass: 1, createdAt: -1 });

// The target org's admins reviewing who asked to view their members.
impersonationRequestSchema.index({ orgId: 1, createdAt: -1 });

// Auth-time lookup: every request made under an impersonation token resolves its
// session by `jti`, so this index is on the hot path. Sparse — only redeemed
// requests carry one.
impersonationRequestSchema.index({ jti: 1 }, { sparse: true });

// NOT a Mongo TTL index: expiry must flip `status` and leave the row in place,
// because these records are audit evidence. Deleting them would erase the
// history of who asked for access and what came of it.

/** True once the approval window has elapsed. */
impersonationRequestSchema.methods.isExpired = function (): boolean {
  return new Date() > this.expiresAt;
};

export default model<ImpersonationRequestDocument>(
  'ImpersonationRequest',
  impersonationRequestSchema,
);
