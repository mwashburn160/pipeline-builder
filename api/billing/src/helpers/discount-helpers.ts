// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { createLogger } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { config } from '../config.js';
import { createBillingEvent, getBundleCatalog } from './billing-helpers.js';
import { billingPeriodKey } from './billing-period.js';
// Re-exported so routes/discounts.ts keeps importing it from here.
export { loadManageableSubscription };
import { activeComboCredits, comboLedgerId, discountBaseCents, getComboDiscounts, priceForInterval, volumeCredits, volumeLedgerId } from './combo-pricing.js';
import { compactInMemoryLedger, creditLedgerEntry } from './credit-ledger-compaction.js';
import { decodeDiscountCode, type DiscountSpec, type DiscountKind } from './discount-code.js';
import { snapNetCharge } from './price-rounding.js';
import { loadManageableSubscription } from './subscription-status.js';
import { Discount } from '../models/discount.js';
import type { DiscountDocument } from '../models/discount.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';
import type { BillingInterval, SubscriptionDocument } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('discount-helpers');

/** Statuses that may hold/redeem a discount (a coupon applies post-trial). */
const REDEEMABLE_STATUSES = ['active', 'trialing'] as const;

/** Feature flag — the discount surface is ON unless BILLING_DISCOUNTS_ENABLED=false. */
export function discountsEnabled(): boolean {
  return config.discounts.enabled;
}

/**
 * Whether the active provider can realize a usage credit — every discount kind
 * resolves to one, so this is the single gate. A provider reporting
 * `usageCreditSupport: 'none'` rejects all discounts. Stripe reports `'balance'`;
 * Marketplace reports `'metered'` only when metering + a dimension price map are
 * configured (else `'none'`, so an unrealizable credit is never accepted).
 */
function discountAllowedForProvider(): boolean {
  const support = getPaymentProvider().usageCreditSupport;
  if (!support) return config.billingProvider !== 'aws-marketplace';
  return support !== 'none';
}

/** Enforce the mint-time magnitude ceiling on a parsed authoring form. */
export function withinCeiling(spec: DiscountSpec): boolean {
  return spec.unit === 'percent'
    ? spec.value <= config.discounts.maxPercent
    : spec.value <= config.discounts.maxCents;
}

/** Random opaque discount id — the handle a token seals, never the authoring form. */
export function generateDiscountId(): string {
  return `disc_${randomUUID()}`;
}

/** The provider-dedup seed for a usage-credit grant — one place so the caller and
 *  the `grantUsageCredit` push can't drift. `periodKey` scopes a per-period re-grant
 *  (recurring/combo); omit it for a one-time apply. */
function creditIdemSeed(orgId: string, discountId: string, periodKey?: string): string {
  return periodKey ? `${orgId}:${discountId}:${periodKey}` : `${orgId}:${discountId}`;
}


/**
 * Resolve a redemption `code` — an opaque token OR a public alias — to its
 * `Discount` record. Tokens are tried first (decoded + id lookup); a
 * non-token string falls back to an active-alias lookup. Returns `null` when
 * neither resolves (an unknown/forged code is indistinguishable from a
 * non-existent one on purpose).
 */
export async function resolveRedeemable(code: string): Promise<DiscountDocument | null> {
  // decodeDiscountCode()'s default key-ring load THROWS when keys are
  // unconfigured — a redeem attempt in that state must degrade to an alias
  // lookup, not crash the request.
  let decoded: ReturnType<typeof decodeDiscountCode>;
  try {
    decoded = decodeDiscountCode(code);
  } catch {
    decoded = { error: 'signing not configured' };
  }
  if (!('error' in decoded)) {
    const byId = await Discount.findById(decoded.id);
    // Defense in depth: the sealed fields must still match the record (a record
    // edited after issuance can't be contradicted by a stale token).
    if (byId && byId.value === decoded.value && byId.unit === decoded.unit && byId.kind === decoded.kind) {
      return byId;
    }
    return null;
  }
  // Aliases are stored upper-cased at mint, so promo codes are case-insensitive.
  return Discount.findOne({ alias: code.toUpperCase(), isActive: true });
}

/**
 * Resolve a `percent`/`dollar` usage credit to cents against a base amount.
 *
 * A `dollar` credit is taken at face value — an operator who authored "$50 off"
 * means $50, and snapping it would quietly pay out $49.99 or $50.99.
 *
 * A `percent` credit is derived from the NET instead of rounded on its own: 15%
 * of $79 is $11.85, and rounding the credit leaves $67.15 on the invoice. This
 * snaps what is still CHARGED up to a whole dollar or .99 and takes the credit as
 * the remainder, so the customer sees $67.99 against a credit of $11.01 that
 * reconciles exactly against the line above it — and the odd cents land in the
 * vendor's favour rather than against.
 */
export function creditCents(discount: Pick<DiscountDocument, 'unit' | 'value'>, baseCents: number): number {
  if (discount.unit === 'dollar') return discount.value;
  return snapNetCharge(baseCents, Math.round((baseCents * discount.value) / 100)).creditCents;
}

export interface DiscountBreakdown {
  interval: 'monthly' | 'annual';
  items: { label: string; cents: number }[];
  subtotalCents: number;
  totalCents: number;
  creditRemainingCents: number;
}

/** A subscription-shaped view of the fields a breakdown reads (real or projected). */
type BreakdownState = {
  interval: string;
  creditBalanceCents?: number;
};

/**
 * Itemized, display-only price breakdown under the usage-credit model: base plan
 * line minus the usage credit consumed this cycle (`min(balance, base)`). Every
 * discount — onetime, recurring, or credit — is a usage credit, so there is a
 * single credit line, never a separate coupon. `creditRemainingCents` carries to
 * future cycles.
 */
function computeDiscountBreakdown(planName: string, prices: { monthly: number; annual: number }, sub: BreakdownState): DiscountBreakdown {
  const interval: 'monthly' | 'annual' = sub.interval === 'annual' ? 'annual' : 'monthly';
  const base = prices[interval];
  const items = [{ label: planName, cents: base }];
  const balance = sub.creditBalanceCents ?? 0;
  const creditApplied = Math.min(balance, base);
  if (creditApplied > 0) items.push({ label: 'Usage credit', cents: -creditApplied });
  return { interval, items, subtotalCents: base, totalCents: base - creditApplied, creditRemainingCents: balance - creditApplied };
}

/** Hypothetical breakdown if `discount` were redeemed now (adds its credit to the balance). */
function projectDiscountBreakdown(planName: string, prices: { monthly: number; annual: number }, sub: BreakdownState, discount: Pick<DiscountDocument, 'kind' | 'unit' | 'value'>): DiscountBreakdown {
  const interval: 'monthly' | 'annual' = sub.interval === 'annual' ? 'annual' : 'monthly';
  const projected: BreakdownState = {
    interval,
    creditBalanceCents: (sub.creditBalanceCents ?? 0) + creditCents(discount, prices[interval]),
  };
  return computeDiscountBreakdown(planName, prices, projected);
}

/** Loaded subscription + plan for an org, or a typed error. */
type LoadedSubPlan =
  | { ok: true; subscription: SubscriptionDocument; plan: { name: string; tier: string; prices: { monthly: number; annual: number } } }
  | { ok: false; status: number; error: string; code?: string };

async function loadSubPlan(orgId: string): Promise<LoadedSubPlan> {
  const subscription = await loadManageableSubscription(orgId);
  if (!subscription) return { ok: false, status: 404, error: 'No active subscription' };
  const plan = await Plan.findById(subscription.planId).lean();
  if (!plan) return { ok: false, status: 404, error: 'Subscription plan not found' };
  return { ok: true, subscription, plan };
}

/** Read-only applicability check shared by apply + preview (no reserve/mutate). */
function validateApplicable(
  orgId: string,
  discount: DiscountDocument,
  subscription: SubscriptionDocument,
  plan: { tier: string },
): { status: number; error: string; code?: string } | null {
  if (!discountAllowedForProvider()) {
    return { status: 409, error: 'Discounts are not available for Marketplace-billed accounts', code: 'DISCOUNTS_UNSUPPORTED' };
  }
  if (discount.targetOrgId && discount.targetOrgId !== orgId) {
    return { status: 403, error: 'This discount is not valid for your account', code: 'DISCOUNT_NOT_FOR_ORG' };
  }
  if (!discount.isActive) return { status: 409, error: 'This discount is no longer active', code: 'DISCOUNT_INACTIVE' };
  if (discount.redeemBy && discount.redeemBy.getTime() < Date.now()) {
    return { status: 409, error: 'This discount has expired', code: 'DISCOUNT_EXPIRED' };
  }
  if (!(REDEEMABLE_STATUSES as readonly string[]).includes(subscription.status)) {
    return { status: 409, error: `A discount cannot be applied to a ${subscription.status} subscription`, code: 'SUBSCRIPTION_NOT_REDEEMABLE' };
  }
  if (discount.appliesToTiers?.length && !discount.appliesToTiers.includes(plan.tier)) {
    return { status: 400, error: `This discount is not available on the ${plan.tier} plan`, code: 'DISCOUNT_TIER_MISMATCH' };
  }
  // A discount already redeemed by this account can't be redeemed again.
  if (subscription.creditLedger.some((c) => c.discountId === discount._id)) {
    return { status: 409, error: 'This discount has already been redeemed', code: 'ALREADY_REDEEMED' };
  }
  // One standing recurring discount at a time.
  if (discount.kind === 'recurring' && subscription.recurringDiscount) {
    return { status: 409, error: 'A recurring discount is already active — remove it first', code: 'RECURRING_ALREADY_PRESENT' };
  }
  return null;
}

export type PreviewResult =
  | { ok: true; kind: DiscountKind; breakdown: DiscountBreakdown }
  | { ok: false; status: number; error: string; code?: string };

/** Dry-run: validate + project the breakdown without reserving or mutating. */
export async function previewDiscountForOrg(orgId: string, discount: DiscountDocument): Promise<PreviewResult> {
  const loaded = await loadSubPlan(orgId);
  if (!loaded.ok) return loaded;
  const invalid = validateApplicable(orgId, discount, loaded.subscription, loaded.plan);
  if (invalid) return { ok: false, ...invalid };
  return {
    ok: true,
    kind: discount.kind,
    breakdown: projectDiscountBreakdown(loaded.plan.name, loaded.plan.prices, loaded.subscription, discount),
  };
}

/**
 * The aggregate discount floor: what an invoice must still charge.
 *
 * `config.discounts.maxPercent` bounds ONE coupon at mint time. Nothing bounded
 * the stack, and four reductions compose on the same list — the annual interval,
 * a volume curve, a combo credit, and a coupon — as additive CREDITS rather than
 * compounding factors. A scoped coupon therefore takes a second slice of a base a
 * volume curve has already discounted, and the two do not know about each other.
 *
 * Returns the breach when the proposed credit would push the invoice below the
 * floor, and `null` when it fits. REFUSES rather than clamping: a silent partial
 * credit looks to the customer like the code half-worked, and "this code cannot
 * be combined with the discounts already on this account" is a sentence support
 * can act on. Clamping would also make the outcome depend on redemption ORDER,
 * so the same two codes applied in the other sequence would give a different
 * total.
 *
 * The floor is measured against LIST — plan plus add-ons at unit x quantity for
 * the interval — so the annual interval's own ~17% is inside the budget too.
 * That is deliberate: a floor that re-based itself on the annual price would let
 * the stack cut deeper on annual than on monthly, which is backwards.
 */
export interface FloorBreach {
  listCents: number;
  standingCreditCents: number;
  proposedCreditCents: number;
  /** The most this redemption could add without breaching. Never negative. */
  headroomCents: number;
  floorPercent: number;
}

export function discountFloorBreach(
  planPriceCents: number,
  addons: readonly { bundleId: string; quantity: number }[],
  interval: BillingInterval,
  proposedCreditCents: number,
  kind: DiscountKind,
): FloorBreach | null {
  const floorPercent = config.discounts.floorPercent;
  // `!(x > 0)` rather than `x <= 0`, which is FALSE for both undefined and NaN —
  // so a missing setting would have fallen through to `100 - undefined` = NaN,
  // and `credits <= NaN` is false, i.e. every redemption reads as a breach. A
  // config value that cannot be read must disable the floor, never refuse
  // silently on behalf of one.
  if (!(floorPercent > 0) || proposedCreditCents <= 0) return null;
  // A one-time `credit` is a PREPAYMENT, not a price reduction: a goodwill or
  // migration credit is MEANT to exceed one invoice and draw down over several,
  // which is why `creditBalanceCents` banks a remainder and the provider balance
  // outlives the period. Flooring it would refuse a $50 apology on a $39 invoice,
  // and the instrument that bounds it is `maxCents` ($20,000), not this. The floor
  // exists for the reductions that compose against the SAME invoice — `onetime`
  // and `recurring` — and that distinction is why this takes `kind` rather than
  // inferring from `unit`: a recurring DOLLAR discount is still a standing price
  // cut and belongs inside the floor.
  if (kind === 'credit') return null;

  const bundles = getBundleCatalog();
  // LIST, not what the provider will charge: unit x quantity, before any credit.
  let listCents = planPriceCents;
  for (const a of addons) {
    const b = bundles.find((x) => x.id === a.bundleId);
    if (!b) continue;
    listCents += priceForInterval(b.prices, interval) * Math.max(0, Math.trunc(a.quantity));
  }
  if (listCents <= 0) return null;

  // Everything already standing against this composition. Both are pure and are
  // the SAME functions the invoice reconciler grants from, so this cannot
  // disagree with what the customer is actually credited.
  const standingCreditCents =
    activeComboCredits(addons, bundles, getComboDiscounts(), interval).reduce((n, c) => n + c.creditCents, 0)
    + volumeCredits(addons, bundles, interval).reduce((n, c) => n + c.creditCents, 0);

  const budgetCents = Math.floor((listCents * (100 - floorPercent)) / 100);
  const headroomCents = Math.max(0, budgetCents - standingCreditCents);
  if (standingCreditCents + proposedCreditCents <= budgetCents) return null;
  return { listCents, standingCreditCents, proposedCreditCents, headroomCents, floorPercent };
}

export type ApplyResult =
  | { ok: true; subscription: SubscriptionDocument; kind: DiscountKind; cents: number; breakdown: DiscountBreakdown }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Apply a validated discount to an org's subscription (shared by the system
 * direct-grant path and self-service redemption). Price-only — never touches
 * entitlements/quota.
 *
 * Ordering: validate → RESERVE (atomic `$inc` under the `maxRedemptions` guard,
 * so concurrent redemptions can't exceed the cap) → provider push (Stripe
 * coupon / usage-credit balance, idempotency-keyed) → mutate the subscription.
 * Any failure after the reserve COMPENSATES it (`$inc -1`) so a redemption is
 * never burned by a downstream error.
 */
export async function applyDiscountToOrg(
  orgId: string,
  discount: DiscountDocument,
  actorId?: string,
): Promise<ApplyResult> {
  const loaded = await loadSubPlan(orgId);
  if (!loaded.ok) return loaded;
  const { subscription, plan } = loaded;

  const invalid = validateApplicable(orgId, discount, subscription, plan);
  if (invalid) return { ok: false, ...invalid };

  // The aggregate floor, checked BEFORE the reserve: a refusal here must not
  // burn one of a limited code's redemptions. Both values are derived from the
  // live composition rather than stored, so adding or dropping an add-on moves
  // the answer with no separate trigger.
  const intervalPrice = priceForInterval(plan.prices, subscription.interval);
  const proposed = creditCents(
    discount,
    discountBaseCents(discount, intervalPrice, subscription.addons ?? [], getBundleCatalog(), subscription.interval),
  );
  const breach = discountFloorBreach(intervalPrice, subscription.addons ?? [], subscription.interval, proposed, discount.kind);
  if (breach) {
    logger.warn('Refused a discount that would breach the aggregate floor', {
      orgId, discountId: String(discount._id), ...breach,
    });
    incCounter('billing_discount_floor_refused_total', { kind: discount.kind });
    return {
      ok: false,
      status: 409,
      error: `This discount cannot be combined with the discounts already on this account — it would take the invoice below ${breach.floorPercent}% of list.`,
      code: 'DISCOUNT_FLOOR_BREACHED',
    };
  }

  // RESERVE — atomically claim a redemption under the cap.
  const filter: Record<string, unknown> = { _id: discount._id, isActive: true };
  if (discount.maxRedemptions != null) filter.$expr = { $lt: ['$timesRedeemed', '$maxRedemptions'] };
  const reserved = await Discount.findOneAndUpdate(filter, { $inc: { timesRedeemed: 1 } }, { new: true });
  if (!reserved) {
    return { ok: false, status: 409, error: 'This discount is no longer available', code: 'DISCOUNT_EXHAUSTED' };
  }

  const base = discountBaseCents(
    discount, priceForInterval(plan.prices, subscription.interval),
    subscription.addons ?? [], getBundleCatalog(), subscription.interval,
  );
  const cents = creditCents(discount, base);
  try {
    // Realize at the provider FIRST — the call is idempotency-keyed on
    // (org, discount), so two concurrent same-org redemptions dedupe at the
    // provider and never double-charge the customer balance.
    const ref = await realizeUsageCredit(subscription, cents, creditIdemSeed(orgId, discount._id));

    // Commit the local credit ATOMICALLY, guarded on "this org hasn't already
    // redeemed this discount" (M1). Two concurrent same-org redemptions can't both
    // bank it — the loser trips the guard → ALREADY_REDEEMED — and, being one
    // `findOneAndUpdate` rather than a full-doc `save()`, it also can't clobber a
    // concurrent add-on / credit write (M2). A recurring discount sets its standing
    // rule in the same atomic update.
    const update: Record<string, unknown> = {
      $push: { creditLedger: creditLedgerEntry({ discountId: discount._id, cents, fulfillmentRef: ref }) },
      $inc: { creditBalanceCents: cents },
    };
    if (discount.kind === 'recurring') {
      update.$set = {
        recurringDiscount: {
          discountId: discount._id,
          unit: discount.unit,
          value: discount.value,
          ...(discount.appliesToBundles?.length ? { appliesToBundles: discount.appliesToBundles } : {}),
          appliedAt: new Date(),
        },
      };
    }
    const committed = await Subscription.findOneAndUpdate(
      { '_id': subscription._id, 'creditLedger.discountId': { $ne: discount._id } },
      update,
      { new: true },
    );
    if (!committed) {
      // A concurrent redemption already banked this discount — release our
      // reservation (the provider credit, if any, was deduped by the idem key).
      await Discount.findByIdAndUpdate(discount._id, { $inc: { timesRedeemed: -1 } }).catch(() => undefined);
      return { ok: false, status: 409, error: 'This discount has already been redeemed', code: 'ALREADY_REDEEMED' };
    }
    await createBillingEvent(orgId, 'credit_applied', { discountId: discount._id, cents }, committed._id.toString(), actorId);
    incCounter('billing_credit_applied_total', {});
    logger.info('Discount redeemed as usage credit', { orgId, discountId: discount._id, kind: discount.kind, cents });
    return { ok: true, subscription: committed, kind: discount.kind, cents, breakdown: computeDiscountBreakdown(plan.name, plan.prices, committed) };
  } catch (error) {
    // Compensate the reservation so a failed push/mutate never burns a redemption.
    await Discount.findByIdAndUpdate(discount._id, { $inc: { timesRedeemed: -1 } }).catch(() => undefined);
    throw error;
  }
}

/** Post the credit to the provider (idempotency-keyed customer-balance credit,
 *  when supported + an external customer exists). Returns the fulfillment ref for
 *  the ledger row, or undefined when the provider doesn't realize credits. */
async function realizeUsageCredit(subscription: SubscriptionDocument, cents: number, idemSeed: string): Promise<{ kind: string; ref: string } | undefined> {
  const provider = getPaymentProvider();
  if (provider.applyUsageCredit && provider.usageCreditSupport !== 'none' && subscription.externalCustomerId) {
    const result = await provider.applyUsageCredit(subscription.externalCustomerId, cents, `discount-apply-${idemSeed}`);
    return result.ref;
  }
  return undefined;
}

/**
 * Grant a usage credit of `cents`: post it to the provider (customer balance,
 * when supported + an external customer exists), bank it on the subscription
 * mirror + ledger, and emit `credit_applied`. Mutates `subscription` in place;
 * the caller saves. `idemSeed` dedupes the provider grant.
 */
async function grantUsageCredit(subscription: SubscriptionDocument, discountId: string, cents: number, idemSeed: string, actorId?: string, dedupeKey?: string, atomic = false): Promise<void> {
  const ref = await realizeUsageCredit(subscription, cents, idemSeed);

  if (atomic) {
    // Stripe-webhook path: persist the credit with a guarded atomic write instead
    // of an in-memory push the caller full-saves — so a concurrent redemption's
    // $push to the SAME ledger can't be clobbered (M2). The guard also makes the
    // grant idempotent per period (dedupeKey) / per discount, so a redelivered
    // webhook can't double-grant. The in-memory doc is deliberately NOT mutated:
    // the caller's `save()` then persists only its own lifecycle fields.
    const guard = dedupeKey
      ? { creditLedger: { $not: { $elemMatch: { discountId, dedupeKey } } } }
      : { 'creditLedger.discountId': { $ne: discountId } };
    const committed = await Subscription.findOneAndUpdate(
      { _id: subscription._id, ...guard },
      { $push: { creditLedger: creditLedgerEntry({ discountId, cents, fulfillmentRef: ref, dedupeKey }) }, $inc: { creditBalanceCents: cents } },
      { new: true },
    );
    if (!committed) return; // already granted (concurrent / redelivery) — no double-grant
    await createBillingEvent(subscription.orgId, 'credit_applied', { discountId, cents }, subscription._id.toString(), actorId);
    incCounter('billing_credit_applied_total', {});
    return;
  }

  // Marketplace path: in-memory mutation; the metering cycle saves the (period-
  // claimed) doc.
  subscription.creditBalanceCents = (subscription.creditBalanceCents ?? 0) + cents;
  subscription.creditLedger.push(creditLedgerEntry({ discountId, cents, fulfillmentRef: ref, dedupeKey }));
  await createBillingEvent(subscription.orgId, 'credit_applied', { discountId, cents }, subscription._id.toString(), actorId);
  // Observability parity with promotions (billing_promotion_granted_total): make a
  // spike in discount/credit spend alertable rather than only a billing_events row.
  incCounter('billing_credit_applied_total', {});
}

// ─── Lifecycle: source-of-truth reconciliation ─────────────────────

/** Invoice fields the discount reconciler reads (Stripe is source of truth). */
export interface InvoiceLike {
  /** Invoice id — seeds the per-period idempotency key for a recurring re-grant. */
  id?: string;
  /** Customer balance AFTER this invoice, in cents — NEGATIVE = credit remaining. */
  ending_balance?: number | null;
}

/**
 * Reconcile a subscription's usage credits against a just-settled invoice —
 * Stripe is the source of truth, the local balance is a mirror. Draws the
 * balance down from the customer's ending balance (emitting `credit_exhausted`
 * at zero), then RE-GRANTS a `recurring` discount's credit for the upcoming
 * period (resolved fresh from the current plan price, so a percent discount
 * tracks plan changes). Mutates `subscription` in place; the caller saves. No-op
 * for a subscription that carries no discounts.
 */
export async function reconcileDiscountsOnInvoice(subscription: SubscriptionDocument, invoice: InvoiceLike): Promise<void> {
  const orgId = subscription.orgId;

  // Guard: this reconciler is Stripe-only — step 1 treats the Stripe customer
  // balance as the source of truth and overwrites the local mirror. On Marketplace
  // the mirror IS authoritative (drawn down by metered withholding, no Stripe
  // balance to reconcile against), so a stray Stripe path must never clobber it.
  if ((subscription.metadata?.provider) === 'aws-marketplace') return;

  // 1. Draw down the mirror from the Stripe customer balance (negative = credit
  //    left). Persisted ATOMICALLY (not in-memory + the caller's full save) so the
  //    payment webhook can't clobber a concurrent redemption's credit write (M2).
  const endBal = invoice.ending_balance ?? null;
  const prev = subscription.creditBalanceCents ?? 0;
  if (endBal != null && (prev > 0 || endBal < 0)) {
    const mirrored = endBal < 0 ? -endBal : 0;
    if (mirrored !== prev) {
      await Subscription.updateOne({ _id: subscription._id }, { $set: { creditBalanceCents: mirrored } });
      if (mirrored === 0 && prev > 0) {
        await createBillingEvent(orgId, 'credit_exhausted', { previousCents: prev }, subscription._id.toString());
      }
    }
  }

  // 2+3. Re-grant the recurring + combo credits for THIS CALENDAR PERIOD (atomic,
  // Stripe path). Keying on a calendar period (not the invoice id) makes the
  // re-grant idempotent when more than one invoice settles in the same period — a
  // proration / one-off / out-of-cycle invoice reuses the period key and hits the
  // ledger dedupe instead of double-crediting the account.
  await grantPeriodicCredits(subscription, billingPeriodKey(subscription.interval), { atomic: true });
}

/**
 * Re-grant a subscription's PERIODIC usage credits for one billing period — the
 * standing `recurring` discount (resolved fresh from the current plan price, so a
 * percent tracks plan changes) and any active combo credits (derived from the live
 * add-on composition). Idempotent per `periodKey` on `(discountId, dedupeKey)`.
 * A revoked/expired recurring rule is stopped (emitting `discount_expired`) so it
 * can't leak credits. Mutates `subscription` in place; the caller saves.
 *
 * Shared realization for both providers: the Stripe invoice reconciler passes the
 * invoice id, the Marketplace metering cycle passes a calendar period key
 * (`YYYY` / `YYYY-MM`) since Marketplace has no invoices to drive it.
 */
export async function grantPeriodicCredits(subscription: SubscriptionDocument, periodKey: string, opts: { atomic?: boolean } = {}): Promise<void> {
  // Symmetric across providers: when the discount surface is off, neither Stripe
  // (invoice reconcile) nor Marketplace (metering cycle) re-grants — otherwise a
  // standing recurring/combo credit would keep topping up on Stripe after the flag
  // is flipped. Existing banked balance still drains; only NEW grants stop.
  if (!discountsEnabled()) return;
  const orgId = subscription.orgId;
  const { atomic = false } = opts;

  // Standing recurring discount.
  const rd = subscription.recurringDiscount;
  if (rd) {
    // Stop re-granting once the discount is revoked / expired / deleted — the
    // standing rule alone would otherwise leak credits forever after a revoke.
    const discount = await Discount.findById(rd.discountId);
    if (!discount || !discount.isActive || (discount.redeemBy && discount.redeemBy.getTime() < Date.now())) {
      // Atomic path (Stripe): persist the expiry without a full-doc save so it
      // can't clobber a concurrent credit write.
      if (atomic) await Subscription.updateOne({ _id: subscription._id }, { $set: { recurringDiscount: null } });
      else subscription.recurringDiscount = null;
      await createBillingEvent(orgId, 'discount_expired', { discountId: rd.discountId, reason: 'recurring_ended' }, subscription._id.toString());
    } else if (!subscription.creditLedger.some((c) => c.discountId === rd.discountId && c.dedupeKey === periodKey)) {
      // Idempotent per period: a redelivered webhook / repeated cycle must not double-grant.
      const plan = await Plan.findById(subscription.planId).lean();
      if (plan) {
        // Recomputed every period, so a scoped percent discount tracks the
        // account's CURRENT add-on quantities the same way an unscoped one
        // tracks plan changes.
        const base = discountBaseCents(
          rd, priceForInterval(plan.prices, subscription.interval),
          subscription.addons ?? [], getBundleCatalog(), subscription.interval,
        );
        const cents = creditCents(rd, base);
        if (cents > 0) {
          await grantUsageCredit(subscription, rd.discountId, cents, creditIdemSeed(orgId, rd.discountId, periodKey), undefined, periodKey, atomic);
        }
      }
    }
  }

  // Combo credits, derived fresh from the CURRENT add-on composition (no standing
  // rule: holding the members IS the rule). Idempotent per period on `combo:<id>`.
  for (const combo of activeComboCredits(subscription.addons ?? [], getBundleCatalog(), getComboDiscounts(), subscription.interval)) {
    const discountId = comboLedgerId(combo.comboId);
    if (subscription.creditLedger.some((c) => c.discountId === discountId && c.dedupeKey === periodKey)) continue;
    await grantUsageCredit(subscription, discountId, combo.creditCents, creditIdemSeed(orgId, discountId, periodKey), undefined, periodKey, atomic);
  }

  // Volume credits (per-unit tier discount on a stackable pack, e.g. `seat`),
  // derived fresh from the CURRENT quantity — same recurring-credit mechanism as
  // combos. Idempotent per period on `volume:<bundleId>`.
  for (const vol of volumeCredits(subscription.addons ?? [], getBundleCatalog(), subscription.interval)) {
    const discountId = volumeLedgerId(vol.bundleId);
    if (subscription.creditLedger.some((c) => c.discountId === discountId && c.dedupeKey === periodKey)) continue;
    await grantUsageCredit(subscription, discountId, vol.creditCents, creditIdemSeed(orgId, discountId, periodKey), undefined, periodKey, atomic);
  }

  // Bound the ledger's growth: fold old per-period rows into per-family carry
  // rows. In-memory path only — see compactInMemoryLedger for why.
  compactInMemoryLedger(subscription, atomic);
}

/**
 * Clear a subscription's discounts on cancellation: stop the standing recurring
 * rule and forfeit the LOCAL usage-credit mirror. The Stripe customer balance
 * persists on the customer for a future reactivation; a recurring discount is
 * NOT auto-resumed (it must be re-redeemed). Mutates in place; caller saves.
 */
export function clearDiscountsOnCancel(subscription: SubscriptionDocument): void {
  subscription.recurringDiscount = null;
  subscription.creditBalanceCents = 0;
}
