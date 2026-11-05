// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  actorId,
  audited,
  createLogger,
  ErrorCode,
  errorMessage,
  getParam,
  parsePage,
  recordAudit,
  requireAuth,
  requirePermission,
  requireSystemOrgPermission,
  sendBadRequest,
  sendError,
  sendSuccess,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, type RequestHandler } from 'express';
import { config } from '../config.js';
import { DEFAULT_QUIET_PERIOD_DAYS, frequencyVerdict } from '../helpers/offers-gates.js';
import { measureLift } from '../helpers/offers-outcome.js';
import { runForAccount } from '../helpers/offers-run.js';
import { refuseTeamBilling } from '../helpers/root-org-guard.js';
import { Subscription } from '../models/subscription.js';
import { Offer, type OfferDocument } from '../models/offer.js';
import { OfferExclusion } from '../models/offer-exclusion.js';

const logger = createLogger('billing-offers');
const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

/** Offer rows an account may still act on. */
const LIVE_STATUSES = ['sent'] as const;

/** One offer, as the account's own surface renders it. */
function toOfferResponse(offer: Pick<OfferDocument,
  'offerType' | 'targetTier' | 'targetBundles' | 'rationale' | 'subject' | 'body' | 'sentAt' | 'expiresAt' | 'status' | 'dismissedAt'>
  & { _id: { toString(): string } }) {
  return {
    id: offer._id.toString(),
    offerType: offer.offerType,
    targetTier: offer.targetTier ?? null,
    // WHAT was proposed, so the card can present a basket rather than send the
    // account to assemble it (F6).
    targetBundles: (offer.targetBundles ?? []).map((b) => ({ bundleId: b.bundleId, quantity: b.quantity })),
    // The copy as SENT, read back rather than re-rendered: a card that
    // re-derived from today's catalogue would restate last month's offer at
    // this month's price.
    subject: offer.subject ?? null,
    body: offer.body ?? null,
    // The signals, verbatim. Shown to the account because "you are at 9 of 10
    // pipelines" is the argument, and hiding it would make the offer read as a
    // guess rather than as a reading of their own usage.
    rationale: offer.rationale,
    status: offer.status,
    sentAt: offer.sentAt?.toISOString() ?? null,
    expiresAt: offer.expiresAt?.toISOString() ?? null,
    dismissedAt: offer.dismissedAt?.toISOString() ?? null,
  };
}

/**
 * The expansion-offer surfaces (docs/plans/sales-agent.md F4, F7, F8).
 *
 * **Served by billing, not by the offers process (D13).** The decision engine is
 * internal only and exposes no customer-facing route of its own; everything a
 * customer or an admin sees is here, beside the add-on and discount surfaces
 * they already use. An account should never have to learn that a separate
 * component decided this.
 *
 * Three groups:
 *  - the ACCOUNT's own surface — read the live offer, decline it, dismiss it;
 *  - the account's CONSENT state, which the settings card needs in order to
 *    explain a quiet period rather than look broken;
 *  - the SYSTEM-ORG surface — the per-reason suppression counts, the
 *    do-not-offer veto, and the manual trigger.
 *
 * **Decline and dismiss are different verbs and the distinction is the point.**
 * Redemption was the only action before this, so "never saw it" and "said no"
 * were the same row — and D6's lengthened window after a decline is
 * unimplementable without telling them apart. Dismissal is server-side for the
 * same reason the cap is: a `localStorage` dismissal is per-browser, so the same
 * offer reappears on a laptop.
 */
export function createOfferRoutes(): Router {
  const router: Router = Router();

  /**
   * GET /billing/offers — the account's live offer, plus the state the settings
   * card needs to explain itself.
   *
   * Returns `offer: null` rather than a 404 when there is none: "no offer right
   * now" is the normal state of an account, not an error, and a 404 would make
   * the card render an error for the overwhelmingly common case.
   *
   * `quietUntil` is here rather than on a second route because F7 requires the
   * card to show the quiet period's state — an account with offers ENABLED and
   * simply inside its 45 days should see that rather than wonder whether the
   * switch works.
   */
  router.get('/offers', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:read') as RequestHandler, withRoute(async ({ res, orgId }) => {
    const now = new Date();
    const [live, lastSent] = await Promise.all([
      Offer.findOne({
        orgId,
        status: { $in: [...LIVE_STATUSES] },
        dismissedAt: { $exists: false },
        $or: [{ expiresAt: { $gt: now } }, { expiresAt: { $exists: false } }],
      }).sort({ sentAt: -1 }).lean(),
      Offer.findOne({ orgId, sentAt: { $exists: true, $ne: null } }).sort({ sentAt: -1 }).lean(),
    ]);
    const freq = frequencyVerdict({
      lastSentAt: lastSent?.sentAt ?? null,
      lastWasDeclined: lastSent?.status === 'declined',
      now,
    });
    return sendSuccess(res, 200, {
      offer: live ? toOfferResponse(live as never) : null,
      // Null means "nothing is holding this account back" — the card then says
      // so instead of implying a wait that does not exist.
      quietUntil: freq.allowed ? null : (freq.nextAllowedAt?.toISOString() ?? null),
      quietPeriodDays: DEFAULT_QUIET_PERIOD_DAYS,
      /** The DEPLOYMENT switch, so an operator-disabled feature does not look broken. */
      offersEnabledOnInstance: config.offersEnabled && config.enabled,
    });
  }));

  /**
   * POST /billing/offers/:id/decline — "no".
   *
   * The single most valuable thing the outcome log measures (D12), and the input
   * D6's lengthened quiet window runs on. A reason is optional: making it
   * required would push accounts into dismissing instead, which records less.
   */
  router.post(
    '/offers/:id/decline',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requirePermission('billing:manage') as RequestHandler,
    refuseTeamBilling as RequestHandler,
    audited('billing.offer.declined'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const id = getParam(req.params, 'id');
      if (!id) return sendBadRequest(res, 'Offer id is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const reason = typeof (req.body as { reason?: unknown } | undefined)?.reason === 'string'
        ? ((req.body as { reason: string }).reason).slice(0, 500)
        : undefined;

      // Scoped to the caller's own account AND to a still-open offer: declining
      // a redeemed one would rewrite a conversion as a refusal, which is the one
      // direction this log must never move in.
      const offer = await Offer.findOneAndUpdate(
        { _id: id, orgId, status: 'sent' },
        { $set: { status: 'declined', resolvedAt: new Date(), ...(reason ? { declineReason: reason } : {}) } },
        { returnDocument: 'after' },
      ).lean();
      if (!offer) return sendError(res, 404, 'No open offer with that id', ErrorCode.NOT_FOUND);

      recordAudit({
        action: 'billing.offer.declined',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'offer',
        targetId: id,
        // The reason is the account's own words about a commercial offer, not
        // usage data: recorded as given, length-capped above.
        details: { offerType: offer.offerType, ...(reason ? { reason } : {}) },
      });
      ctx.log('COMPLETED', 'Offer declined', { orgId, offerType: offer.offerType });
      return sendSuccess(res, 200, { offer: toOfferResponse(offer as never) }, 'Offer declined');
    }),
  );

  /**
   * POST /billing/offers/:id/dismiss — "not now".
   *
   * Hides the card WITHOUT resolving the offer: it still expires on its own
   * clock, and it does not lengthen the quiet period the way a decline does.
   * Server-side so the dismissal and the frequency cap are one record rather
   * than one record and one browser's memory.
   */
  router.post(
    '/offers/:id/dismiss',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requirePermission('billing:manage') as RequestHandler,
    refuseTeamBilling as RequestHandler,
    audited('billing.offer.dismissed'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const id = getParam(req.params, 'id');
      if (!id) return sendBadRequest(res, 'Offer id is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const offer = await Offer.findOneAndUpdate(
        { _id: id, orgId, status: 'sent' },
        { $set: { dismissedAt: new Date() } },
        { returnDocument: 'after' },
      ).lean();
      if (!offer) return sendError(res, 404, 'No open offer with that id', ErrorCode.NOT_FOUND);

      recordAudit({
        action: 'billing.offer.dismissed',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'offer',
        targetId: id,
        details: { offerType: offer.offerType },
      });
      ctx.log('COMPLETED', 'Offer dismissed', { orgId });
      return sendSuccess(res, 200, { offer: toOfferResponse(offer as never) }, 'Offer dismissed');
    }),
  );

  // -------------------------------------------------------------------------
  // The system-org surface (F8). An automated granter needs its own view.
  // -------------------------------------------------------------------------

  /**
   * GET /billing/admin/offers — what the agent has been doing.
   *
   * The per-reason suppression counts are the headline rather than a detail: a
   * feature suppressing almost everything is misconfigured rather than careful,
   * and that is only visible if every reason is counted separately (D6).
   *
   * Holdout membership is reported as a COUNT beside the rest, because the
   * holdout's whole value is that it was decided before the rules ran — a
   * surface that let it be edited per account would destroy the only control
   * group the feature has.
   */
  router.get(
    '/admin/offers',
    requireAuth(AUTH_OPTS) as RequestHandler,
    ...requireSystemOrgPermission('subscriptions:read'),
    withRoute(async ({ req, res, ctx }) => {
      const { limit, offset } = parsePage(req.query as Record<string, unknown>, { def: 50, max: 200 });
      const [rows, total, byStatus, bySuppression, holdout, lift] = await Promise.all([
        Offer.find({}).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
        Offer.countDocuments({}),
        Offer.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
        Offer.aggregate<{ _id: string | null; count: number }>([
          { $match: { suppressedReason: { $exists: true } } },
          { $group: { _id: '$suppressedReason', count: { $sum: 1 } } },
        ]),
        Offer.countDocuments({ holdout: true }),
        // Offered against holdout. Computed per request rather than cached: the
        // holdout's whole value is that it was fixed before any rule ran, and a
        // stored aggregate is one that can be computed once, wrongly, and then
        // believed.
        measureLift(),
      ]);
      ctx.log('COMPLETED', 'Listed offer decisions', { total, limit, offset });
      return sendSuccess(res, 200, {
        offers: rows.map((r) => ({
          ...toOfferResponse(r as never),
          orgId: r.orgId,
          holdout: r.holdout,
          source: r.source,
          suppressedReason: r.suppressedReason ?? null,
          holdUntil: r.holdUntil?.toISOString() ?? null,
          cycleKey: r.cycleKey,
          createdAt: r.createdAt.toISOString(),
        })),
        total, limit, offset,
        counts: {
          byStatus: Object.fromEntries(byStatus.map((b) => [b._id, b.count])),
          bySuppressionReason: Object.fromEntries(bySuppression.map((b) => [b._id ?? 'unknown', b.count])),
          holdout,
        },
        // `lift` can be NEGATIVE and is reported as computed: it means the
        // accounts we solicited converted LESS than the ones we left alone,
        // which is the finding a holdout exists to be able to produce.
        lift,
        enabled: { billing: config.enabled, offers: config.offersEnabled },
      });
    }, { requireOrgId: false }),
  );

  /** GET /billing/admin/offers/exclusions — the do-not-offer list, with its reasons. */
  router.get(
    '/admin/offers/exclusions',
    requireAuth(AUTH_OPTS) as RequestHandler,
    ...requireSystemOrgPermission('subscriptions:read'),
    withRoute(async ({ res }) => {
      const rows = await OfferExclusion.find({}).sort({ createdAt: -1 }).lean();
      return sendSuccess(res, 200, {
        exclusions: rows.map((r) => ({
          orgId: r.orgId, reason: r.reason, actorId: r.actorId, createdAt: r.createdAt.toISOString(),
        })),
      });
    }, { requireOrgId: false }),
  );

  /**
   * PUT /billing/admin/offers/exclusions/:orgId — veto this account.
   *
   * "The veto is the price of shipping this at all": somebody will know
   * something the signals cannot, and without a way to say "not this one" the
   * first awkward offer becomes an argument for switching the whole feature off
   * — an argument that wins, because it is correct.
   *
   * A REASON is required. A bare list of org ids goes stale the moment whoever
   * added them leaves, and then nobody can tell an expired negotiation from a
   * permanent exclusion.
   */
  router.put(
    '/admin/offers/exclusions/:orgId',
    requireAuth(AUTH_OPTS) as RequestHandler,
    ...requireSystemOrgPermission('subscriptions:manage'),
    audited('billing.offer.exclusion.set'),
    withRoute(async ({ req, res, ctx, userId }) => {
      const target = getParam(req.params, 'orgId');
      if (!target) return sendBadRequest(res, 'orgId is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const raw = (req.body ?? {}) as { reason?: unknown };
      const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
      if (!reason) return sendBadRequest(res, 'A reason is required to exclude an account', ErrorCode.MISSING_REQUIRED_FIELD);

      await OfferExclusion.findOneAndUpdate(
        { orgId: target },
        { $set: { reason: reason.slice(0, 500), actorId: actorId({ userId }) } },
        { upsert: true },
      );
      recordAudit({
        action: 'billing.offer.exclusion.set',
        actorId: actorId({ userId }),
        orgId: SYSTEM_ORG_ID,
        affectedOrgId: target,
        targetType: 'organization',
        targetId: target,
        details: { reason: reason.slice(0, 500) },
      });
      ctx.log('COMPLETED', 'Account excluded from offers', { targetOrgId: target });
      return sendSuccess(res, 200, { orgId: target, reason }, 'Account excluded from offers');
    }, { requireOrgId: false }),
  );

  /** DELETE /billing/admin/offers/exclusions/:orgId — lift the veto. */
  router.delete(
    '/admin/offers/exclusions/:orgId',
    requireAuth(AUTH_OPTS) as RequestHandler,
    ...requireSystemOrgPermission('subscriptions:manage'),
    audited('billing.offer.exclusion.cleared'),
    withRoute(async ({ req, res, ctx, userId }) => {
      const target = getParam(req.params, 'orgId');
      if (!target) return sendBadRequest(res, 'orgId is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const removed = await OfferExclusion.findOneAndDelete({ orgId: target }).lean();
      if (!removed) return sendError(res, 404, 'That account is not excluded', ErrorCode.NOT_FOUND);
      recordAudit({
        action: 'billing.offer.exclusion.cleared',
        actorId: actorId({ userId }),
        orgId: SYSTEM_ORG_ID,
        affectedOrgId: target,
        targetType: 'organization',
        targetId: target,
        details: { previousReason: removed.reason },
      });
      ctx.log('COMPLETED', 'Offer exclusion lifted', { targetOrgId: target });
      return sendSuccess(res, 200, { orgId: target }, 'Offer exclusion lifted');
    }, { requireOrgId: false }),
  );

  /**
   * POST /billing/admin/offers/trigger/:orgId — decide this account NOW.
   *
   * The other half of D6's manual override. It runs the SAME decision path the
   * cycle runs — every gate, the holdout included — rather than forcing an
   * offer: a trigger that bypassed the rules would be a way to mint an offer
   * for an account the rules had just refused, with the agent's name on it.
   *
   * Recorded as `source: 'manual'`, because mixing manual and automated offers
   * silently corrupts the only measurement that matters.
   */
  router.post(
    '/admin/offers/trigger/:orgId',
    requireAuth(AUTH_OPTS) as RequestHandler,
    ...requireSystemOrgPermission('subscriptions:manage'),
    audited('billing.offer.trigger'),
    withRoute(async ({ req, res, ctx, userId }) => {
      const target = getParam(req.params, 'orgId');
      if (!target) return sendBadRequest(res, 'orgId is required', ErrorCode.MISSING_REQUIRED_FIELD);
      if (!config.offersEnabled || !config.enabled) {
        return sendError(res, 409, 'Offers are disabled on this deployment', ErrorCode.SERVICE_UNAVAILABLE);
      }
      const sub = await Subscription.findOne({ orgId: target }).lean();
      if (!sub) return sendError(res, 404, 'That account has no subscription', ErrorCode.NOT_FOUND);

      let outcome: Awaited<ReturnType<typeof runForAccount>> = null;
      try {
        outcome = await runForAccount({
          orgId: target,
          planId: sub.planId,
          interval: sub.interval,
          addons: (sub.addons ?? []).map((a) => ({ bundleId: a.bundleId, quantity: a.quantity })),
        });
      } catch (err) {
        logger.warn('Manual offer trigger failed', { targetOrgId: target, error: errorMessage(err) });
        return sendError(res, 502, 'Could not evaluate that account', ErrorCode.SERVICE_UNAVAILABLE);
      }

      recordAudit({
        action: 'billing.offer.trigger',
        actorId: actorId({ userId }),
        orgId: SYSTEM_ORG_ID,
        affectedOrgId: target,
        targetType: 'organization',
        targetId: target,
        details: {
          status: outcome?.decision.status ?? 'not_evaluated',
          ...(outcome?.decision.reason ? { reason: outcome.decision.reason } : {}),
        },
      });
      ctx.log('COMPLETED', 'Manual offer evaluation', { targetOrgId: target, status: outcome?.decision.status });
      return sendSuccess(res, 200, {
        // Null when the account could not be evaluated at all (no plan, no
        // profile yet) — deliberately not a suppression, which would mean the
        // rules had considered it.
        decision: outcome
          ? {
            status: outcome.decision.status,
            reason: outcome.decision.reason ?? null,
            offerType: outcome.decision.chosen?.offerType ?? null,
            rationale: outcome.decision.chosen?.rationale ?? [],
            holdout: outcome.decision.holdout,
            recorded: outcome.recorded,
            delivered: outcome.delivered ?? null,
          }
          : null,
      });
    }, { requireOrgId: false }),
  );

  return router;
}
