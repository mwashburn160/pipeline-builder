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
 * BEFORE executing, so two managers can never both execute one request; a
 * failed execution rolls the status back.
 */

import { actorId, ConflictError, ErrorCode } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { OFFICIAL_PUBLISHER_HANDLE, type PluginPublishRequest, type Publisher, type PublishRequestStatus } from '@pipeline-builder/pipeline-data';

import { discardDraft } from './advisories.js';
import { ecosystemAudit, type PluginAuditAction } from './audit.js';
import { conflictOfInterest } from './conflict.js';
import { can, EcosystemError, type Caller } from './context.js';
import { execute } from './execute.js';
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

async function assertNoConflict(moderator: Caller, r: Req, publisher: Publisher): Promise<void> {
  const plugin = r.pluginId && publisher.handle === OFFICIAL_PUBLISHER_HANDLE ? await plugins.byId(r.pluginId) : null;
  const c = await conflictOfInterest(moderator, r, publisher, { deep: true, plugin });
  if (c.conflict) {
    incCounter('ecosystem_separation_of_duties_refused_total', { kind: r.kind });
    throw new EcosystemError(ErrorCode.SEPARATION_OF_DUTIES, c.reason!);
  }
}

/** Run an approved request, rolling the status back to `from` when execution refuses. */
async function executeClaimed(claimed: Req, from: PublishRequestStatus, rollback: Partial<Req>, publisher: Publisher, moderator: Caller): Promise<void> {
  try {
    await execute(claimed, publisher, actorId({ userId: moderator.userId }), { human: true });
  } catch (err) {
    const current = await requests.byId(claimed.id);
    // A quota refusal already recorded the request as rejected; leave it.
    if (current?.status === 'approved') await requests.transition(claimed.id, 'approved', { status: from, ...rollback });
    throw err;
  }
}

/**
 * POST /ecosystem/requests/:id/approve — the first (or only) approval. A
 * two-person request moves to `pending_second_approval` (N28); anything else
 * executes now.
 */
export async function approve(moderator: Caller, id: string, note: string | null): Promise<{ request: Req; executed: boolean }> {
  const { r, publisher } = await loadForDecision(moderator, id);
  if (r.status === 'pending_second_approval') throw new ConflictError('This request already has its first approval; use second-approve.');
  if (r.status !== 'pending') throw new ConflictError(`This request is ${r.status}.`);
  await assertNoConflict(moderator, r, publisher);
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

  const claimed = await requests.transition(r.id, 'pending', { status: 'approved', decidedBy: moderator.userId, decidedAt: new Date(), ...(note ? { reason: note } : {}) });
  if (!claimed) throw new ConflictError('The request was decided by someone else.');
  await executeClaimed(claimed, 'pending', { decidedBy: null, decidedAt: null, reason: r.reason }, publisher, moderator);
  ecosystemAudit({ action: 'plugin.request.approve', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'plugin-publish-request', targetId: r.id, details: { kind: r.kind, ...(r.version ? { version: r.version } : {}), ...(r.digest ? { digest: r.digest } : {}) } });
  await notifyDecision({ kind: r.kind, title, publisherOrgId: publisher.ownerOrgId, approved: true, reason: note });
  return { request: (await requests.byId(r.id))!, executed: true };
}

/** POST /ecosystem/requests/:id/second-approve — the second of two approvals, by a DIFFERENT manager. */
export async function secondApprove(moderator: Caller, id: string, note: string | null): Promise<{ request: Req; executed: true }> {
  const { r, publisher } = await loadForDecision(moderator, id);
  if (r.status !== 'pending_second_approval') throw new ConflictError('This request is not waiting for a second approval.');
  // conflictOfInterest refuses the first approver (and the submitter/uploader).
  await assertNoConflict(moderator, r, publisher);
  const claimed = await requests.transition(r.id, 'pending_second_approval', {
    status: 'approved', secondApprovedBy: moderator.userId, decidedBy: moderator.userId, decidedAt: new Date(),
  });
  if (!claimed) throw new ConflictError('The request was decided by someone else.');
  await executeClaimed(claimed, 'pending_second_approval', { secondApprovedBy: null, decidedBy: null, decidedAt: null }, publisher, moderator);
  const actor = actorId({ userId: moderator.userId });
  ecosystemAudit({ action: 'plugin.request.second-approve', actor, affectedOrgId: publisher.ownerOrgId, targetType: 'plugin-publish-request', targetId: r.id, details: { kind: r.kind, firstApprovedBy: r.firstApprovedBy, ...(note ? { note: note.slice(0, 200) } : {}) } });
  await notifyDecision({ kind: r.kind, title: await titleOfRequest(r, publisher), publisherOrgId: publisher.ownerOrgId, approved: true, reason: note });
  return { request: (await requests.byId(r.id))!, executed: true };
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
  await assertNoConflict(moderator, { ...r, status: 'pending' }, publisher);
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
