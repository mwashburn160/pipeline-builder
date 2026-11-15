// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deciding publish requests (docs/plugin-publishing.md):
 *
 *  - separation of duties: no manager decides a request from an org
 *    they belong to, the uploader never approves their own Official version,
 *    and the two approvals of a two-person decision come from two identities;
 *  - two-person approval: the first approval parks the request in
 *    `pending_second_approval` (N28), the second executes it;
 *  - execution per kind — approval of a new listing / version publishes the
 *    PINNED digest into `public/<publisher>/<name>` with a fresh tier-annotated
 *    signature and records the frozen version;
 *  - automatic decisions: the one-time BOOTSTRAP exception for the initial
 *    Official catalog and the system-org auto-approval rules.
 *
 * Every decision claims the request with an optimistic status transition
 * BEFORE executing, so two managers can never both execute one request. The
 * execution itself runs in execution.ts: the decision waits for it briefly,
 * a refusal rolls the status back, and a slow or transiently failing one
 * carries on in the background with the claim kept.
 */

import { isOfficialPublisher } from './util.js';
import { actorId, ConflictError, ErrorCode } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { type PluginPublishRequest, type Publisher } from '@pipeline-builder/pipeline-data';

import { discardDraft } from './advisories.js';
import { ecosystemAudit, type PluginAuditAction } from './audit.js';
import { conflictOfInterest } from './conflict.js';
import { can, EcosystemError, type Caller } from './context.js';
import { claimPayload, executeClaimNow, type InlineResult } from './execution.js';
import {
  notifyDecision, notifySecondApprovalNeeded, notifyTransferUpdate, titleOfRequest,
} from './notify.js';
import { needsTwoPerson, requiredDecisionPermission } from './policy.js';
import { OPEN_STATUSES, plugins, publishers, requests, versions } from './store.js';
import { rejectSubmission } from './submission-moderation.js';
import { assertVerifiedEligible, checkVerifiedEligibility } from './verified-eligibility.js';


type Req = PluginPublishRequest;
const payloadOf = (r: Req) => (r.payload ?? {}) as Record<string, unknown>;

// -----------------------------------------------------------------------------
// Manager decisions
// -----------------------------------------------------------------------------

async function loadForDecision(moderator: Caller, id: string): Promise<{ r: Req; publisher: Publisher }> {
  const r = await requests.byId(id);
  if (!r) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Request not found');
  const permission = requiredDecisionPermission(r.kind, r.payload);
  if (!can(moderator, permission)) {
    throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, `Deciding ${r.kind} requests needs ${permission}.`);
  }
  const publisher = await publishers.byId(r.publisherId);
  if (!publisher) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Publisher not found');
  return { r, publisher };
}

async function assertNoConflict(moderator: Caller, r: Req, publisher: Publisher, attempted: PluginAuditAction): Promise<void> {
  // Shared predicate: the console RENDERS this same conflict and used to key
  // on `ownerOrgId === SYSTEM_ORG_ID` while this ENFORCED on the handle.
  const plugin = r.pluginId && isOfficialPublisher(publisher) ? await plugins.byId(r.pluginId) : null;
  const c = await conflictOfInterest(moderator, r, publisher, { deep: true, plugin });
  if (c.conflict) {
    incCounter('ecosystem_separation_of_duties_refused_total', { kind: r.kind });
    // The refused decision goes on the trail as a FAILED attempt of what was
    // tried: a manager deciding their own org's request (or approving twice) is
    // the exact event separation of duties exists to catch, and the refusal
    // otherwise leaves only an error response behind.
    ecosystemAudit({
      action: attempted,
      actor: actorId({ userId: moderator.userId }),
      orgId: moderator.orgId,
      affectedOrgId: publisher.ownerOrgId,
      targetType: 'plugin-publish-request',
      targetId: r.id,
      outcome: 'failure',
      details: { kind: r.kind, refusal: ErrorCode.SEPARATION_OF_DUTIES, reason: c.reason?.slice(0, 200) ?? null },
    });
    throw new EcosystemError(ErrorCode.SEPARATION_OF_DUTIES, c.reason!);
  }
}

/** What a decision route answers: the request, and whether its execution has finished. */
export interface DecisionResult {
  request: Req;
  executed: boolean;
  /** Set when it hasn't: still publishing, or retrying after a transient failure. */
  executing?: Exclude<InlineResult, { executed: true }>['reason'];
  error?: string;
}

function decisionResult(request: Req, result: InlineResult): DecisionResult {
  return result.executed
    ? { request, executed: true }
    : { request, executed: false, executing: result.reason, ...(result.error ? { error: result.error } : {}) };
}

/**
 * POST /ecosystem/requests/:id/approve — the first (or only) approval. A
 * two-person request moves to `pending_second_approval` (N28); anything else
 * executes now (see execution.ts for one that outlasts the request).
 */
export async function approve(moderator: Caller, id: string, note: string | null): Promise<DecisionResult> {
  const { r, publisher } = await loadForDecision(moderator, id);
  if (r.status === 'pending_second_approval') throw new ConflictError('This request already has its first approval; use second-approve.');
  if (r.status !== 'pending') throw new ConflictError(`This request is ${r.status}.`);
  await assertNoConflict(moderator, r, publisher, 'plugin.request.approve');
  const actor = actorId({ userId: moderator.userId });
  const title = await titleOfRequest(r, publisher);

  if (r.kind === 'verify') assertVerifiedEligible(await checkVerifiedEligibility(publisher.ownerOrgId ?? ''), 'decision');
  if (needsTwoPerson(r.kind, publisher.tier)) {
    const parked = await requests.transition(r.id, 'pending', { status: 'pending_second_approval', firstApprovedBy: moderator.userId, ...(note ? { reason: note } : {}) });
    if (!parked) throw new ConflictError('The request was decided by someone else.');
    ecosystemAudit({ action: 'plugin.request.approve', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'plugin-publish-request', targetId: r.id, details: { kind: r.kind, firstOfTwo: true } });
    await notifySecondApprovalNeeded({ title, firstApprover: moderator.userId, submittedOrgId: r.submittedOrgId, permission: requiredDecisionPermission(r.kind, r.payload) });
    return { request: parked, executed: false };
  }

  const claimed = await requests.transition(r.id, 'pending', {
    status: 'approved',
    decidedBy: moderator.userId,
    decidedAt: new Date(),
    ...(note ? { reason: note } : {}),
    payload: claimPayload(r, { flavor: 'approve', actor, note, priorReason: r.reason }),
  });
  if (!claimed) throw new ConflictError('The request was decided by someone else.');
  // The audit entry and the publisher's notice follow the execution (execution.ts).
  const result = await executeClaimNow(claimed.id);
  return decisionResult((await requests.byId(r.id))!, result);
}

/** POST /ecosystem/requests/:id/second-approve — the second of two approvals, by a DIFFERENT manager. */
export async function secondApprove(moderator: Caller, id: string, note: string | null): Promise<DecisionResult> {
  const { r, publisher } = await loadForDecision(moderator, id);
  if (r.status !== 'pending_second_approval') throw new ConflictError('This request is not waiting for a second approval.');
  // conflictOfInterest refuses the first approver (and the submitter/uploader).
  await assertNoConflict(moderator, r, publisher, 'plugin.request.second-approve');
  const claimed = await requests.transition(r.id, 'pending_second_approval', {
    status: 'approved',
    secondApprovedBy: moderator.userId,
    decidedBy: moderator.userId,
    decidedAt: new Date(),
    payload: claimPayload(r, { flavor: 'second-approve', actor: actorId({ userId: moderator.userId }), note }),
  });
  if (!claimed) throw new ConflictError('The request was decided by someone else.');
  const result = await executeClaimNow(claimed.id);
  return decisionResult((await requests.byId(r.id))!, result);
}

/** Clear a version's request freeze once nothing open references it and it isn't listed. */
export async function releaseFreeze(pluginId: string | null): Promise<void> {
  if (!pluginId) return;
  const open = await requests.list({ pluginId, statuses: OPEN_STATUSES, limit: 1 });
  if (open.length > 0) return;
  if ((await versions.bySourcePlugins([pluginId])).length > 0) return;
  await plugins.unfreeze(pluginId);
}

/** POST /ecosystem/requests/:id/reject — decline with a reason (N25 / N7 / N10). */
export async function reject(moderator: Caller, id: string, reason: string): Promise<Req> {
  const { r, publisher } = await loadForDecision(moderator, id);
  if (!OPEN_STATUSES.includes(r.status)) throw new ConflictError(`This request is ${r.status}.`);
  await assertNoConflict(moderator, { ...r, status: 'pending' }, publisher, 'plugin.request.reject');
  const rejected = await requests.transition(r.id, r.status, { status: 'rejected', reason, decidedBy: moderator.userId, decidedAt: new Date() });
  if (!rejected) throw new ConflictError('The request was decided by someone else.');
  await releaseFreeze(r.pluginId);
  await discardDraft(r);
  const actor = actorId({ userId: moderator.userId });
  ecosystemAudit({ action: 'plugin.request.reject', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'plugin-publish-request', targetId: r.id, details: { kind: r.kind, reason: reason.slice(0, 200) } });
  if (r.kind === 'submission') await rejectSubmission(r, reason, actor);
  const extra: Record<string, PluginAuditAction> = {
    verify: 'publisher.verify.reject', transfer: 'publisher.transfer.reject', profile_change: 'publisher.profile-change.reject',
  };
  if (extra[r.kind]) ecosystemAudit({ action: extra[r.kind]!, actor, affectedOrgId: publisher.ownerOrgId, targetType: 'publisher', targetId: publisher.id, details: { requestId: r.id } });
  const title = await titleOfRequest(r, publisher);
  if (r.kind === 'transfer') {
    const t = payloadOf(r).transfer as { targetOrgId?: string } | undefined;
    await notifyTransferUpdate({ orgIds: [publisher.ownerOrgId, t?.targetOrgId ?? null], title, outcome: 'rejected' });
  } else {
    await notifyDecision({ kind: r.kind, title, publisherOrgId: publisher.ownerOrgId, approved: false, reason });
  }
  return rejected;
}
