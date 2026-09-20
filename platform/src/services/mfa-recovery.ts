// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Factor reset for an account that has lost EVERY multi-factor credential (#8).
 *
 * THREE ways in, ONE reset ({@link resetFactors}):
 *   1. the TWO-PERSON HTTP flow — an org admin/owner requests a reset for a
 *      member ({@link requestMfaReset}); a DIFFERENT admin/owner of that org or
 *      of an ancestor, or a sysadmin, approves it ({@link approveMfaReset}).
 *      Both steps need an `aal: 2` session and a step-up at the route, so the
 *      flow is never a way AROUND a second factor: it takes two people who each
 *      hold one;
 *   2. a sysadmin's DIRECT reset ({@link directMfaReset}) for an org with no
 *      second admin to approve — same assurance, a strong-factor step-up, and a
 *      reason, and audited as the single-person path it is;
 *   3. the operator command (`scripts/mfa-recover.ts` → {@link recoverMfa}) for
 *      when nobody can sign in at all. Its operator name is self-asserted — it
 *      runs with database access, which is the trust it relies on.
 *
 * WHAT A RESET DOES: removes every passkey, the authenticator app and the
 * recovery codes; bumps `tokenVersion` and clears every refresh-session slot
 * (every session everywhere ends); and grants the person a bounded ENROLMENT
 * GRACE (`User.mfaResetGraceUntil`). The grace is what lets them sign in with
 * their password and enrol a new factor while their org requires MFA — for
 * them alone, for a few days. The org's policy is never touched: resetting one
 * member must not weaken it for everybody else (the old `--clear-org-policy`
 * flag did exactly that, and missed a policy inherited from a parent anyway).
 *
 * Lives here, not in the script, so the script's `process.exit` never stands
 * between a test and the one recovery path there is.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { auditService } from './audit-service.js';
import { publishUserRevocation } from '../helpers/session-revocation.js';
import {
  MfaRecoveryCodes,
  MfaResetRequest,
  User,
  UserOrganization,
  UserTotp,
  WebAuthnCredential,
  type MfaResetRequestDocument,
} from '../models/index.js';

const logger = createLogger('mfa-recovery');

/** Default enrolment grace after a reset. */
export const MFA_RESET_GRACE_DEFAULT_HOURS = 72;
/** The longest grace an approver may grant — beyond a week an MFA-required org
 *  would have a member quietly exempt from it. */
export const MFA_RESET_GRACE_MAX_HOURS = 168;
/** How long a request waits for a second admin before it can't be approved. */
export const MFA_RESET_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

// Error sentinels (mapped to HTTP by controllers/mfa-reset.ts).
export const MFA_RESET_NOT_FOUND = 'MFA_RESET_NOT_FOUND';
export const MFA_RESET_NOT_MEMBER = 'MFA_RESET_NOT_MEMBER';
export const MFA_RESET_SELF = 'MFA_RESET_SELF';
export const MFA_RESET_PLATFORM_ADMIN = 'MFA_RESET_PLATFORM_ADMIN';
export const MFA_RESET_ALREADY_PENDING = 'MFA_RESET_ALREADY_PENDING';
export const MFA_RESET_NOT_PENDING = 'MFA_RESET_NOT_PENDING';
export const MFA_RESET_EXPIRED = 'MFA_RESET_EXPIRED';
export const MFA_RESET_SECOND_PERSON_REQUIRED = 'MFA_RESET_SECOND_PERSON_REQUIRED';

/** What a reset removed and granted. */
export interface FactorResetResult {
  userId: string;
  email: string;
  passkeysRemoved: number;
  totpRemoved: boolean;
  recoveryCodesRemoved: boolean;
  /** The account's `tokenVersion` AFTER the bump — every older token is dead. */
  tokenVersion: number;
  /** End of the per-user enrolment grace. */
  graceUntil: Date;
}

/** Who is acting (a signed-in person — real ids, never self-asserted). */
export interface ResetActor {
  id: string;
  email?: string;
  isSuperAdmin?: boolean;
}

function clampGraceHours(hours: number | undefined): number {
  const h = hours ?? MFA_RESET_GRACE_DEFAULT_HOURS;
  return Math.min(Math.max(1, Math.floor(h)), MFA_RESET_GRACE_MAX_HOURS);
}

/**
 * THE reset. Removes every factor and the recovery codes, ends every session
 * and grants the enrolment grace. Returns `null` when the account is gone.
 *
 * Never reopens the bootstrap exception: that closes permanently at the first
 * enrolment (see `helpers/bootstrap-admin.ts`), and the grace is its bounded,
 * per-person replacement.
 */
export async function resetFactors(userId: string, graceHours?: number): Promise<FactorResetResult | null> {
  const user = await User.findById(userId).select('email').lean() as { email: string } | null;
  if (!user) return null;

  const [passkeys, totp, codes] = await Promise.all([
    WebAuthnCredential.deleteMany({ userId }),
    UserTotp.deleteOne({ userId }),
    MfaRecoveryCodes.deleteOne({ userId }),
  ]);

  const graceUntil = new Date(Date.now() + clampGraceHours(graceHours) * 60 * 60 * 1000);
  // Bump `tokenVersion` AND clear the slots — "sign out everywhere". A reset
  // that left a live session behind would be a reset in name only.
  const updated = await User.findByIdAndUpdate(
    userId,
    { $inc: { tokenVersion: 1 }, $set: { refreshSessions: [], mfaResetGraceUntil: graceUntil } },
    { new: true },
  ).select('+tokenVersion').lean();
  await publishUserRevocation(userId);

  const result: FactorResetResult = {
    userId,
    email: user.email,
    passkeysRemoved: passkeys.deletedCount ?? 0,
    totpRemoved: (totp.deletedCount ?? 0) > 0,
    recoveryCodesRemoved: (codes.deletedCount ?? 0) > 0,
    tokenVersion: (updated as { tokenVersion?: number } | null)?.tokenVersion ?? 0,
    graceUntil,
  };
  logger.warn('Multi-factor credentials reset', { ...result });
  return result;
}

// -- The operator command ------------------------------------------------------

export interface MfaRecoveryOptions {
  /** The account to reset, by email. */
  email: string;
  /** Who is running this. Recorded as the audit actor — self-asserted, since the
   *  command runs with database access rather than a session. */
  operator: string;
  /** Enrolment grace to grant (hours, default 72, max 168). */
  graceHours?: number;
}

/**
 * The operator command's reset (`scripts/mfa-recover.ts`). Returns `null` when
 * no such account exists. Audited, awaited — if the trail can't be written the
 * command fails rather than quietly resetting a factor with no record of it.
 */
export async function recoverMfa(opts: MfaRecoveryOptions): Promise<FactorResetResult | null> {
  const user = await User.findOne({ email: opts.email.trim().toLowerCase() }).select('_id').lean() as { _id: unknown } | null;
  if (!user) return null;
  const result = await resetFactors(String(user._id), opts.graceHours);
  if (!result) return null;

  await auditService.createEvent({
    action: 'auth.mfa.operator_reset',
    actorId: opts.operator,
    actorEmail: opts.operator,
    targetType: 'user',
    targetId: result.userId,
    outcome: 'success',
    details: {
      email: result.email,
      passkeysRemoved: result.passkeysRemoved,
      totpRemoved: result.totpRemoved,
      recoveryCodesRemoved: result.recoveryCodesRemoved,
      graceUntil: result.graceUntil.toISOString(),
      via: 'operator-command',
      operatorAsserted: true,
    },
  });
  return result;
}

// -- The two-person HTTP flow --------------------------------------------------

/** A request as the API returns it. */
export interface MfaResetRequestView {
  id: string;
  organizationId: string;
  targetUserId: string;
  targetEmail: string;
  requestedBy: string;
  requestedByEmail: string;
  reason: string;
  status: MfaResetRequestDocument['status'];
  createdAt: string;
  expiresAt: string;
  decidedBy?: string;
  decidedByEmail?: string;
  decidedAt?: string;
  decisionNote?: string;
  result?: { passkeysRemoved: number; totpRemoved: boolean; recoveryCodesRemoved: boolean; graceUntil: string };
}

type StoredRequest = Pick<MfaResetRequestDocument,
  'organizationId' | 'targetEmail' | 'requestedByEmail' | 'reason' | 'status' | 'createdAt' | 'expiresAt'
  | 'decidedByEmail' | 'decidedAt' | 'decisionNote' | 'result'>
  & { _id: unknown; targetUserId: unknown; requestedBy: unknown; decidedBy?: unknown };

export function toRequestView(doc: StoredRequest): MfaResetRequestView {
  return {
    id: String(doc._id),
    organizationId: doc.organizationId,
    targetUserId: String(doc.targetUserId),
    targetEmail: doc.targetEmail,
    requestedBy: String(doc.requestedBy),
    requestedByEmail: doc.requestedByEmail,
    reason: doc.reason,
    status: doc.status,
    createdAt: new Date(doc.createdAt).toISOString(),
    expiresAt: new Date(doc.expiresAt).toISOString(),
    ...(doc.decidedBy ? { decidedBy: String(doc.decidedBy) } : {}),
    ...(doc.decidedByEmail ? { decidedByEmail: doc.decidedByEmail } : {}),
    ...(doc.decidedAt ? { decidedAt: new Date(doc.decidedAt).toISOString() } : {}),
    ...(doc.decisionNote ? { decisionNote: doc.decisionNote } : {}),
    ...(doc.result ? {
      result: {
        passkeysRemoved: doc.result.passkeysRemoved,
        totpRemoved: doc.result.totpRemoved,
        recoveryCodesRemoved: doc.result.recoveryCodesRemoved,
        graceUntil: new Date(doc.result.graceUntil).toISOString(),
      },
    } : {}),
  };
}

/** Mark every lapsed pending request in `orgIds` as expired. */
async function expireLapsed(orgIds: readonly string[], now: Date = new Date()): Promise<void> {
  await MfaResetRequest.updateMany(
    { organizationId: { $in: [...orgIds] }, status: 'pending', expiresAt: { $lte: now } },
    { $set: { status: 'expired' } },
  );
}

/**
 * File a reset request for `targetUserId`, an ACTIVE member of
 * `organizationId`. The caller has already established that the requester
 * administers the org (and holds `aal: 2` + a step-up).
 *
 * Refused: for oneself (`MFA_RESET_SELF` — a person asking to remove their own
 * factors should use their recovery codes or ask a colleague); for a platform
 * administrator (`MFA_RESET_PLATFORM_ADMIN` — an org's admins must not be able
 * to strip a platform operator's factors; that is the sysadmin/operator path);
 * and while another request for the same member is still pending.
 */
export async function requestMfaReset(input: {
  organizationId: string;
  targetUserId: string;
  requester: ResetActor;
  reason: string;
}): Promise<MfaResetRequestView> {
  const { organizationId, targetUserId, requester, reason } = input;
  if (targetUserId === requester.id) throw new Error(MFA_RESET_SELF);
  if (!Types.ObjectId.isValid(targetUserId)) throw new Error(MFA_RESET_NOT_MEMBER);

  const membership = await UserOrganization.exists({ userId: targetUserId, organizationId, isActive: true });
  if (!membership) throw new Error(MFA_RESET_NOT_MEMBER);
  const target = await User.findById(targetUserId).select('email +isSuperAdmin').lean() as { email: string; isSuperAdmin?: boolean } | null;
  if (!target) throw new Error(MFA_RESET_NOT_MEMBER);
  if (target.isSuperAdmin === true) throw new Error(MFA_RESET_PLATFORM_ADMIN);

  await expireLapsed([organizationId]);
  const now = new Date();
  try {
    const created = await MfaResetRequest.create({
      organizationId,
      targetUserId,
      targetEmail: target.email,
      requestedBy: requester.id,
      requestedByEmail: requester.email ?? '',
      reason,
      status: 'pending',
      createdAt: now,
      expiresAt: new Date(now.getTime() + MFA_RESET_REQUEST_TTL_MS),
    });
    return toRequestView(created.toObject() as StoredRequest);
  } catch (err) {
    // The partial unique index: one pending request per member per org.
    if ((err as { code?: number }).code === 11000) throw new Error(MFA_RESET_ALREADY_PENDING);
    throw err;
  }
}

/** Requests in `orgIds` — pending first, then the most recent decisions. */
export async function listMfaResets(orgIds: readonly string[]): Promise<MfaResetRequestView[]> {
  await expireLapsed(orgIds);
  const docs = await MfaResetRequest.find({ organizationId: { $in: [...orgIds] } })
    .sort({ createdAt: -1 }).limit(50).lean() as unknown as StoredRequest[];
  const views = docs.map(toRequestView);
  return [...views.filter((v) => v.status === 'pending'), ...views.filter((v) => v.status !== 'pending')];
}

/** One request, or throws `MFA_RESET_NOT_FOUND`. */
export async function getMfaReset(requestId: string): Promise<MfaResetRequestView> {
  if (!Types.ObjectId.isValid(requestId)) throw new Error(MFA_RESET_NOT_FOUND);
  const doc = await MfaResetRequest.findById(requestId).lean() as unknown as StoredRequest | null;
  if (!doc) throw new Error(MFA_RESET_NOT_FOUND);
  return toRequestView(doc);
}

/**
 * Explain why a pending request can't be claimed right now: gone, already
 * decided, or lapsed (which it marks).
 */
async function refusalFor(requestId: string, now: Date): Promise<string> {
  const doc = await MfaResetRequest.findById(requestId).select('status expiresAt').lean() as { status: string; expiresAt: Date } | null;
  if (!doc) return MFA_RESET_NOT_FOUND;
  if (doc.status === 'pending' && new Date(doc.expiresAt).getTime() <= now.getTime()) {
    await MfaResetRequest.updateOne({ _id: requestId, status: 'pending' }, { $set: { status: 'expired' } });
    return MFA_RESET_EXPIRED;
  }
  return doc.status === 'expired' ? MFA_RESET_EXPIRED : MFA_RESET_NOT_PENDING;
}

/**
 * APPROVE a pending request and carry out the reset.
 *
 * The approver must be a DIFFERENT person from both the requester and the
 * member being reset — enforced in the same atomic claim that moves the request
 * out of `pending`, so neither a race nor a retry can approve one twice or let
 * one person play both parts. If the reset itself then fails, the claim is
 * released and the request is pending again.
 */
export async function approveMfaReset(input: {
  requestId: string;
  approver: ResetActor;
  graceHours?: number;
}): Promise<{ request: MfaResetRequestView; result: FactorResetResult }> {
  const { requestId, approver } = input;
  if (!Types.ObjectId.isValid(requestId)) throw new Error(MFA_RESET_NOT_FOUND);
  const now = new Date();
  const approverId = new Types.ObjectId(approver.id);

  const current = await MfaResetRequest.findById(requestId).select('requestedBy targetUserId').lean() as { requestedBy: unknown; targetUserId: unknown } | null;
  if (!current) throw new Error(MFA_RESET_NOT_FOUND);
  if (String(current.requestedBy) === approver.id || String(current.targetUserId) === approver.id) {
    throw new Error(MFA_RESET_SECOND_PERSON_REQUIRED);
  }

  const claimed = await MfaResetRequest.findOneAndUpdate(
    {
      _id: requestId,
      status: 'pending',
      expiresAt: { $gt: now },
      requestedBy: { $ne: approverId },
      targetUserId: { $ne: approverId },
    },
    { $set: { status: 'approved', decidedBy: approverId, decidedByEmail: approver.email ?? '', decidedAt: now } },
    { new: true },
  ).lean() as unknown as StoredRequest | null;
  if (!claimed) throw new Error(await refusalFor(requestId, now));

  let result: FactorResetResult | null;
  try {
    result = await resetFactors(String(claimed.targetUserId), input.graceHours);
  } catch (err) {
    await MfaResetRequest.updateOne(
      { _id: requestId, status: 'approved' },
      { $set: { status: 'pending' }, $unset: { decidedBy: '', decidedByEmail: '', decidedAt: '' } },
    );
    throw err;
  }
  if (!result) {
    // The member was deleted in the meantime; nothing to reset.
    await MfaResetRequest.updateOne({ _id: requestId }, { $set: { status: 'expired' } });
    throw new Error(MFA_RESET_NOT_MEMBER);
  }

  const stored = await MfaResetRequest.findByIdAndUpdate(
    requestId,
    {
      $set: {
        result: {
          passkeysRemoved: result.passkeysRemoved,
          totpRemoved: result.totpRemoved,
          recoveryCodesRemoved: result.recoveryCodesRemoved,
          graceUntil: result.graceUntil,
        },
      },
    },
    { new: true },
  ).lean() as unknown as StoredRequest | null;
  return { request: toRequestView(stored ?? claimed), result };
}

/**
 * DENY (or, by its requester, WITHDRAW) a pending request. Denial only ever
 * removes a pending action, so it needs no second person.
 */
export async function denyMfaReset(input: { requestId: string; actor: ResetActor; note?: string }): Promise<MfaResetRequestView> {
  const { requestId, actor, note } = input;
  if (!Types.ObjectId.isValid(requestId)) throw new Error(MFA_RESET_NOT_FOUND);
  const now = new Date();
  const updated = await MfaResetRequest.findOneAndUpdate(
    { _id: requestId, status: 'pending', expiresAt: { $gt: now } },
    {
      $set: {
        status: 'denied',
        decidedBy: new Types.ObjectId(actor.id),
        decidedByEmail: actor.email ?? '',
        decidedAt: now,
        ...(note ? { decisionNote: note } : {}),
      },
    },
    { new: true },
  ).lean() as unknown as StoredRequest | null;
  if (!updated) throw new Error(await refusalFor(requestId, now));
  return toRequestView(updated);
}

/**
 * A sysadmin's DIRECT reset — the single-person path, for an org that has no
 * second admin to approve a request. The route demands `aal: 2`, a strong-factor
 * step-up and a reason; the audit event says it was direct.
 */
export async function directMfaReset(input: {
  targetUserId: string;
  actor: ResetActor;
  graceHours?: number;
}): Promise<FactorResetResult> {
  if (input.targetUserId === input.actor.id) throw new Error(MFA_RESET_SELF);
  if (!Types.ObjectId.isValid(input.targetUserId)) throw new Error(MFA_RESET_NOT_FOUND);
  const result = await resetFactors(input.targetUserId, input.graceHours);
  if (!result) throw new Error(MFA_RESET_NOT_FOUND);
  // Any request still pending for this person is now moot.
  await MfaResetRequest.updateMany(
    { targetUserId: input.targetUserId, status: 'pending' },
    { $set: { status: 'denied', decidedBy: new Types.ObjectId(input.actor.id), decidedByEmail: input.actor.email ?? '', decidedAt: new Date(), decisionNote: 'Superseded by a direct reset' } },
  );
  return result;
}
