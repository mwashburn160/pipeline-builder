// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Signed-in review routes (docs/plugin-publishing.md). The
 * anonymous read is `GET /public/plugins/:publisher/:name/reviews`.
 *
 *   GET /plugins/listings/:publisher/:name/review-state plugins:read
 *   POST /plugins/listings/:publisher/:name/reviews plugins:read + person write a review
 *   PATCH /plugins/reviews/:id plugins:read + person the author edits
 *   DELETE /plugins/reviews/:id plugins:read + person the author deletes
 *   PUT /plugins/reviews/:id/helpful plugins:read + person vote (not audited)
 *   DELETE /plugins/reviews/:id/helpful plugins:read + person
 *   POST /plugins/reviews/:id/report plugins:read + person abuse / security report
 *   PUT /plugins/reviews/:id/reply publishers:manage + person the publisher's one reply
 *   DELETE /plugins/reviews/:id/reply publishers:manage + person
 *
 * "person" = a HUMAN SESSION (`requireAssurance({ minAssurance: 1 })`): service
 * accounts and exchanged access keys are refused `HUMAN_SESSION_REQUIRED`.
 * Every write is throttled per user and per org; a NEW review also per
 * trusted client IP (20 a day) — the per-org daily cap is counted in the
 * service.
 */

import { audited, requireAssurance, requirePermission, sendSuccess, envInt } from '@pipeline-builder/api-core';
import { rateLimitByOrg } from '@pipeline-builder/api-server';
import { Router, type RequestHandler } from 'express';

import { bodyOf, ecosystemRoute, param } from './ecosystem-route.js';
import {
  createReview, deleteReply, deleteReview, putReply, reportReview, reviewState, setHelpful, updateReview,
} from '../services/ecosystem/reviews.js';

const DAY_MS = 24 * 3_600_000;

/** Build the review router (mounted at `/plugins`, behind the shared auth + org chain). */
export function createReviewRoutes(): Router {
  const router = Router();
  const read = requirePermission('plugins:read') as RequestHandler;
  const person = requireAssurance({ minAssurance: 1 }) as RequestHandler;
  const perUser = rateLimitByOrg({ name: 'review-write-user', keyBy: 'user', max: envInt('REVIEW_WRITE_RATE_LIMIT_PER_MIN', 30, { min: 1 }), windowMs: 60_000 }) as RequestHandler;
  const perOrg = rateLimitByOrg({ name: 'review-write-org', max: envInt('REVIEW_ORG_WRITE_RATE_LIMIT_PER_MIN', 120, { min: 1 }), windowMs: 60_000 }) as RequestHandler;
  const perIpDaily = rateLimitByOrg({
    name: 'review-create-ip',
    keyBy: 'ip',
    max: envInt('REVIEW_IP_DAILY_LIMIT', 20, { min: 1 }),
    windowMs: DAY_MS,
    message: 'Too many new reviews from this network today.',
  }) as RequestHandler;
  const write = [person, perUser, perOrg];
  const a = (...actions: string[]) => audited(...actions) as RequestHandler;

  router.get('/listings/:publisher/:name/review-state', read, ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await reviewState(caller, param(req, 'publisher'), param(req, 'name')));
  }));

  router.post('/listings/:publisher/:name/reviews', read, ...write, perIpDaily, a('plugin.review.create'),
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 201, await createReview(caller, param(req, 'publisher'), param(req, 'name'), bodyOf(req)));
    }));

  router.patch('/reviews/:id', read, ...write, a('plugin.review.update'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await updateReview(caller, param(req, 'id'), bodyOf(req)));
  }));

  router.delete('/reviews/:id', read, ...write, a('plugin.review.delete'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await deleteReview(caller, param(req, 'id')));
  }));

  router.put('/reviews/:id/helpful', read, ...write, ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await setHelpful(caller, param(req, 'id'), true));
  }));

  router.delete('/reviews/:id/helpful', read, ...write, ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await setHelpful(caller, param(req, 'id'), false));
  }));

  router.post('/reviews/:id/report', read, ...write, a('plugin.review.report', 'plugin.review.hold'), ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await reportReview(caller, param(req, 'id'), bodyOf(req)));
  }));

  router.put('/reviews/:id/reply', requirePermission('publishers:manage') as RequestHandler, ...write, a('plugin.review.reply.create', 'plugin.review.reply.update'),
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, await putReply(caller, param(req, 'id'), bodyOf(req)));
    }));

  router.delete('/reviews/:id/reply', requirePermission('publishers:manage') as RequestHandler, ...write, a('plugin.review.reply.delete'),
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, await deleteReply(caller, param(req, 'id')));
    }));

  return router;
}
