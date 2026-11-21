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
import { createLogger, emitCounter, errorMessage, type BillingInterval } from '@pipeline-builder/api-core';
import { config } from '../config.js';
import { createBillingEvent, getBundleCatalog } from './billing-helpers.js';
import { releaseCampaignBudget, reserveCampaignBudget } from './campaign.js';
import { postPendingCreditDebit } from './credit-debits.js';
import { discountFloorBreach, recurringDiscountStandingCents } from './credit-floor.js';
import { creditLedgerEntry } from './credit-ledger-compaction.js';
import { aggregateLedgerSpend, type LedgerSpend } from './ledger-spend.js';
import { evaluateUsage, type ProfileLike } from './offers-rules.js';
import { MANAGEABLE_SUBSCRIPTION_STATUSES, loadManageableSubscription } from './subscription-status.js';
import { Plan } from '../models/plan.js';
import { Promotion } from '../models/promotion.js';
import type { PromotionDocument, PromotionEvent, PromotionConditions } from '../models/promotion.js';
import { Referral } from '../models/referral.js';
import { Subscription } from '../models/subscription.js';
import type { SubscriptionDocument } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('promotion-engine');

/** Feature flag — promotions are ON unless BILLING_PROMOTIONS_ENABLED=false (and require discounts on). */
export function promotionsEnabled(): boolean {
  return config.promotions.enabled;
}

/** The context a trigger passes: what the eligible subscription looks like right now. */
export interface PromotionContext {
  tier: string;
  interval: BillingInterval;
  /** Current plan price for the interval — the base for a `percent` promo. */
  planPriceCents: number;
  /** True when this is the org's first-ever subscription (for `firstSubscriptionOnly`). */
  isFirstSubscription?: boolean;
  /** Acting user id when a request context exists; absent on cron/system paths. */
  actorId?: string;
  /**
   * The account's usage-profile history, NEWEST FIRST (Phase 1).
   *
   * Absent on the lifecycle paths (`subscription_created`, `plan_change`),
   * which is correct rather than a gap: those fire on a billing event, and an
   * account that has just subscribed has no history to be sustained over. A
   * promotion carrying `usage` conditions therefore cannot match on those paths
   * — it fails closed with `no_profile` rather than matching vacuously.
   */
  profiles?: readonly ProfileLike[];
}

export interface PromotionGrantResult {
  promotionId: string;
  granted: boolean;
  cents?: number;
  reason?: 'granted' | 'already_granted' | 'budget_exhausted' | 'campaign_budget_exhausted' | 'unrealizable' | 'zero' | 'floor_breached';
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

// loadManageableSubscription is re-exported so the promotions route keeps
// importing it from here (source of truth is the shared leaf module).
export { loadManageableSubscription };

/** Resolve a promo's grant magnitude to cents, clamped by any per-org cap. `dollar`
 *  = the value in cents; `percent` = that percent of the current plan price. */
function promotionCreditCents(
  promo: Pick<PromotionDocument, 'unit' | 'value' | 'perOrgCapCents'>,
  planPriceCents: number,
): number {
  const raw = promo.unit === 'dollar' ? promo.value : Math.round((planPriceCents * promo.value) / 100);
  return promo.perOrgCapCents ? Math.min(raw, promo.perOrgCapCents) : raw;
}

/**
 * Whether `ctx` satisfies every present eligibility predicate.
 *
 * STILL THE SINGLE PLACE eligibility is decided, which is why Phase 1 widened
 * this rather than adding a second gate beside it: two places that decide who
 * gets a discount is two places to disagree.
 */
function matchesConditions(conditions: PromotionConditions | undefined, ctx: PromotionContext): boolean {
  if (!conditions) return true;
  if (conditions.tiers?.length && !conditions.tiers.includes(ctx.tier)) return false;
  if (conditions.intervals?.length && !conditions.intervals.includes(ctx.interval)) return false;
  if (conditions.firstSubscriptionOnly && ctx.isFirstSubscription !== true) return false;
  // Usage predicates last: they are the expensive ones to reason about, and the
  // cheap tier/interval filters have already excluded most accounts.
  if (conditions.usage && !evaluateUsage(conditions.usage, ctx.profiles ?? []).matches) return false;
  return true;
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
  return Subscription.find({ status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] } }).cursor();
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
  return reserveAndGrant(promo, subscription, orgId, cents, dedupeKeyFor(promo._id, orgId), ctx.planPriceCents, ctx.actorId);
}

/**
 * Would granting `cents` to this subscription take the invoice below the floor?
 *
 * The standing figure counts the composition's derived credits (combo + volume)
 * plus the subscription's recurring discount.
 *
 * `planPriceCents` is PASSED IN, never re-fetched: every caller already holds it
 * (`PromotionContext.planPriceCents`), and the base scans share a per-planId
 * cache precisely so "a campaign of N orgs on M plans does M plan lookups, not
 * N". A `Plan.findById` here would have re-introduced that N+1 inside the grant
 * loop — which is how this first showed up, as batch and per-period tests
 * timing out under load rather than as a wrong answer.
 */
function promotionFloorBreach(
  promo: PromotionDocument,
  subscription: SubscriptionDocument,
  cents: number,
  planPriceCents: number,
  /** Other promotion credit already standing against the same invoice (the per-period pass). */
  otherPromotionCents = 0,
): { listCents: number; standingCreditCents: number; budgetCents: number } | null {
  const standingExtraCents = recurringDiscountStandingCents(subscription, planPriceCents, getBundleCatalog()) + otherPromotionCents;
  const breach = discountFloorBreach(
    { planPriceCents, addons: subscription.addons ?? [], interval: subscription.interval, bundles: getBundleCatalog(), standingExtraCents },
    cents,
    promo.kind,
  );
  if (!breach) return null;
  return { listCents: breach.listCents, standingCreditCents: breach.standingCreditCents, budgetCents: breach.budgetCents };
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
  /** The caller's already-resolved plan price for the interval — see
   *  {@link promotionFloorBreach} for why this is not looked up here. */
  planPriceCents: number,
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

  // THE AGGREGATE FLOOR. Checked here because nothing checked it before: the
  // floor lived in `discount-helpers` and `discountFloorBreach` appeared ZERO
  // times in this file, so a coupon on a maxed stack was refused while a
  // promotion on the identical account was granted — and promotions fire
  // AUTOMATICALLY, which is exactly the no-human-in-the-loop case the floor
  // exists for. Promotions have no `credit` kind (`onetime` / `recurring` only),
  // so both kinds are inside the floor by its own rule.
  //
  // Before the reserve, so a refusal does not have to be compensated.
  const breach = promotionFloorBreach(promo, subscription, cents, planPriceCents);
  if (breach) {
    logger.warn('Promotion skipped — would breach the aggregate credit floor', {
      promotionId: promo._id, orgId, cents, ...breach,
    });
    emitCounter('billing_promotion_floor_refused_total', { kind: promo.kind });
    await createBillingEvent(orgId, 'promotion_floor_refused', { promotionId: promo._id, cents, ...breach }, subscription._id.toString(), actorId);
    return { promotionId: promo._id, granted: false, reason: 'floor_breached' };
  }

  // 1) Reserve budget atomically — the guard rejects any grant that would exceed
  //    budgetCents or maxGrants, so concurrent triggers can never overspend.
  const reserved = await Promotion.findOneAndUpdate(reserveGuard(promo, cents), { $inc: { spentCents: cents, grantsCount: 1 } }, { new: true });
  if (!reserved) return { promotionId: promo._id, granted: false, reason: 'budget_exhausted' };

  // THE CAMPAIGN'S budget too, when this promotion belongs to one. A campaign
  // and a promotion used to hold independent budgets, so one marketing push run
  // as both had no combined ceiling. Reserved after the promotion's own so a
  // refusal unwinds exactly one claim.
  if (promo.campaign && !(await reserveCampaignBudget(promo.campaign, cents))) {
    await Promotion.updateOne({ _id: promo._id }, { $inc: { spentCents: -cents, grantsCount: -1 } });
    return { promotionId: promo._id, granted: false, reason: 'campaign_budget_exhausted' };
  }

  /** Unwind BOTH budget claims — the promotion's and its campaign's. */
  const releaseBudgets = async (): Promise<void> => {
    await Promotion.updateOne({ _id: promo._id }, { $inc: { spentCents: -cents, grantsCount: -1 } });
    if (promo.campaign) await releaseCampaignBudget(promo.campaign, cents);
  };

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
        $push: { creditLedger: creditLedgerEntry({ discountId: ledgerId(promo._id), cents, fulfillmentRef: ref, dedupeKey, campaign: promo.campaign }) },
        $inc: { creditBalanceCents: cents },
      },
      { new: true },
    );
  } catch (err) {
    // Grant/realization failed before the ledger commit — release it (under-spend, never over).
    await releaseBudgets();
    throw err;
  }
  if (!committed) {
    // A concurrent trigger won the idempotency guard — release our reservation.
    await releaseBudgets();
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
        promotionId: promo._id, orgId, error: errorMessage(err),
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
    const interval: BillingInterval = sub.interval === 'annual' ? 'annual' : 'monthly';
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
    const interval: BillingInterval = sub.interval === 'annual' ? 'annual' : 'monthly';
    const isFirstSubscription = needsFirstSub ? (await Subscription.countDocuments({ orgId: sub.orgId })) <= 1 : undefined;
    const ctx: PromotionContext = { tier: plan.tier, interval, planPriceCents: plan.prices[interval], isFirstSubscription };
    if (!matchesConditions(promo.trigger?.conditions, ctx)) continue;
    res.matched += 1;
    try {
      const r = await grantPromotionToOrg(promo, sub, sub.orgId, ctx);
      if (r.granted) { res.granted += 1; res.spentCents += r.cents ?? 0; } else if (r.reason === 'budget_exhausted') {res.skippedBudget += 1;} else if (r.reason === 'already_granted') {res.alreadyGranted += 1;}
    } catch (err) {
      logger.error('Promotion batch grant errored (fail-soft)', { promotionId: promo._id, orgId: sub.orgId, error: errorMessage(err) });
    }
  }
  if (res.skippedBudget > 0) logger.warn('Promotion batch: budget exhausted — eligible orgs skipped', { promotionId: promo._id, skipped: res.skippedBudget });
  return res;
}

/**
 * Aggregate a promotion's true spend from the LEDGER: Σ `cents` and Σ grants of
 * its `promo:<id>` entries across all subscriptions. A compaction carry row
 * (credit-ledger-compaction) counts as the grants it folded (`grantCount`), an
 * ordinary row as 1 — so a bounded/compacted ledger still totals the true spend +
 * grant count. Shared by {@link reconcilePromotionSpend} (the healer) and the
 * `/promotions/:id/spend` read endpoint so the two can't drift.
 */
export async function aggregatePromotionLedgerSpend(promoId: string): Promise<LedgerSpend> {
  return aggregateLedgerSpend({ 'creditLedger.discountId': ledgerId(promoId) });
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
  const { cents, grants } = await aggregatePromotionLedgerSpend(String(promo._id));
  if (cents !== promo.spentCents || grants !== promo.grantsCount) {
    await Promotion.updateOne({ _id: promo._id }, { $set: { spentCents: cents, grantsCount: grants } });
    logger.info('Reconciled promotion spend cache from ledger', { promotionId: promo._id, spentCents: cents, grantsCount: grants, wasSpentCents: promo.spentCents });
  }
}

/**
 * The provider idempotency key for taking back ONE grant: its ledger dedupeKey
 * plus the moment it was applied. A clawback now leaves a tombstone that keeps
 * the dedupeKey (so the same one-time grant cannot be re-granted), but the
 * timestamp still keeps the key unique should the same key ever be granted
 * again (e.g. after ledger compaction folds the tombstone into a carry row), so
 * a second clawback is never answered from the first one's idempotency record.
 */
function clawbackDebitKey(row: { dedupeKey?: string; discountId: string; appliedAt: Date }): string {
  return `promo-clawback-${row.dedupeKey ?? row.discountId}-${new Date(row.appliedAt).getTime()}`;
}

/**
 * Reverse promotion grants applied to a subscription within the clawback window —
 * called on cancellation to defuse signup-grab-churn, and on a refund/dispute.
 * Tombstones the ledger row (keeping its dedupeKey so a one-time promotion is
 * not re-granted), reduces the balance, and RELEASES the recovered part of the
 * budget reservations (the promotion's and its campaign's). Emits
 * `promotion_clawback`.
 *
 * WHAT IS TAKEN BACK. Only the UNUSED part of the grant: `min(grant cents,
 * current credit balance)`. The mirror does not track consumption per grant —
 * invoices draw down one pooled balance — so the remaining balance is the most
 * of any one grant that can still be unused; credit an invoice already consumed
 * is not clawed (it is never over-clawed into a charge).
 *
 * BOTH SIDES OF THE CREDIT. The grant was posted to the provider balance
 * (`applyUsageCredit`) as well as the local mirror, so reducing only the mirror
 * left the credit at the provider, which applied it to the next invoice of a
 * still-active subscription anyway. The same atomic write that pulls the grant
 * queues the matching provider debit (`pendingCreditDebits`), which is then
 * posted under a per-grant idempotency key; a failed post stays queued for the
 * lifecycle reconciler (`retryPendingCreditDebits`), so a retried clawback never debits twice and a failed
 * one is never lost.
 */
export async function clawbackRecentPromotions(
  subscription: SubscriptionDocument,
  actorId?: string,
  /** Tags each tombstone with the reversal that clawed it (`dispute:<id>`), so a
   *  won dispute can re-grant exactly what it took ({@link regrantDisputeClawback}). */
  clawbackRef?: string,
): Promise<number> {
  if (!promotionsEnabled()) return 0;
  const cutoff = Date.now() - config.promotions.clawbackWindowMs;
  const rows = (subscription.creditLedger ?? []).filter(
    (l) => typeof l.discountId === 'string' && l.discountId.startsWith('promo:') && l.appliedAt
      && new Date(l.appliedAt).getTime() >= cutoff && !l.clawedBackAt,
  );
  let count = 0;
  for (const row of rows) {
    const promoId = (row.discountId as string).slice('promo:'.length);
    const balance = subscription.creditBalanceCents ?? 0;
    const reduce = Math.min(row.cents, balance);
    // The part of the grant the customer already CONSUMED stays spent: it was
    // real credit against a real invoice, so neither budget gets it back.
    const consumed = row.cents - reduce;
    // TOMBSTONE the row instead of pulling it. A `$pull` freed its dedupeKey, so
    // the same one-time promotion could be granted to this org again (the grant
    // path's dedupe is "a ledger row with this dedupeKey exists"); the tombstone
    // keeps the key, and is shaped so the ledger-derived spend stays exact: its
    // `cents` is what remains spent (`consumed`) and it counts as zero grants.
    //
    // Guard on the row still being UN-tombstoned, so a retried/concurrent
    // clawback can't release twice.
    const debit = reduce > 0 ? { key: clawbackDebitKey(row), cents: reduce, createdAt: new Date() } : null;
    const tombstone = await Subscription.updateOne(
      { _id: subscription._id, creditLedger: { $elemMatch: { dedupeKey: row.dedupeKey, clawedBackAt: { $exists: false } } } },
      {
        $set: {
          'creditLedger.$.cents': consumed,
          'creditLedger.$.grantCount': 0,
          'creditLedger.$.clawedBackAt': new Date(),
          ...(clawbackRef ? { 'creditLedger.$.clawbackRef': clawbackRef, 'creditLedger.$.clawedBackCents': reduce } : {}),
        },
        $inc: { creditBalanceCents: -reduce },
        ...(debit ? { $push: { pendingCreditDebits: debit } } : {}),
      },
    );
    if (tombstone.modifiedCount !== 1) continue; // already reversed — don't double-release
    subscription.creditBalanceCents = Math.max(0, balance - reduce);
    if (debit) await postPendingCreditDebit(subscription, debit, 'clawback');
    // Release only what was actually RECOVERED — releasing the full grant handed
    // the consumed part back to the budget, so it could be granted out again.
    await Promotion.updateOne({ _id: promoId }, { $inc: { spentCents: -reduce, grantsCount: -1 } });
    // The grant reserved its campaign's shared budget too (reserveAndGrant), and
    // nothing re-derives a campaign's counters from the ledger — so without this
    // a clawed-back grant kept consuming the campaign budget for good.
    if (row.campaign) await releaseCampaignBudget(row.campaign, reduce);
    await createBillingEvent(subscription.orgId, 'promotion_clawback', { promotionId: promoId, cents: row.cents, reducedCents: reduce }, subscription._id.toString(), actorId);
    emitCounter('billing_promotion_clawback_total');
    count += 1;
  }
  if (count > 0) logger.info('Promotion grants clawed back on cancel', { orgId: subscription.orgId, count });
  return count;
}

/**
 * A WON dispute: re-grant the promotion credit that dispute's clawback took back
 * ({@link clawbackRecentPromotions} with `clawbackRef: 'dispute:<id>'`). Each
 * tombstone the dispute left is re-granted for the cents it RECOVERED (the part
 * an invoice had consumed was never taken), through the same atomic grant core as
 * every promotion — budget reserved under its guard, ledger `$push` guarded on a
 * dedupeKey derived from the original grant and the dispute id, so a redelivered
 * won event grants nothing twice. Returns the number of grants made. A refused
 * re-grant (promotion revoked, budget gone, floor) is logged, not retried: the
 * bias stays under-spend.
 */
export async function regrantDisputeClawback(subscription: SubscriptionDocument, disputeId: string): Promise<number> {
  if (!promotionsEnabled()) return 0;
  const ref = `dispute:${disputeId}`;
  const rows = subscription.creditLedger.flatMap((l) => (l.clawbackRef === ref && l.clawedBackCents ? [{ row: l, cents: l.clawedBackCents }] : []));
  if (rows.length === 0) return 0;
  const ctx = await contextForSubscription(subscription);
  if (!ctx) {
    logger.warn('Won dispute: plan not found — clawed-back promotions not re-granted', { orgId: subscription.orgId, disputeId });
    return 0;
  }
  let count = 0;
  for (const { row, cents } of rows) {
    const promoId = row.discountId.slice('promo:'.length);
    const promo = await Promotion.findById(promoId);
    const result = promo
      ? await reserveAndGrant(promo, subscription, subscription.orgId, cents, `${row.dedupeKey ?? row.discountId}:dispute-won:${disputeId}`,
        ctx.planPriceCents, undefined, { regrant: 'dispute_won', disputeId })
      : null;
    if (result?.granted) {count += 1;} else if (result?.reason !== 'already_granted') {
      logger.warn('Won dispute: clawed-back promotion not re-granted', {
        orgId: subscription.orgId, disputeId, promotionId: promoId, reason: result?.reason ?? 'promotion_missing',
      });
    }
  }
  return count;
}

/**
 * The standing credit this subscription's eligible RECURRING promotions add to
 * every invoice — the promotion half of the floor's "standing" figure.
 *
 * The floor could not see this before, and nothing in `promotion-engine` ever
 * consulted the floor, so a promotion granted straight through a ceiling that
 * refused a coupon on the identical account. Derived the same way
 * {@link grantRecurringPromotions} grants, so the number the floor measures is
 * the number the customer is actually credited.
 *
 * Returns 0 when promotions are off or the org is ineligible — never throws, so
 * a floor check can't fail a redemption on a promotion lookup.
 */
export async function standingRecurringPromotionCents(subscription: SubscriptionDocument): Promise<number> {
  if (!promotionsEnabled()) return 0;
  try {
    const ctx = await contextForSubscription(subscription);
    if (!ctx) return 0;
    const now = new Date();
    const promos = (await Promotion.find({ isActive: true, kind: 'recurring' }))
      .filter((p) => inWindow(p, now) && matchesConditions(p.trigger?.conditions, ctx));
    return promos.reduce((n, p) => n + Math.max(0, promotionCreditCents(p, ctx.planPriceCents)), 0);
  } catch (error) {
    // Advisory input to a ceiling: failing closed here would refuse redemptions
    // for an unrelated outage, and failing open understates the standing credit
    // by the promotions we could not read. Understate, and say so.
    logger.warn('Could not resolve standing recurring promotions for the floor', { orgId: subscription.orgId, error: errorMessage(error) });
    return 0;
  }
}

/**
 * Re-grant standing RECURRING promotions for one billing period — called from the
 * periodic reconcile (Stripe invoice) / metering (Marketplace) path. Every write
 * is atomic: budget is reserved on the Promotion doc, and the grant is a guarded
 * `$push` + `$inc`, idempotent per period via a period-scoped dedupeKey — the
 * passed `subscription` is read, never mutated, so the caller's own save cannot
 * clobber (or be clobbered by) a concurrent credit write. Stops when the promo is
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

  // Promotion credit already standing against THIS period's invoice — granted
  // earlier in this pass, or in an earlier pass for the same period. Each
  // promotion is floored against it, or two that each fit alone are both granted
  // when together they breach the floor.
  let periodPromotionCents = 0;
  for (const promo of promos) {
    const dedupeKey = `promo:${promo._id}:${subscription.orgId}:${periodKey}`;
    const cents = promotionCreditCents(promo, ctx.planPriceCents);
    if (subscription.creditLedger?.some((l) => l.dedupeKey === dedupeKey)) { // this period already granted
      periodPromotionCents += Math.max(0, cents);
      continue;
    }
    if (cents <= 0) continue;
    // The floor, per period, for the same reason the recurring DISCOUNT re-grant
    // clamps to it: the composition moves after the promotion starts standing.
    if (promotionFloorBreach(promo, subscription, cents, ctx.planPriceCents, periodPromotionCents)) {
      emitCounter('billing_promotion_floor_refused_total', { kind: promo.kind });
      continue;
    }

    const reserved = await Promotion.findOneAndUpdate(reserveGuard(promo, cents), { $inc: { spentCents: cents, grantsCount: 1 } }, { new: true });
    if (!reserved) continue; // budget/cap exhausted → stop
    // The campaign's shared budget, as in `reserveAndGrant`.
    if (promo.campaign && !(await reserveCampaignBudget(promo.campaign, cents))) {
      await Promotion.updateOne({ _id: promo._id }, { $inc: { spentCents: -cents, grantsCount: -1 } });
      continue;
    }
    const releaseBoth = async (): Promise<void> => {
      await Promotion.updateOne({ _id: promo._id }, { $inc: { spentCents: -cents, grantsCount: -1 } });
      if (promo.campaign) await releaseCampaignBudget(promo.campaign, cents);
    };

    let ref: { kind: string; ref: string } | undefined;
    if (provider.applyUsageCredit && subscription.externalCustomerId) {
      try {
        const r = await provider.applyUsageCredit(subscription.externalCustomerId, cents, `promo-${dedupeKey}`);
        ref = r.ref;
      } catch {
        await releaseBoth();
        continue;
      }
    }
    // Guarded atomic write so it can't clobber — or be clobbered by — a
    // concurrent credit write on the same ledger (M2). The dedupeKey guard keeps
    // it idempotent per period; the reservation is compensated if it loses.
    const committed = await Subscription.findOneAndUpdate(
      { _id: subscription._id, creditLedger: { $not: { $elemMatch: { dedupeKey } } } },
      { $push: { creditLedger: creditLedgerEntry({ discountId: ledgerId(promo._id), cents, fulfillmentRef: ref, dedupeKey, campaign: promo.campaign }) }, $inc: { creditBalanceCents: cents } },
      { new: true },
    );
    if (!committed) {
      await releaseBoth();
      continue;
    }
    periodPromotionCents += cents;
    await createBillingEvent(subscription.orgId, 'promotion_granted', { promotionId: promo._id, cents, campaign: promo.campaign, periodKey }, subscription._id.toString());
  }
}

/** Build the trigger context (tier / interval / plan price) for an existing subscription. */
async function contextForSubscription(subscription: SubscriptionDocument): Promise<PromotionContext | null> {
  const plan = await Plan.findById(subscription.planId).lean();
  if (!plan) return null;
  const interval: BillingInterval = subscription.interval === 'annual' ? 'annual' : 'monthly';
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
    const r = await reserveAndGrant(promo, refereeSub, refereeOrgId, promotionCreditCents(promo, refereeCtx.planPriceCents), dedupeKeyFor(promo._id, refereeOrgId), refereeCtx.planPriceCents, undefined, { referral: 'referee', referrerOrgId: referral.referrerOrgId });
    if (r.granted) refereeCents = r.cents ?? 0;
  }

  // Grant the REFERRER (if still subscribed), magnitude `referrerValue` ?? `value`.
  let referrerCents = 0;
  const referrerSub = await loadManageableSubscription(referral.referrerOrgId);
  const referrerCtx = referrerSub ? await contextForSubscription(referrerSub) : null;
  if (referrerSub && referrerCtx) {
    const cents = promotionCreditCents({ unit: promo.unit, value: promo.referrerValue ?? promo.value, perOrgCapCents: promo.perOrgCapCents }, referrerCtx.planPriceCents);
    const dedupeKey = `promo:${promo._id}:${referral.referrerOrgId}:ref:${refereeOrgId}`;
    const r = await reserveAndGrant(promo, referrerSub, referral.referrerOrgId, cents, dedupeKey, referrerCtx.planPriceCents, undefined, { referral: 'referrer', refereeOrgId });
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
