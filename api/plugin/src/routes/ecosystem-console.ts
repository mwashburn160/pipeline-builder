// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SYSTEM-ORG ecosystem governance routes — the Ecosystem console's API
 * (docs/plugin-publishing.md).
 * Mounted at `/plugins/ecosystem`. EVERY route runs `requireEcosystemPermission`
 * (active org = the system org + the permission + an aal2 session); the
 * route-coverage governance check fails any that doesn't.
 *
 * Step-up: suspensions, yanks, rule changes and every
 * `publishers:verify` action. Deciding a request needs step-up only for the
 * sensitive kinds (yank, transfer, claim, profile change, Verified,
 * moderation) — `stepUpForSensitiveRequest` looks the kind up first.
 */

import { audited, ErrorCode, requireEcosystemPermission, requireStepUp, sendSuccess, STEP_UP_REQUEST_KINDS } from '@pipeline-builder/api-core';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { bodyOf, ecosystemRoute, param } from './ecosystem-route.js';
import { attachmentDisposition } from '../helpers/content-disposition.js';
import {
  consoleAdvisories, createModeratorDraft, editDraft, setListedVersionDeprecation, withdrawAdvisory,
} from '../services/ecosystem/advisories.js';
import {
  approveRuleChange, asQueueItem, createRule, deleteReserved, deleteRule, listListings, listPublishers, listReserved, listRules, overview, putReserved,
  queue, requestDetail, resignAll, setListingState, setPublisherTier, suspendPublisher, unsuspendPublisher, unyankVersion, updateRule, yankVersion,
} from '../services/ecosystem/console.js';
import { EcosystemError } from '../services/ecosystem/context.js';
import { approve, reject, secondApprove } from '../services/ecosystem/decisions.js';
import { recordDecision } from '../services/ecosystem/metrics.js';
import { holdReview, releaseReview, removeReply, removeReview, reviewQueue, reviewQueueCounts } from '../services/ecosystem/review-moderation.js';
import { requests } from '../services/ecosystem/store.js';
import { submissionSbom, submissionScan } from '../services/ecosystem/submission-moderation.js';

/** Require a step-up only when the request being decided is of a sensitive kind. */
async function stepUpForSensitiveRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  const r = await requests.byId(String(req.params.id ?? '')).catch(() => null);
  if (r && STEP_UP_REQUEST_KINDS.includes(r.kind)) {
    await (requireStepUp as (q: Request, s: Response, n: NextFunction) => Promise<void>)(req, res, next);
    return;
  }
  next();
}

function noteOf(req: Request): string | null {
  const note = bodyOf(req).note;
  return typeof note === 'string' && note.trim() ? note.trim().slice(0, 1000) : null;
}

/** Build the console router. */
export function createEcosystemConsoleRoutes(): Router {
  const router = Router();
  const any = requireEcosystemPermission('plugins:moderate', 'publishers:verify');
  const moderate = requireEcosystemPermission('plugins:moderate');
  const verify = requireEcosystemPermission('publishers:verify');
  const stepUp = requireStepUp as RequestHandler;
  const a = (...actions: string[]) => audited(...actions) as RequestHandler;

  // -- Overview + queue ------------------------------------------------------
  router.get('/overview', ...any, ecosystemRoute(async ({ res }) => {
    sendSuccess(res, 200, { ...(await overview()), reviews: await reviewQueueCounts() });
  }));

  router.get('/requests', ...any, ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await queue(caller, req.query as Record<string, unknown>));
  }));

  router.get('/requests/:id', ...any, ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await requestDetail(caller, param(req, 'id')));
  }));

  // An anonymous submission's quarantined build: its signed SBOM, and a
  // grype report run now over it — the evidence behind the gate report.
  // Both are file downloads (the console's download buttons).
  router.get('/requests/:id/submission-sbom', ...moderate, ecosystemRoute(async ({ req, res }) => {
    const id = param(req, 'id');
    const sbom = await submissionSbom(id);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', attachmentDisposition(`submission-${id}.spdx.json`));
    res.status(200).type('application/spdx+json').send(JSON.stringify(sbom));
  }));

  router.get('/requests/:id/submission-scan', ...moderate, ecosystemRoute(async ({ req, res }) => {
    const id = param(req, 'id');
    const scan = await submissionScan(id);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', attachmentDisposition(`submission-${id}-scan.json`));
    res.status(200).type('application/json').send(JSON.stringify(scan));
  }));

  router.post('/requests/:id/approve', ...any, stepUpForSensitiveRequest as RequestHandler,
    a('plugin.request.approve', 'plugin.listing.publish', 'plugin.listing.update', 'plugin.listing.unpause', 'plugin.version.yank',
      'publisher.verify.approve', 'publisher.tier.change', 'publisher.transfer.approve', 'publisher.profile-change.approve', 'plugin.advisory.publish',
      'plugin.submission.claim'),
    ecosystemRoute(async ({ req, res, caller }) => {
      const out = await approve(caller, param(req, 'id'), noteOf(req));
      recordDecision(out.request, out.executed ? 'approved' : 'first_approval');
      sendSuccess(res, 200, { request: await asQueueItem(caller, out.request), executed: out.executed });
    }));

  router.post('/requests/:id/second-approve', ...any, stepUpForSensitiveRequest as RequestHandler,
    a('plugin.request.second-approve', 'plugin.listing.publish', 'plugin.version.unyank', 'publisher.unsuspend', 'publisher.tier.change', 'plugin.listing.state.change',
      'plugin.submission.approve'),
    ecosystemRoute(async ({ req, res, caller }) => {
      const out = await secondApprove(caller, param(req, 'id'), noteOf(req));
      recordDecision(out.request, 'second_approval');
      sendSuccess(res, 200, { request: await asQueueItem(caller, out.request), executed: true });
    }));

  router.post('/requests/:id/reject', ...any, a('plugin.request.reject', 'publisher.verify.reject', 'publisher.transfer.reject', 'publisher.profile-change.reject',
    'plugin.submission.reject'),
  ecosystemRoute(async ({ req, res, caller }) => {
    const reason = bodyOf(req).reason;
    if (typeof reason !== 'string' || reason.trim() === '') throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, 'reason is required');
    const rejected = await reject(caller, param(req, 'id'), reason.trim().slice(0, 1000));
    recordDecision(rejected, 'rejected');
    sendSuccess(res, 200, { request: await asQueueItem(caller, rejected) });
  }));

  // -- Publishers ------------------------------------------------------------
  router.get('/publishers', ...any, ecosystemRoute(async ({ req, res }) => {
    sendSuccess(res, 200, { publishers: await listPublishers(req.query as Record<string, unknown>) });
  }));

  router.post('/publishers/:id/suspend', ...verify, stepUp, a('publisher.suspend'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, { publisher: await suspendPublisher(caller, param(req, 'id'), bodyOf(req)) });
  }));

  router.post('/publishers/:id/unsuspend', ...verify, stepUp, a('plugin.request.submit', 'plugin.request.approve'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, { request: await unsuspendPublisher(caller, param(req, 'id'), bodyOf(req)) });
  }));

  router.post('/publishers/:id/tier', ...verify, stepUp, a('publisher.tier.change', 'plugin.request.submit', 'plugin.request.approve'),
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, await setPublisherTier(caller, param(req, 'id'), bodyOf(req)));
    }));

  // -- Listings --------------------------------------------------------------
  router.get('/listings', ...moderate, ecosystemRoute(async ({ req, res }) => {
    sendSuccess(res, 200, { listings: await listListings(req.query as Record<string, unknown>) });
  }));

  router.post('/listings/:id/state', ...moderate, stepUp, a('plugin.listing.state.change', 'plugin.request.submit', 'plugin.request.approve'),
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, await setListingState(caller, param(req, 'id'), bodyOf(req)));
    }));

  router.post('/listings/:id/versions/:version/yank', ...moderate, stepUp, a('plugin.version.yank'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, { listing: await yankVersion(caller, param(req, 'id'), param(req, 'version'), bodyOf(req)) });
  }));

  router.post('/listings/:id/versions/:version/unyank', ...moderate, stepUp, a('plugin.request.submit', 'plugin.request.approve'),
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, { request: await unyankVersion(caller, param(req, 'id'), param(req, 'version'), bodyOf(req)) });
    }));

  router.post('/listings/:id/versions/:version/deprecate', ...moderate, stepUp, a('plugin.version.deprecate'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, { listing: await setListedVersionDeprecation(caller, param(req, 'id'), param(req, 'version'), bodyOf(req)) });
  }));

  // -- Security advisories — publishing a draft = approving its `advisory` request.
  router.get('/advisories', ...moderate, ecosystemRoute(async ({ req, res }) => {
    sendSuccess(res, 200, { advisories: await consoleAdvisories(req.query as Record<string, unknown>) });
  }));

  router.post('/advisories', ...moderate, stepUp, a('plugin.advisory.create'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 201, await createModeratorDraft(caller, bodyOf(req)));
  }));

  router.patch('/advisories/:id', ...moderate, stepUp, a('plugin.advisory.update'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, { advisory: await editDraft(caller, param(req, 'id'), bodyOf(req)) });
  }));

  router.post('/advisories/:id/withdraw', ...moderate, stepUp, a('plugin.advisory.withdraw'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, { advisory: await withdrawAdvisory(caller, param(req, 'id'), bodyOf(req)) });
  }));

  // Re-sign every public/* image (after a plugin-signing key rotation).
  router.post('/resign', ...moderate, stepUp, a('registry.image.resign'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await resignAll(caller, bodyOf(req)));
  }));

  // -- Auto-approval rules ---------------------------------------------------
  router.get('/rules', ...moderate, ecosystemRoute(async ({ res }) => { sendSuccess(res, 200, { rules: await listRules() }); }));

  router.post('/rules', ...moderate, stepUp, a('ecosystem.auto-approval-rule.create'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 201, { rule: await createRule(caller, bodyOf(req)) });
  }));

  router.patch('/rules/:id', ...moderate, stepUp, a('ecosystem.auto-approval-rule.update'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, { rule: await updateRule(caller, param(req, 'id'), bodyOf(req)) });
  }));

  router.post('/rules/:id/approve-change', ...moderate, stepUp, a('ecosystem.auto-approval-rule.update'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, { rule: await approveRuleChange(caller, param(req, 'id')) });
  }));

  router.delete('/rules/:id', ...moderate, stepUp, a('ecosystem.auto-approval-rule.delete'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await deleteRule(caller, param(req, 'id')));
  }));

  // -- Review moderation ---------------------------------------------
  router.get('/reviews', ...moderate, ecosystemRoute(async ({ req, res }) => {
    sendSuccess(res, 200, await reviewQueue(req.query as Record<string, unknown>));
  }));

  router.post('/reviews/:id/hold', ...moderate, a('plugin.review.hold'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await holdReview(caller, param(req, 'id'), bodyOf(req)));
  }));

  router.post('/reviews/:id/release', ...moderate, a('plugin.review.release'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await releaseReview(caller, param(req, 'id'), bodyOf(req)));
  }));

  router.post('/reviews/:id/remove', ...moderate, a('plugin.review.remove'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await removeReview(caller, param(req, 'id'), bodyOf(req)));
  }));

  router.post('/reviews/:id/remove-reply', ...moderate, a('plugin.review.reply.delete'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await removeReply(caller, param(req, 'id'), bodyOf(req)));
  }));

  // -- Reserved names --------------------------------------------------------
  router.get('/reserved-names', ...moderate, ecosystemRoute(async ({ res }) => { sendSuccess(res, 200, { names: await listReserved() }); }));

  router.put('/reserved-names/:name', ...moderate, a('ecosystem.reserved-name.update'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await putReserved(caller, param(req, 'name'), bodyOf(req)));
  }));

  router.delete('/reserved-names/:name', ...moderate, a('ecosystem.reserved-name.update'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await deleteReserved(caller, param(req, 'name')));
  }));

  return router;
}
