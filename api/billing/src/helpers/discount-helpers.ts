// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { createLogger } from '@pipeline-builder/api-core';
import { config } from '../config.js';
import { createBillingEvent, getBundleCatalog, MANAGEABLE_SUBSCRIPTION_STATUSES } from './billing-helpers.js';
import { activeComboCredits, comboLedgerId, getComboDiscounts, priceForInterval } from './combo-pricing.js';
import { compactCreditLedger } from './credit-ledger-compaction.js';
import { decodeDiscountCode, type DiscountSpec, type DiscountKind } from './discount-code.js';
import { Discount } from '../models/discount.js';
import type { DiscountDocument } from '../models/discount.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';
import type { SubscriptionDocument } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('discount-helpers');

/** Statuses that may hold/redeem a discount (a coupon applies post-trial). */
const REDEEMABLE_STATUSES = ['active', 'trialing'] as const;

/** Feature flag — the discount surface is off unless BILLING_DISCOUNTS_ENABLED=true. */
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
export function discountAllowedForProvider(): boolean {
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

/** Load the account's manageable subscription (active/trialing/past_due). */
export async function loadManageableSubscription(orgId: string): Promise<SubscriptionDocument | null> {
  return Subscription.findOne({ orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] } });
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

/** Resolve a `percent`/`dollar` usage credit to cents against the plan price. */
export function creditCents(discount: Pick<DiscountDocument, 'unit' | 'value'>, planPriceCents: number): number {
  return discount.unit === 'dollar' ? discount.value : Math.round((planPriceCents * discount.value) / 100);
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
export function computeDiscountBreakdown(planName: string, prices: { monthly: number; annual: number }, sub: BreakdownState): DiscountBreakdown {
  const interval: 'monthly' | 'annual' = sub.interval === 'annual' ? 'annual' : 'monthly';
  const base = prices[interval];
  const items = [{ label: planName, cents: base }];
  const balance = sub.creditBalanceCents ?? 0;
  const creditApplied = Math.min(balance, base);
  if (creditApplied > 0) items.push({ label: 'Usage credit', cents: -creditApplied });
  return { interval, items, subtotalCents: base, totalCents: base - creditApplied, creditRemainingCents: balance - creditApplied };
}

/** Hypothetical breakdown if `discount` were redeemed now (adds its credit to the balance). */
export function projectDiscountBreakdown(planName: string, prices: { monthly: number; annual: number }, sub: BreakdownState, discount: Pick<DiscountDocument, 'kind' | 'unit' | 'value'>): DiscountBreakdown {
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
export function validateApplicable(
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

  // RESERVE — atomically claim a redemption under the cap.
  const filter: Record<string, unknown> = { _id: discount._id, isActive: true };
  if (discount.maxRedemptions != null) filter.$expr = { $lt: ['$timesRedeemed', '$maxRedemptions'] };
  const reserved = await Discount.findOneAndUpdate(filter, { $inc: { timesRedeemed: 1 } }, { new: true });
  if (!reserved) {
    return { ok: false, status: 409, error: 'This discount is no longer available', code: 'DISCOUNT_EXHAUSTED' };
  }

  const planPriceCents = priceForInterval(plan.prices, subscription.interval);
  const cents = creditCents(discount, planPriceCents);
  try {
    // Grant the usage credit — the ONE mechanism every kind resolves to. A
    // `recurring` discount ALSO records a standing rule so the credit is
    // re-granted each period (see reconcileDiscountsOnInvoice).
    await grantUsageCredit(subscription, discount._id, cents, creditIdemSeed(orgId, discount._id), actorId);
    if (discount.kind === 'recurring') {
      subscription.recurringDiscount = { discountId: discount._id, unit: discount.unit, value: discount.value, appliedAt: new Date() };
    }
    await subscription.save();
    logger.info('Discount redeemed as usage credit', { orgId, discountId: discount._id, kind: discount.kind, cents });
    return { ok: true, subscription, kind: discount.kind, cents, breakdown: computeDiscountBreakdown(plan.name, plan.prices, subscription) };
  } catch (error) {
    // Compensate the reservation so a failed push/mutate never burns a redemption.
    await Discount.findByIdAndUpdate(discount._id, { $inc: { timesRedeemed: -1 } }).catch(() => undefined);
    throw error;
  }
}

/**
 * Grant a usage credit of `cents`: post it to the provider (customer balance,
 * when supported + an external customer exists), bank it on the subscription
 * mirror + ledger, and emit `credit_applied`. Mutates `subscription` in place;
 * the caller saves. `idemSeed` dedupes the provider grant.
 */
async function grantUsageCredit(subscription: SubscriptionDocument, discountId: string, cents: number, idemSeed: string, actorId?: string, dedupeKey?: string): Promise<void> {
  const provider = getPaymentProvider();
  let ref: { kind: string; ref: string } | undefined;
  if (provider.applyUsageCredit && provider.usageCreditSupport !== 'none' && subscription.externalCustomerId) {
    const result = await provider.applyUsageCredit(subscription.externalCustomerId, cents, `discount-apply-${idemSeed}`);
    ref = result.ref;
  }
  subscription.creditBalanceCents = (subscription.creditBalanceCents ?? 0) + cents;
  subscription.creditLedger.push({ discountId, cents, appliedAt: new Date(), fulfillmentRef: ref, dedupeKey });
  await createBillingEvent(subscription.orgId, 'credit_applied', { discountId, cents }, subscription._id.toString(), actorId);
}

// ─── Lifecycle: source-of-truth reconciliation (Phase 6) ────────────

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

  // 1. Draw down the mirror from the Stripe customer balance (negative = credit left).
  const endBal = invoice.ending_balance ?? null;
  const prev = subscription.creditBalanceCents ?? 0;
  if (endBal != null && (prev > 0 || endBal < 0)) {
    const mirrored = endBal < 0 ? -endBal : 0;
    if (mirrored !== prev) {
      subscription.creditBalanceCents = mirrored;
      if (mirrored === 0 && prev > 0) {
        await createBillingEvent(orgId, 'credit_exhausted', { previousCents: prev }, subscription._id.toString());
      }
    }
  }

  // 2+3. Re-grant the recurring + combo credits for the period this invoice opens.
  await grantPeriodicCredits(subscription, invoice.id ?? 'renew');
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
export async function grantPeriodicCredits(subscription: SubscriptionDocument, periodKey: string): Promise<void> {
  // Symmetric across providers: when the discount surface is off, neither Stripe
  // (invoice reconcile) nor Marketplace (metering cycle) re-grants — otherwise a
  // standing recurring/combo credit would keep topping up on Stripe after the flag
  // is flipped. Existing banked balance still drains; only NEW grants stop.
  if (!discountsEnabled()) return;
  const orgId = subscription.orgId;

  // Standing recurring discount.
  const rd = subscription.recurringDiscount;
  if (rd) {
    // Stop re-granting once the discount is revoked / expired / deleted — the
    // standing rule alone would otherwise leak credits forever after a revoke.
    const discount = await Discount.findById(rd.discountId);
    if (!discount || !discount.isActive || (discount.redeemBy && discount.redeemBy.getTime() < Date.now())) {
      subscription.recurringDiscount = null;
      await createBillingEvent(orgId, 'discount_expired', { discountId: rd.discountId, reason: 'recurring_ended' }, subscription._id.toString());
    } else if (!subscription.creditLedger.some((c) => c.discountId === rd.discountId && c.dedupeKey === periodKey)) {
      // Idempotent per period: a redelivered webhook / repeated cycle must not double-grant.
      const plan = await Plan.findById(subscription.planId).lean();
      if (plan) {
        const planPriceCents = priceForInterval(plan.prices, subscription.interval);
        const cents = creditCents(rd, planPriceCents);
        if (cents > 0) {
          await grantUsageCredit(subscription, rd.discountId, cents, creditIdemSeed(orgId, rd.discountId, periodKey), undefined, periodKey);
        }
      }
    }
  }

  // Combo credits, derived fresh from the CURRENT add-on composition (no standing
  // rule: holding the members IS the rule). Idempotent per period on `combo:<id>`.
  for (const combo of activeComboCredits(subscription.addons ?? [], getBundleCatalog(), getComboDiscounts(), subscription.interval)) {
    const discountId = comboLedgerId(combo.comboId);
    if (subscription.creditLedger.some((c) => c.discountId === discountId && c.dedupeKey === periodKey)) continue;
    await grantUsageCredit(subscription, discountId, combo.creditCents, creditIdemSeed(orgId, discountId, periodKey), undefined, periodKey);
  }

  // Bound the ledger's growth: fold old per-period rows into per-family carry rows
  // (the recent-period rows this grant just checked stay intact, so idempotency
  // holds). Only reassign when a fold actually shrank the array — avoids dirtying
  // the doc on the common no-fold path. In-memory; persisted by the caller's save.
  const compacted = compactCreditLedger(subscription.creditLedger);
  if (compacted.length !== subscription.creditLedger.length) subscription.creditLedger = compacted;
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
