// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Impersonation request lifecycle.
 *
 * Every impersonation session is represented by an `ImpersonationRequest`, even
 * when nobody is asked to approve it. There is no second code path that issues a
 * token without a record: an unchallenged session is simply one that reached
 * `approved` on creation, with `approvalReason` saying why. That is what keeps a
 * single state machine to audit and test rather than two that drift apart.
 *
 * Whether a request is approved on creation, waits for a person, or is refused
 * outright is decided in ONE place — `decideInitialApproval` — from who is
 * asking and the organization's effective policy. Everything after that decision
 * (redeeming, deciding, revoking, expiry) is the same for every request.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { IMPERSONATION_SESSION_TTL_MS } from '../constants/impersonation.js';
import {
  ImpersonationRequest,
  User,
  IMPERSONATION_REQUEST_TTL_MS,
  IMPERSONATION_REASON_MAX,
  type ImpersonationRequestDocument,
  type ImpersonationApprovalReason,
  type ImpersonationApproverMode,
} from '../models/index.js';

const logger = createLogger('impersonation-service');

/** The request is not in a state that can be redeemed for a token. */
export const IMP_NOT_APPROVED = 'IMP_NOT_APPROVED';
/** The approval window elapsed before the request was redeemed. */
export const IMP_EXPIRED = 'IMP_EXPIRED';
/** No such request. */
export const IMP_NOT_FOUND = 'IMP_NOT_FOUND';
/** Someone already approved or denied this request. */
export const IMP_ALREADY_DECIDED = 'IMP_ALREADY_DECIDED';
/** There is no live session to end — never redeemed, or already revoked. */
export const IMP_NOT_LIVE = 'IMP_NOT_LIVE';

/**
 * Break-glass rate limit: emergency accesses per sysadmin, per rolling window.
 *
 * An unlimited bypass that is merely logged becomes routine. Exceeding the cap
 * does NOT refuse — a hard stop on emergency access is itself a lockout, and
 * would bite during exactly the incident it exists for. It ESCALATES instead: the
 * request needs a second sysadmin even where it otherwise would not.
 */
export const BREAKGLASS_WINDOW_DAYS = 30;
export const BREAKGLASS_CAP = 5;

/** Why a break-glass request needs a second sysadmin. */
export type FourEyesReason = 'policy_denied' | 'rate_limit';

/** Cap on rows per list view. */
const LIST_LIMIT = 100;

/** A request as shown to a person — display names resolved, session token id omitted. */
export interface ImpersonationRequestSummary {
  id: string;
  status: string;
  breakglass: boolean;
  approvalReason?: string;
  approverMode?: string;
  orgId?: string;
  /** Operator-written. Render as text, never as markup. */
  reason?: string;
  requester: { id: string; name: string };
  target: { id: string; name: string };
  createdAt: Date;
  expiresAt: Date;
  consumedAt?: Date;
  decidedAt?: Date;
}

export interface CreateImpersonationRequestInput {
  requesterId: string;
  targetUserId: string;
  /** The org the session pins to; absent when the target has no resolvable membership. */
  orgId?: string;
  /** Operator-stated justification, truncated to the model's cap. */
  reason?: string;
  /**
   * How the request starts, from `decideInitialApproval`. A `refused` decision
   * never reaches here — the caller rejects it before any record is made.
   */
  decision: Exclude<InitialApproval, { kind: 'refused' }>;
  /**
   * Where a challenge would be sent. Recorded even on auto-approved requests so
   * the trail shows who WOULD have been asked, not only who answered.
   */
  approverMode?: ImpersonationApproverMode;
  /** The specific user to challenge under `user` mode. */
  approverUserId?: string;
}

/**
 * A request's status as it should be SHOWN: a `pending` or `approved` request
 * whose window has passed is `expired`, whether or not the reaper has yet
 * rewritten the row. Final statuses are returned unchanged.
 */
export function effectiveStatus(status: string, expiresAt: Date | undefined, now: Date = new Date()): string {
  if ((status === 'pending' || status === 'approved') && expiresAt && new Date(expiresAt).getTime() <= now.getTime()) {
    return 'expired';
  }
  return status;
}

/** How a new (non-emergency) request starts out. */
export type InitialApproval =
  /** Approved on creation; `reason` says why nobody was asked. */
  | { kind: 'approved'; reason: 'policy_open' | 'ancestor_authority' }
  /** Waits for a person to approve it. */
  | { kind: 'pending' }
  /** Not allowed at all under this policy — only emergency access remains. */
  | { kind: 'refused' };

/**
 * THE consent decision: how an ordinary impersonation request starts, given who
 * is asking and the organization's EFFECTIVE policy (strictest across parent and
 * team — see `resolveEffectiveImpersonationPolicy`).
 *
 *   - An ancestor-org admin is approved outright: a parent already administers
 *     its teams, and the team is informed rather than asked. Policy does not apply.
 *   - `open`    → approved, and the reason records that nobody was asked.
 *   - `consent` → pending until someone approves.
 *   - `denied`  → refused. Emergency access is the only path left, deliberately.
 *
 * An UNRESOLVED policy (the parent couldn't be read) arrives here as `denied`
 * with `resolved: false`, and is refused like any `denied`. That never blocks
 * emergency access, which handles the unresolved case separately.
 *
 * Pure, so every combination is testable without a database.
 */
export function decideInitialApproval(input: {
  ancestorAuthority: boolean;
  policy: { policy: 'open' | 'consent' | 'denied' } | undefined;
}): InitialApproval {
  if (input.ancestorAuthority) return { kind: 'approved', reason: 'ancestor_authority' };
  // No policy supplied for a non-ancestor request is a caller bug. Fail toward
  // asking, never toward open access.
  if (!input.policy) return { kind: 'pending' };
  switch (input.policy.policy) {
    case 'open': return { kind: 'approved', reason: 'policy_open' };
    case 'consent': return { kind: 'pending' };
    case 'denied': return { kind: 'refused' };
    default: return { kind: 'pending' };
  }
}

class ImpersonationService {
  /**
   * Open a request. Auto-approving requests are created already `approved`, so a
   * caller can redeem immediately; a request awaiting a human would be created
   * `pending` instead (not reachable yet).
   *
   * A requester may hold only one PENDING request per target — enforced by a
   * partial unique index — so a re-request supersedes rather than stacking. Any
   * superseded pending row is retired to `expired` rather than deleted, since
   * these records are audit evidence.
   */
  async createRequest(input: CreateImpersonationRequestInput): Promise<ImpersonationRequestDocument> {
    const approved = input.decision.kind === 'approved';
    const approvalReason: ImpersonationApprovalReason | undefined =
      input.decision.kind === 'approved' ? input.decision.reason : undefined;

    await ImpersonationRequest.updateMany(
      { requesterId: input.requesterId, targetUserId: input.targetUserId, status: 'pending' },
      { $set: { status: 'expired' } },
    );

    const doc = await ImpersonationRequest.create({
      requesterId: input.requesterId,
      targetUserId: input.targetUserId,
      orgId: input.orgId,
      reason: input.reason?.slice(0, IMPERSONATION_REASON_MAX),
      status: approved ? 'approved' : 'pending',
      approvalReason: approved ? approvalReason : undefined,
      approverMode: input.approverMode,
      approverUserId: input.approverUserId,
      expiresAt: new Date(Date.now() + IMPERSONATION_REQUEST_TTL_MS),
    });

    logger.info('Impersonation requested', {
      requestId: doc.id,
      requesterId: input.requesterId,
      targetUserId: input.targetUserId,
      orgId: input.orgId,
      status: doc.status,
      approvalReason: doc.approvalReason,
    });
    return doc;
  }

  /**
   * Mark an approved request as redeemed. Returns an error code instead of
   * throwing so the caller can map it to a response.
   *
   * The status guard is what makes an approval SINGLE-USE: the update only
   * matches while the row is still `approved`, so two concurrent redemptions
   * cannot both succeed — the second matches nothing. Expiry is checked in the
   * same query rather than read-then-write, so a request cannot lapse between
   * the check and the update.
   */
  async consume(requestId: string, jti: string): Promise<{ ok: true } | { ok: false; code: string }> {
    const now = new Date();
    const updated = await ImpersonationRequest.findOneAndUpdate(
      { _id: requestId, status: 'approved', expiresAt: { $gt: now } },
      { $set: { status: 'consumed', consumedAt: now, jti } },
      { new: true },
    );
    if (updated) return { ok: true };

    // Nothing matched — say WHY, so the caller can distinguish "too late" from
    // "already used" rather than reporting a generic failure.
    const current = await ImpersonationRequest.findById(requestId).lean();
    if (current && current.status === 'approved' && current.expiresAt <= now) {
      await ImpersonationRequest.updateOne(
        { _id: requestId, status: 'approved' },
        { $set: { status: 'expired' } },
      );
      return { ok: false, code: IMP_EXPIRED };
    }
    return { ok: false, code: IMP_NOT_APPROVED };
  }

  /**
   * Approve or deny a pending request.
   *
   * The `pending` guard lives in the filter, so a second decider on a request
   * that has already been settled changes nothing and is told so — rather than
   * silently overwriting the first decision. That matters under `org_admin`
   * routing, where the challenge fans out to every admin and the first to answer
   * wins: the others are holding a live-looking prompt for a settled request.
   */
  async decide(
    requestId: string,
    deciderId: string,
    approve: boolean,
    breakglass = false,
  ): Promise<{ ok: true; request: ImpersonationRequestDocument } | { ok: false; code: string }> {
    const now = new Date();
    // A second sysadmin approving emergency access is recorded as `breakglass`,
    // not `consent` — nobody in the tenant said yes, and the trail must not imply
    // they did.
    const reasonOnApprove: ImpersonationApprovalReason = breakglass ? 'breakglass' : 'consent';
    const updated = await ImpersonationRequest.findOneAndUpdate(
      { _id: requestId, status: 'pending', expiresAt: { $gt: now } },
      {
        $set: {
          status: approve ? 'approved' : 'denied',
          ...(approve ? { approvalReason: reasonOnApprove } : {}),
          decidedBy: deciderId,
          decidedAt: now,
        },
      },
      { new: true },
    );
    if (updated) return { ok: true, request: updated };

    const current = await ImpersonationRequest.findById(requestId).lean();
    if (!current) return { ok: false, code: IMP_NOT_FOUND };
    if (current.status === 'pending' && current.expiresAt <= now) {
      await ImpersonationRequest.updateOne(
        { _id: requestId, status: 'pending' },
        { $set: { status: 'expired' } },
      );
      return { ok: false, code: IMP_EXPIRED };
    }
    return { ok: false, code: IMP_ALREADY_DECIDED };
  }

  /**
   * Open an EMERGENCY request that bypasses tenant consent.
   *
   * Approved on creation — unless it needs a second sysadmin, in which case it
   * waits for one. Two things require that:
   *   - the org has CHOSEN `denied`. Only when the policy actually resolved: an
   *     org that couldn't be read resolves to strictest with `resolved: false`,
   *     and escalating on that would turn a database blip into a lockout. The
   *     four-eyes requirement is justified by an org's choice, not by our failure
   *     to read it.
   *   - the requester is over their break-glass cap.
   */
  async createBreakglassRequest(input: {
    requesterId: string;
    targetUserId: string;
    orgId?: string;
    justification: string;
    policy?: { policy: string; resolved: boolean };
  }): Promise<{
      request: ImpersonationRequestDocument;
      fourEyes: FourEyesReason | null;
      recentCount: number;
    }> {
    const since = new Date(Date.now() - BREAKGLASS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const recentCount = await ImpersonationRequest.countDocuments({
      requesterId: input.requesterId, breakglass: true, createdAt: { $gte: since },
    });

    const policyDenied = input.policy?.resolved === true && input.policy.policy === 'denied';
    const fourEyes: FourEyesReason | null = policyDenied
      ? 'policy_denied'
      : recentCount >= BREAKGLASS_CAP ? 'rate_limit' : null;

    // Same supersede-before-insert as createRequest: the partial unique index
    // allows one pending request per (requester, target).
    await ImpersonationRequest.updateMany(
      { requesterId: input.requesterId, targetUserId: input.targetUserId, status: 'pending' },
      { $set: { status: 'expired' } },
    );

    const request = await ImpersonationRequest.create({
      requesterId: input.requesterId,
      targetUserId: input.targetUserId,
      orgId: input.orgId,
      reason: input.justification.slice(0, IMPERSONATION_REASON_MAX),
      breakglass: true,
      status: fourEyes ? 'pending' : 'approved',
      approvalReason: fourEyes ? undefined : 'breakglass',
      expiresAt: new Date(Date.now() + IMPERSONATION_REQUEST_TTL_MS),
    });

    logger.warn('Break-glass impersonation requested', {
      requestId: request.id,
      requesterId: input.requesterId,
      targetUserId: input.targetUserId,
      orgId: input.orgId,
      fourEyes,
      recentCount,
    });
    return { request, fourEyes, recentCount };
  }

  /**
   * Requests visible to a caller, for one of three views.
   *
   * Visibility MIRRORS the decide and revoke authorization exactly. A list that
   * showed more than the caller could act on would leak who is asking to view
   * whom across tenants; one that showed less would leave an approver unable to
   * find what they were asked to decide.
   *
   *   `to-decide` — pending requests the caller may decide. Consent requests go
   *                 to the named approver or a tenant admin of the org; break-glass
   *                 goes to a SYSADMIN. Never the caller's own request, and
   *                 sysadmin status grants NO view of consent requests — that is
   *                 the same line that closed the self-approval bypass.
   *   `mine`      — requests the caller opened, so they can see a pending one and
   *                 redeem it once approved.
   *   `sessions`  — LIVE sessions the caller may revoke: on their own account,
   *                 ones they opened, ones in orgs they administer, and — for a
   *                 sysadmin — any, matching revoke's authority.
   *
   * Never returns `jti`: it identifies a live session token, and revocation works
   * by request id.
   */
  async listForCaller(
    caller: { userId: string; isSysadmin: boolean; adminOrgIds: string[] },
    view: 'to-decide' | 'mine' | 'sessions',
  ): Promise<ImpersonationRequestSummary[]> {
    const now = new Date();
    let filter: Record<string, unknown>;

    if (view === 'to-decide') {
      const who: Record<string, unknown>[] = [
        { breakglass: { $ne: true }, approverUserId: caller.userId },
      ];
      if (caller.adminOrgIds.length > 0) {
        who.push({ breakglass: { $ne: true }, orgId: { $in: caller.adminOrgIds } });
      }
      if (caller.isSysadmin) who.push({ breakglass: true });
      filter = {
        status: 'pending',
        expiresAt: { $gt: now },
        requesterId: { $ne: caller.userId }, // nobody decides their own request
        $or: who,
      };
    } else if (view === 'mine') {
      filter = { requesterId: caller.userId };
    } else {
      // A `consumed` row stays consumed forever, but its token dies after the
      // session TTL. Without this bound the list would offer to "revoke" sessions
      // that ended long ago.
      const liveSince = new Date(now.getTime() - IMPERSONATION_SESSION_TTL_MS);
      const who: Record<string, unknown>[] = [
        { targetUserId: caller.userId },
        { requesterId: caller.userId },
      ];
      if (caller.adminOrgIds.length > 0) who.push({ orgId: { $in: caller.adminOrgIds } });
      filter = {
        status: 'consumed',
        consumedAt: { $gte: liveSince },
        ...(caller.isSysadmin ? {} : { $or: who }),
      };
    }

    const docs = await ImpersonationRequest.find(filter)
      .sort({ createdAt: -1 })
      .limit(LIST_LIMIT)
      .select('-jti')
      .lean();

    // Resolve display names in one query rather than one per row.
    const userIds = [...new Set(docs.flatMap((d) => [String(d.requesterId), String(d.targetUserId)]))];
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('username email').lean()
      : [];
    const nameOf = new Map(users.map((u) => [
      String((u as { _id: unknown })._id),
      (u as { username?: string }).username ?? (u as { email?: string }).email ?? 'unknown',
    ]));

    return docs.map((d) => ({
      id: String(d._id),
      // Report a request whose window has passed as `expired` NOW, rather than
      // waiting for the reaper to rewrite the row. Otherwise the requester sees
      // "Waiting for approval" on something that can no longer be approved, or
      // "Approved — ready to open" on something that can no longer be opened.
      status: effectiveStatus(d.status, d.expiresAt, now),
      breakglass: d.breakglass === true,
      approvalReason: d.approvalReason,
      approverMode: d.approverMode,
      orgId: d.orgId,
      reason: d.reason,
      requester: { id: String(d.requesterId), name: nameOf.get(String(d.requesterId)) ?? 'unknown' },
      target: { id: String(d.targetUserId), name: nameOf.get(String(d.targetUserId)) ?? 'unknown' },
      createdAt: d.createdAt,
      expiresAt: d.expiresAt,
      consumedAt: d.consumedAt,
      decidedAt: d.decidedAt,
    }));
  }

  /**
   * Mark a pending request as undeliverable: its challenge reached nobody.
   *
   * Distinct from `expired` on purpose. A request left `pending` after every
   * notification failed would sit for its full hour and then expire — which the
   * operator reads as "they said no". Surfacing it immediately tells them the
   * truth: nobody was ever asked.
   */
  async markUndeliverable(requestId: string): Promise<void> {
    await ImpersonationRequest.updateOne(
      { _id: requestId, status: 'pending' },
      { $set: { status: 'undeliverable' } },
    );
  }

  /**
   * End a live session early.
   *
   * Only a `consumed` request can be revoked — there is no session to stop
   * before redemption, and a denied or expired one never became one. The auth
   * middleware resolves each impersonated request by `jti` and requires status
   * `consumed`, so flipping it here takes effect on the very next request rather
   * than waiting out the token's TTL.
   */
  async revoke(
    requestId: string,
    actorId: string,
  ): Promise<{ ok: true; request: ImpersonationRequestDocument } | { ok: false; code: string }> {
    const now = new Date();
    const updated = await ImpersonationRequest.findOneAndUpdate(
      { _id: requestId, status: 'consumed' },
      { $set: { status: 'revoked', revokedBy: actorId, revokedAt: now } },
      { new: true },
    );
    if (updated) return { ok: true, request: updated };

    const current = await ImpersonationRequest.findById(requestId).lean();
    if (!current) return { ok: false, code: IMP_NOT_FOUND };
    // Already revoked, or never redeemed — either way there is no live session.
    return { ok: false, code: IMP_NOT_LIVE };
  }
}

export const impersonationService = new ImpersonationService();
