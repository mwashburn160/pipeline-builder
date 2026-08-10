// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Promotions engine — rule-driven usage-credit auto-grants.
 *
 * A promotion AUTO-grants a usage credit when an org hits its trigger, bounded by
 * a campaign budget, realized through the SAME usage-credit machinery
 * (`creditBalanceCents` / `creditLedger`) as discounts. Correctness properties:
 *
 *   1. Atomicity WITHOUT transactions (billing uses none): budget is RESERVED with
 *      an atomic guarded `$inc`, then the grant is applied with an idempotent
 *      guarded `$push`; any failure after the reservation COMPENSATES (`$inc -cents`).
 *      The bias is always UNDER-spend, never OVER-spend.
 *   2. Idempotent per (promotion, org): the `creditLedger.dedupeKey` guard makes a
 *      concurrent double-trigger grant exactly once.
 *   3. Safety invariant: never grant when the provider can't realize a usage credit
 *      (`usageCreditSupport === 'none'`) — warn instead of banking an unrealizable
 *      credit (mirrors the discount/marketplace-credit invariant).
 *
 * `Promotion.spentCents`/`grantsCount` are an ADVISORY cache; the ledger
 * (Σ `promo:<id>` entries) is the source of truth for spend.
 *
 * MUST be called AFTER the caller has persisted the subscription: the engine
 * mutates the subscription via atomic `findOneAndUpdate` (never `.save()`), so a
 * later `subscription.save()` of a stale in-memory copy would clobber the grant.
 */

import { randomUUID } from 'node:crypto';
import { createLogger, emitCounter } from '@pipeline-builder/api-core';
import { config } from '../config.js';
import { createBillingEvent } from './billing-helpers.js';
import { Plan } from '../models/plan.js';
import { Promotion } from '../models/promotion.js';
import type { PromotionDocument, PromotionEvent, PromotionConditions } from '../models/promotion.js';
import { Referral } from '../models/referral.js';
import { Subscription } from '../models/subscription.js';
import type { SubscriptionDocument } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('promotion-engine');

/** Feature flag — promotions are off unless BILLING_PROMOTIONS_ENABLED=true (and discounts on). */
export function promotionsEnabled(): boolean {
  return config.promotions.enabled;
}

/** The context a trigger passes: what the eligible subscription looks like right now. */
export interface PromotionContext {
  tier: string;
  interval: 'monthly' | 'annual';
  /** Current plan price for the interval — the base for a `percent` promo. */
  planPriceCents: number;
  /** True when this is the org's first-ever subscription (for `firstSubscriptionOnly`). */
  isFirstSubscription?: boolean;
  /** Acting user id when a request context exists; absent on cron/system paths. */
  actorId?: string;
}

export interface PromotionGrantResult {
  promotionId: string;
  granted: boolean;
  cents?: number;
  reason?: 'granted' | 'already_granted' | 'budget_exhausted' | 'unrealizable' | 'zero';
}

/** Ledger `discountId` for a promotion grant — provenance handle. */
const ledgerId = (promoId: string): string => `promo:${promoId}`;
/** Per-(promotion, org) idempotency key on the ledger. */
const dedupeKeyFor = (promoId: string, orgId: string): string => `promo:${promoId}:${orgId}`;

/**
 * The atomic filter that reserves `cents` from a promotion's budget: the `$expr`
 * rejects any grant that would exceed `budgetCents` (or `maxGrants`), so a
 * concurrent reservation can never overspend. Paired with `{ $inc: { spentCents,
 * grantsCount } }`; a null result means the budget/cap is exhausted.
 */
function reserveGuard(promo: Pick<PromotionDocument, '_id' | 'maxGrants'>, cents: number): Record<string, unknown> {
  const budgetExpr = { $lte: [{ $add: ['$spentCents', cents] }, '$budgetCents'] };
  return {
    _id: promo._id,
    isActive: true,
    $expr: promo.maxGrants != null ? { $and: [budgetExpr, { $lt: ['$grantsCount', promo.maxGrants] }] } : budgetExpr,
  };
}

/** Subscription statuses that can hold a credit — kept local so this engine has no
 *  heavy import coupling (a promo grant only touches its own + the sub model). */
const MANAGEABLE_STATUSES = ['active', 'trialing', 'past_due'] as const;

/** The account's manageable subscription, or null. Local mirror of discount-helpers'
 *  so this engine (and the promotions route) don't pull that heavy graph. */
export async function loadManageableSubscription(orgId: string): Promise<SubscriptionDocument | null> {
  return Subscription.findOne({ orgId, status: { $in: [...MANAGEABLE_STATUSES] } });
}

/** Resolve a promo's grant magnitude to cents, clamped by any per-org cap. `dollar`
 *  = the value in cents; `percent` = that percent of the current plan price. */
export function promotionCreditCents(
  promo: Pick<PromotionDocument, 'unit' | 'value' | 'perOrgCapCents'>,
  planPriceCents: number,
): number {
  const raw = promo.unit === 'dollar' ? promo.value : Math.round((planPriceCents * promo.value) / 100);
  return promo.perOrgCapCents ? Math.min(raw, promo.perOrgCapCents) : raw;
}

/** Whether `ctx` satisfies every present eligibility predicate. */
export function matchesConditions(conditions: PromotionConditions | undefined, ctx: PromotionContext): boolean {
  if (!conditions) return true;
  if (conditions.tiers?.length && !conditions.tiers.includes(ctx.tier)) return false;
  if (conditions.intervals?.length && !conditions.intervals.includes(ctx.interval)) return false;
  if (conditions.firstSubscriptionOnly && ctx.isFirstSubscription !== true) return false;
  return true;
}

/** Calendar period key for a recurring re-grant — `YYYY` (annual) / `YYYY-MM`
 *  (monthly). Deterministic + idempotent PER PERIOD; keying on this (not a Stripe
 *  invoice id) means a proration / one-off invoice in the same period can't inject a
 *  second grant, and it matches the Marketplace metering path's key format. */
export function recurringPeriodKey(interval: string, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  return interval === 'annual' ? String(y) : `${y}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Active window check (absent bound = open-ended that side). */
function inWindow(promo: PromotionDocument, now: Date): boolean {
  if (promo.startsAt && promo.startsAt > now) return false;
  if (promo.endsAt && promo.endsAt < now) return false;
  return true;
}

/** A per-planId cache over `{ tier, prices }` — shared by the base scans so a
 *  campaign of N orgs on M plans does M plan lookups, not N. */
function makePlanCache() {
  const cache = new Map<string, { tier: string; prices: { monthly: number; annual: number } } | null>();
  return async (planId: string) => {
    if (!cache.has(planId)) {
      const p = await Plan.findById(planId).lean();
      cache.set(planId, p ? { tier: p.tier, prices: p.prices } : null);
    }
    return cache.get(planId) ?? null;
  };
}

/** Stream the manageable-status subscriptions via a cursor so a base scan
 *  (preview / activate / backfill) never loads the whole base into memory. */
function activeSubscriptionCursor() {
  return Subscription.find({ status: { $in: [...MANAGEABLE_STATUSES] } }).cursor();
}

/**
 * Grant one promotion to one org: reserve budget → apply+realize idempotently →
 * compensate on any failure. Pure atomic writes (no `.save()`), so it never
 * clobbers a concurrently-saved subscription.
 */
export async function grantPromotionToOrg(
  promo: PromotionDocument,
  subscription: SubscriptionDocument,
  orgId: string,
  ctx: PromotionContext,
): Promise<PromotionGrantResult> {
  const cents = promotionCreditCents(promo, ctx.planPriceCents);
  return reserveAndGrant(promo, subscription, orgId, cents, dedupeKeyFor(promo._id, orgId), ctx.actorId);
}

/**
 * The shared grant core: safety invariant → cheap short-circuit → atomic budget
 * reserve → idempotent ledger push → compensating decrement on any failure. Given
 * an explicit `cents` and `dedupeKey` so BOTH the standard per-org grant and the
 * two-sided referral (referee/referrer) grants reuse the exact same correctness.
 */
async function reserveAndGrant(
  promo: PromotionDocument,
  subscription: SubscriptionDocument,
  orgId: string,
  cents: number,
  dedupeKey: string,
  actorId?: string,
  extraDetails: Record<string, unknown> = {},
): Promise<PromotionGrantResult> {
  const provider = getPaymentProvider();

  // Safety invariant: don't bank a credit the provider can't realize.
  if (provider.usageCreditSupport === 'none') {
    logger.warn('Promotion skipped — provider cannot realize a usage credit', {
      promotionId: promo._id, orgId, provider: config.billingProvider,
    });
    emitCounter('billing_promotion_unrealizable_total', { provider: config.billingProvider });
    return { promotionId: promo._id, granted: false, reason: 'unrealizable' };
  }
  if (cents <= 0) return { promotionId: promo._id, granted: false, reason: 'zero' };

  // Cheap short-circuit (the atomic guard below is the real dedupe).
  if (subscription.creditLedger?.some((l) => l.dedupeKey === dedupeKey)) {
    return { promotionId: promo._id, granted: false, reason: 'already_granted' };
  }

  // 1) Reserve budget atomically — the guard rejects any grant that would exceed
  //    budgetCents or maxGrants, so concurrent triggers can never overspend.
  const reserved = await Promotion.findOneAndUpdate(reserveGuard(promo, cents), { $inc: { spentCents: cents, grantsCount: 1 } }, { new: true });
  if (!reserved) return { promotionId: promo._id, granted: false, reason: 'budget_exhausted' };

  // 2) Apply + realize, idempotent on dedupeKey. Compensate on ANY failure BEFORE
  //    the ledger commits — but ONLY through the commit. The `try` deliberately does
  //    not cover the post-commit side effects (event/metric/log): once the ledger row
  //    is written the grant is durable, so a throwing side effect must not release the
  //    budget reservation (which would leave spentCents < ledger → a loose guard).
  let committed: SubscriptionDocument | null;
  try {
    let ref: { kind: string; ref: string } | undefined;
    if (provider.applyUsageCredit && subscription.externalCustomerId) {
      const r = await provider.applyUsageCredit(subscription.externalCustomerId, cents, `promo-${dedupeKey}`);
      ref = r.ref;
    }
    committed = await Subscription.findOneAndUpdate(
      { '_id': subscription._id, 'creditLedger.dedupeKey': { $ne: dedupeKey } },
      {
        $push: { creditLedger: { discountId: ledgerId(promo._id), cents, appliedAt: new Date(), fulfillmentRef: ref, dedupeKey } },
        $inc: { creditBalanceCents: cents },
      },
      { new: true },
    );
  } catch (err) {
    // Grant/realization failed before the ledger commit — release it (under-spend, never over).
    await Promotion.updateOne({ _id: promo._id }, { $inc: { spentCents: -cents, grantsCount: -1 } });
    throw err;
  }
  if (!committed) {
    // A concurrent trigger won the idempotency guard — release our reservation.
    await Promotion.updateOne({ _id: promo._id }, { $inc: { spentCents: -cents, grantsCount: -1 } });
    return { promotionId: promo._id, granted: false, reason: 'already_granted' };
  }
  // Ledger committed — the grant is durable; side effects below can't undo it.
  await createBillingEvent(
    orgId, 'promotion_granted',
    { promotionId: promo._id, cents, campaign: promo.campaign, ...extraDetails },
    committed._id.toString(), actorId,
  );
  emitCounter('billing_promotion_granted_total');
  logger.info('Promotion granted', { promotionId: promo._id, orgId, cents });
  return { promotionId: promo._id, granted: true, cents, reason: 'granted' };
}

/**
 * Evaluate every active promotion for `event` against this org's subscription and
 * grant the matches. FAIL-SOFT per promotion — one bad grant never blocks the
 * others or the caller's lifecycle op. Returns per-promotion results.
 */
export async function evaluatePromotions(
  orgId: string,
  subscription: SubscriptionDocument,
  event: PromotionEvent,
  ctx: PromotionContext,
): Promise<PromotionGrantResult[]> {
  if (!promotionsEnabled()) return [];

  const now = new Date();
  const candidates = (await Promotion.find({ 'isActive': true, 'trigger.event': event }))
    // `recurring` promos are granted ONLY by the periodic path (grantRecurringPromotions),
    // never by the lifecycle event — else a recurring promo triggered on signup/plan_change
    // would be granted here AND again on the first invoice (double-grant / overspend).
    .filter((p) => p.kind !== 'recurring' && inWindow(p, now) && matchesConditions(p.trigger?.conditions, ctx));

  const results: PromotionGrantResult[] = [];
  for (const promo of candidates) {
    try {
      results.push(await grantPromotionToOrg(promo, subscription, orgId, ctx));
    } catch (err) {
      logger.error('Promotion grant errored (fail-soft)', {
        promotionId: promo._id, orgId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Admin projection: how many active subscriptions match this promo's conditions
 * and the committed spend that would imply, capped at the remaining budget. A
 * planning tool — NOT a live grant (idempotency/budget still bind at grant time).
 */
export async function previewPromotion(
  promo: Pick<PromotionDocument, 'unit' | 'value' | 'perOrgCapCents' | 'budgetCents' | 'spentCents' | 'trigger'>,
): Promise<{ eligibleOrgs: number; projectedCents: number; remainingBudgetCents: number }> {
  const loadPlan = makePlanCache();
  const remaining = Math.max(0, promo.budgetCents - (promo.spentCents ?? 0));
  let eligibleOrgs = 0;
  let projectedCents = 0;
  for await (const sub of activeSubscriptionCursor()) {
    const plan = await loadPlan(sub.planId);
    if (!plan) continue;
    const interval: 'monthly' | 'annual' = sub.interval === 'annual' ? 'annual' : 'monthly';
    const ctx: PromotionContext = { tier: plan.tier, interval, planPriceCents: plan.prices[interval] };
    if (!matchesConditions(promo.trigger?.conditions, ctx)) continue;
    eligibleOrgs += 1;
    projectedCents += promotionCreditCents(promo, ctx.planPriceCents);
  }
  return { eligibleOrgs, projectedCents: Math.min(projectedCents, remaining), remainingBudgetCents: remaining };
}

export interface BatchResult { total: number; matched: number; granted: number; alreadyGranted: number; skippedBudget: number; spentCents: number }

/**
 * Grant a promotion across the EXISTING eligible base — phase 2b activation and
 * the v1.1 backfill cron. Idempotent per org (the atomic dedupe guard makes a
 * re-run safe), budget-bounded; when the budget exhausts mid-run it LOGS how many
 * eligible orgs were skipped (no silent truncation).
 */
export async function batchEvaluatePromotion(promo: PromotionDocument): Promise<BatchResult> {
  // Honor the active window like every live path — an expired (`endsAt` passed) or
  // not-yet-started campaign must not keep granting via activate/backfill. Also skip
  // `recurring` promos: they're owned by the periodic path, so batch-granting them
  // (one-time dedupeKey) would double with grantRecurringPromotions.
  if (promo.kind === 'recurring' || !inWindow(promo, new Date())) {
    return { total: 0, matched: 0, granted: 0, alreadyGranted: 0, skippedBudget: 0, spentCents: 0 };
  }
  const loadPlan = makePlanCache();
  // Deriving first-subscription status costs a countDocuments per org, so only pay
  // it when the campaign actually gates on it (fixes batch/backfill silently
  // skipping every `firstSubscriptionOnly` promo, which omitted the flag before).
  const needsFirstSub = promo.trigger?.conditions?.firstSubscriptionOnly === true;

  const res: BatchResult = { total: 0, matched: 0, granted: 0, alreadyGranted: 0, skippedBudget: 0, spentCents: 0 };
  for await (const sub of activeSubscriptionCursor()) {
    res.total += 1;
    const plan = await loadPlan(sub.planId);
    if (!plan) continue;
    const interval: 'monthly' | 'annual' = sub.interval === 'annual' ? 'annual' : 'monthly';
    const isFirstSubscription = needsFirstSub ? (await Subscription.countDocuments({ orgId: sub.orgId })) <= 1 : undefined;
    const ctx: PromotionContext = { tier: plan.tier, interval, planPriceCents: plan.prices[interval], isFirstSubscription };
    if (!matchesConditions(promo.trigger?.conditions, ctx)) continue;
    res.matched += 1;
    try {
      const r = await grantPromotionToOrg(promo, sub, sub.orgId, ctx);
      if (r.granted) { res.granted += 1; res.spentCents += r.cents ?? 0; } else if (r.reason === 'budget_exhausted') {res.skippedBudget += 1;} else if (r.reason === 'already_granted') {res.alreadyGranted += 1;}
    } catch (err) {
      logger.error('Promotion batch grant errored (fail-soft)', { promotionId: promo._id, orgId: sub.orgId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (res.skippedBudget > 0) logger.warn('Promotion batch: budget exhausted — eligible orgs skipped', { promotionId: promo._id, skipped: res.skippedBudget });
  return res;
}

/**
 * Heal a promotion's advisory `spentCents`/`grantsCount` from the LEDGER (the
 * source of truth) — Σ of its `promo:<id>` entries across all subscriptions.
 * Corrects the recurring re-grant drift: it reserves budget then persists the
 * ledger row via the CALLER's `save()`, so a failed save leaves `spentCents`
 * over-counted (conservative). NOTE the inverse race: if this reconcile aggregates
 * the ledger AFTER a reserve but BEFORE that save, it can transiently UNDER-count
 * until the next cycle heals it — acceptable since it's leader-locked + hourly and
 * self-correcting. Idempotent.
 */
export async function reconcilePromotionSpend(
  promo: Pick<PromotionDocument, '_id' | 'spentCents' | 'grantsCount'>,
): Promise<void> {
  const agg = await Subscription.aggregate([
    { $unwind: '$creditLedger' },
    { $match: { 'creditLedger.discountId': `promo:${promo._id}` } },
    { $group: { _id: null, cents: { $sum: '$creditLedger.cents' }, grants: { $sum: 1 } } },
  ]);
  const cents = agg[0]?.cents ?? 0;
  const grants = agg[0]?.grants ?? 0;
  if (cents !== promo.spentCents || grants !== promo.grantsCount) {
    await Promotion.updateOne({ _id: promo._id }, { $set: { spentCents: cents, grantsCount: grants } });
    logger.info('Reconciled promotion spend cache from ledger', { promotionId: promo._id, spentCents: cents, grantsCount: grants, wasSpentCents: promo.spentCents });
  }
}

/**
 * Reverse promotion grants applied to a subscription within the clawback window —
 * called on cancellation to defuse signup-grab-churn. Removes the ledger row,
 * reduces the balance (clamped ≥ 0 — a partially-consumed credit isn't over-clawed),
 * and RELEASES the budget reservation. Emits `promotion_clawback`.
 */
export async function clawbackRecentPromotions(subscription: SubscriptionDocument, actorId?: string): Promise<number> {
  if (!promotionsEnabled()) return 0;
  const cutoff = Date.now() - config.promotions.clawbackWindowMs;
  const rows = (subscription.creditLedger ?? []).filter(
    (l) => typeof l.discountId === 'string' && l.discountId.startsWith('promo:') && l.appliedAt && new Date(l.appliedAt).getTime() >= cutoff,
  );
  let count = 0;
  for (const row of rows) {
    const promoId = (row.discountId as string).slice('promo:'.length);
    const balance = subscription.creditBalanceCents ?? 0;
    const reduce = Math.min(row.cents, balance);
    // Guard the pull on the row STILL being present, so a retried/concurrent
    // cancel that already clawed this back can't drive spentCents/grantsCount
    // negative (a second release with the row gone).
    const pull = await Subscription.updateOne(
      { '_id': subscription._id, 'creditLedger.dedupeKey': row.dedupeKey },
      { $pull: { creditLedger: { dedupeKey: row.dedupeKey } }, $inc: { creditBalanceCents: -reduce } },
    );
    if (pull.modifiedCount !== 1) continue; // already reversed — don't double-release
    subscription.creditBalanceCents = Math.max(0, balance - reduce);
    await Promotion.updateOne({ _id: promoId }, { $inc: { spentCents: -row.cents, grantsCount: -1 } });
    await createBillingEvent(subscription.orgId, 'promotion_clawback', { promotionId: promoId, cents: row.cents, reducedCents: reduce }, subscription._id.toString(), actorId);
    emitCounter('billing_promotion_clawback_total');
    count += 1;
  }
  if (count > 0) logger.info('Promotion grants clawed back on cancel', { orgId: subscription.orgId, count });
  return count;
}

/**
 * Re-grant standing RECURRING promotions for one billing period — called from the
 * periodic reconcile (Stripe invoice) / metering (Marketplace) path. Mutates the
 * subscription IN MEMORY (the caller saves), matching the recurring-discount
 * re-grant style; budget is reserved atomically on the Promotion doc and the grant
 * is idempotent per period via a period-scoped dedupeKey. Stops when the promo is
 * revoked / out of window / over budget or the org is no longer eligible. No-op
 * when promotions or the provider's credit realization is off.
 */
export async function grantRecurringPromotions(subscription: SubscriptionDocument, periodKey: string): Promise<void> {
  if (!promotionsEnabled()) return;
  const provider = getPaymentProvider();
  if (provider.usageCreditSupport === 'none') return;
  const ctx = await contextForSubscription(subscription);
  if (!ctx) return;

  const now = new Date();
  const promos = (await Promotion.find({ isActive: true, kind: 'recurring' }))
    .filter((p) => inWindow(p, now) && matchesConditions(p.trigger?.conditions, ctx));

  for (const promo of promos) {
    const dedupeKey = `promo:${promo._id}:${subscription.orgId}:${periodKey}`;
    if (subscription.creditLedger?.some((l) => l.dedupeKey === dedupeKey)) continue; // this period already granted
    const cents = promotionCreditCents(promo, ctx.planPriceCents);
    if (cents <= 0) continue;

    const reserved = await Promotion.findOneAndUpdate(reserveGuard(promo, cents), { $inc: { spentCents: cents, grantsCount: 1 } }, { new: true });
    if (!reserved) continue; // budget/cap exhausted → stop

    let ref: { kind: string; ref: string } | undefined;
    if (provider.applyUsageCredit && subscription.externalCustomerId) {
      try {
        const r = await provider.applyUsageCredit(subscription.externalCustomerId, cents, `promo-${dedupeKey}`);
        ref = r.ref;
      } catch {
        await Promotion.updateOne({ _id: promo._id }, { $inc: { spentCents: -cents, grantsCount: -1 } });
        continue;
      }
    }
    // In-memory grant (the periodic caller saves the subscription).
    subscription.creditBalanceCents = (subscription.creditBalanceCents ?? 0) + cents;
    subscription.creditLedger.push({ discountId: ledgerId(promo._id), cents, appliedAt: new Date(), fulfillmentRef: ref, dedupeKey });
    await createBillingEvent(subscription.orgId, 'promotion_granted', { promotionId: promo._id, cents, campaign: promo.campaign, periodKey }, subscription._id.toString());
  }
}

/** Build the trigger context (tier / interval / plan price) for an existing subscription. */
async function contextForSubscription(subscription: SubscriptionDocument): Promise<PromotionContext | null> {
  const plan = await Plan.findById(subscription.planId).lean();
  if (!plan) return null;
  const interval: 'monthly' | 'annual' = subscription.interval === 'annual' ? 'annual' : 'monthly';
  return { tier: plan.tier, interval, planPriceCents: plan.prices[interval] };
}

// ─── Referral (phase 2c) ────────────────────────────────────────────

/**
 * Record a PENDING referral at signup — a NEW org (`refereeOrgId`) subscribed with
 * another org's referral code (= the referrer's org id). NO credit is granted here:
 * BOTH sides are credited only once the referee QUALIFIES (their first paid invoice
 * — see `qualifyReferral`), so merely naming a paying org can't self-issue a free
 * credit. Fail-soft. Guards: no self-referral, referee referred at most once (unique
 * index), referrer must be a real subscribed org, an active `referral` promotion
 * must match the referee.
 */
export async function processReferralSignup(
  refereeOrgId: string,
  referralCode: string,
  ctx: PromotionContext,
): Promise<void> {
  if (!promotionsEnabled()) return;
  const referrerOrgId = (referralCode || '').trim();
  if (!referrerOrgId || referrerOrgId === refereeOrgId) return; // missing / self-referral
  if (getPaymentProvider().usageCreditSupport === 'none') return;

  const now = new Date();
  const promo = (await Promotion.find({ 'isActive': true, 'trigger.event': 'referral' }))
    .filter((p) => inWindow(p, now) && matchesConditions(p.trigger?.conditions, ctx))[0];
  if (!promo) return;

  // The referrer must be a real, subscribed org.
  if (!(await loadManageableSubscription(referrerOrgId))) return;

  // Record the pending pairing (unique refereeOrgId → referred at most once). No grant.
  try {
    await Referral.create({
      _id: `ref_${randomUUID()}`,
      promotionId: promo._id,
      referrerOrgId,
      refereeOrgId,
      refereeGrantCents: 0,
      referrerGrantCents: 0,
      status: 'pending',
    });
  } catch {
    /* already referred (or a create race) — ignore */
  }
}

/**
 * Qualify a referral on the referee's FIRST paid invoice — the qualifying moment.
 * Credits BOTH the referee (`value`) and the referrer (`referrerValue` ?? `value`),
 * each dedupe-guarded and budget-bounded, then TERMINATES the referral so a later
 * payment can't re-fire. Gating both grants on the referee actually paying defeats
 * the "name any paying org for a free credit" abuse. No-op when there's no pending
 * referral for this org.
 */
export async function qualifyReferral(refereeOrgId: string): Promise<void> {
  if (!promotionsEnabled()) return;
  const referral = await Referral.findOne({ refereeOrgId, status: 'pending' });
  if (!referral) return;

  const promo = await Promotion.findById(referral.promotionId);
  // Promo revoked/removed → leave the referral pending (it simply never qualifies).
  if (!promo || !promo.isActive) return;

  // Grant the REFEREE (their current plan) — this is the qualifying payment.
  let refereeCents = 0;
  const refereeSub = await loadManageableSubscription(refereeOrgId);
  const refereeCtx = refereeSub ? await contextForSubscription(refereeSub) : null;
  if (refereeSub && refereeCtx) {
    const r = await reserveAndGrant(promo, refereeSub, refereeOrgId, promotionCreditCents(promo, refereeCtx.planPriceCents), dedupeKeyFor(promo._id, refereeOrgId), undefined, { referral: 'referee', referrerOrgId: referral.referrerOrgId });
    if (r.granted) refereeCents = r.cents ?? 0;
  }

  // Grant the REFERRER (if still subscribed), magnitude `referrerValue` ?? `value`.
  let referrerCents = 0;
  const referrerSub = await loadManageableSubscription(referral.referrerOrgId);
  const referrerCtx = referrerSub ? await contextForSubscription(referrerSub) : null;
  if (referrerSub && referrerCtx) {
    const cents = promotionCreditCents({ unit: promo.unit, value: promo.referrerValue ?? promo.value, perOrgCapCents: promo.perOrgCapCents }, referrerCtx.planPriceCents);
    const dedupeKey = `promo:${promo._id}:${referral.referrerOrgId}:ref:${refereeOrgId}`;
    const r = await reserveAndGrant(promo, referrerSub, referral.referrerOrgId, cents, dedupeKey, undefined, { referral: 'referrer', refereeOrgId });
    if (r.granted) referrerCents = r.cents ?? 0;
  }

  // Terminate regardless of grant outcomes — a budget-exhausted grant must not make
  // every subsequent payment retry forever.
  await Referral.updateOne(
    { _id: referral._id },
    { $set: { status: 'qualified', qualifiedAt: new Date(), refereeGrantCents: refereeCents, referrerGrantCents: referrerCents } },
  );
  logger.info('Referral qualified', { promotionId: promo._id, refereeOrgId, referrerOrgId: referral.referrerOrgId, refereeCents, referrerCents });
}
