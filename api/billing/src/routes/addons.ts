// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  requireAuth,
  requirePermission,
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  getParam,
  validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import type { BundleConfig, ComboDiscountConfig } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import { config } from '../config.js';
import {
  bundleSelfServiceAllowed,
  bundlesEnabled,
  buildSubscriptionResponse,
  checkEntitlementOvercap,
  billingServiceAuth,
  createBillingEvent,
  effectiveEntitlements,
  getBundleCatalog,
  MANAGEABLE_SUBSCRIPTION_STATUSES,
  syncEntitlements,
  syncProviderAddons,
} from '../helpers/billing-helpers.js';
import { activeComboCredits, comboBasisCents, getComboDiscounts } from '../helpers/combo-pricing.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';
import { getAuditClient } from '../services/audit.js';
import { AddonMutateSchema } from '../validation/schemas.js';

const logger = createLogger('billing-addons');
const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

type Addon = { bundleId: string; quantity: number };

/** Set a bundle's quantity in the add-on list (quantity 0 removes it). */
function applyAddon(addons: Addon[], bundleId: string, quantity: number): Addon[] {
  const rest = addons.filter((a) => a.bundleId !== bundleId);
  if (quantity > 0) rest.push({ bundleId, quantity });
  return rest;
}

/** Catalog-time combo savings (`min-composition basket − combined price`, ≥ 0) for
 *  an interval — ownership-independent, for the "pair to save" nudge. Shares
 *  `comboBasisCents` with the credit math so the two can't drift. */
function comboSavings(combo: ComboDiscountConfig, bundles: readonly BundleConfig[], interval: 'monthly' | 'annual'): number {
  return Math.max(0, comboBasisCents(combo, bundles, interval) - combo.prices[interval]);
}

/**
 * Itemized price breakdown: base plan line + one line per add-on, then a NEGATIVE
 * line per active combo discount (e.g. Analytics Suite −$20/mo when both DORA and
 * Team Usage Analytics are held). The combo credit is realized as a recurring
 * usage credit at invoice time; this line shows the customer the net up front so
 * `totalCents` matches what they'll effectively pay.
 */
function priceBreakdown(
  plan: { name: string; prices: { monthly: number; annual: number } },
  addons: Addon[],
  bundles: readonly BundleConfig[],
  interval: 'monthly' | 'annual',
): { interval: string; items: { label: string; quantity: number; cents: number }[]; totalCents: number } {
  const key = interval === 'annual' ? 'annual' : 'monthly';
  const byId = new Map(bundles.map((b) => [b.id, b]));
  const items = [{ label: plan.name, quantity: 1, cents: plan.prices[key] }];
  for (const a of addons) {
    const b = byId.get(a.bundleId);
    if (b) items.push({ label: b.name, quantity: a.quantity, cents: b.prices[key] * a.quantity });
  }
  for (const combo of activeComboCredits(addons, bundles, getComboDiscounts(), interval)) {
    items.push({ label: `${combo.name} discount`, quantity: 1, cents: -combo.creditCents });
  }
  return { interval, items, totalCents: items.reduce((s, i) => s + i.cents, 0) };
}

/** A combo gained/lost by a proposed add-on change (drives the removal warning + the
 *  `combo_expired` event). */
type ComboChange = { comboId: string; name: string; creditCents: number };

/**
 * The combo discounts LOST and GAINED moving from `current` → `next` add-ons. Diffed
 * on the packed active set (so it reflects real max-weight packing, not raw membership).
 */
function comboDelta(
  current: Addon[],
  next: Addon[],
  bundles: readonly BundleConfig[],
  interval: 'monthly' | 'annual',
): { lostCombos: ComboChange[]; gainedCombos: ComboChange[] } {
  const combos = getComboDiscounts();
  const before = activeComboCredits(current, bundles, combos, interval);
  const after = activeComboCredits(next, bundles, combos, interval);
  const afterIds = new Set(after.map((c) => c.comboId));
  const beforeIds = new Set(before.map((c) => c.comboId));
  return {
    lostCombos: before.filter((c) => !afterIds.has(c.comboId)),
    gainedCombos: after.filter((c) => !beforeIds.has(c.comboId)),
  };
}

/**
 * Add-on bundle management routes (root-org billing; behind
 * `BILLING_BUNDLES_ENABLED`). See docs/billing-bundles.md §7/§7a.
 *
 * - POST   /subscriptions/:id/addons/preview  — dry-run effective limits + price
 * - POST   /subscriptions/:id/addons          — add/set a bundle quantity
 * - DELETE /subscriptions/:id/addons/:bundleId — remove a bundle
 */
export function createAddonRoutes(): Router {
  const router: Router = Router();

  /** Load the org's active subscription + its plan; 404 helpers via thrown nulls. */
  async function loadSubAndPlan(orgId: string) {
    // Trialing / past_due subs manage add-ons too (a trial account may buy seat
    // packs; a past_due account still owns its bundles) — not just active.
    const subscription = await Subscription.findOne({ orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] } });
    if (!subscription) return null;
    const plan = await Plan.findById(subscription.planId).lean();
    if (!plan) return null;
    return { subscription, plan };
  }

  /**
   * Guard the `:id` path param against the org's loaded active subscription.
   * The routes are keyed by subscription id, but `loadSubAndPlan` resolves the
   * org's active sub by orgId — without this check the id in the URL is
   * decorative and a caller could target one sub's id while mutating another.
   * When `:id` is absent (never true for the mounted routes; only in unit
   * tests that invoke the handler directly) the check is skipped.
   */
  function subscriptionIdMatches(req: Request, subscription: { _id: { toString(): string } }): boolean {
    const id = getParam(req.params, 'id');
    return !id || subscription._id.toString() === id;
  }

  // GET /billing/bundles — the add-on catalog filtered to the account's tier
  router.get('/bundles', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:read') as RequestHandler, withRoute(async ({ res, orgId }) => {
    if (!bundlesEnabled()) return sendSuccess(res, 200, { bundles: [], selfService: false, comboDiscounts: [] });
    const loaded = await loadSubAndPlan(orgId);
    const tier = loaded?.plan.tier;
    const bundles = getBundleCatalog().filter((b) => b.isActive && (!tier || b.availableForTiers.includes(tier)));
    // Only advertise a combo whose every member is purchasable on this tier —
    // otherwise the "pair them to save" nudge points at a bundle the account
    // can't buy. Expose the per-interval savings so the UI needn't recompute it.
    const offered = new Set(bundles.map((b) => b.id));
    const comboDiscounts = getComboDiscounts()
      .filter((c) => c.bundleIds.length >= 2 && c.bundleIds.every((id) => offered.has(id)))
      .map((c) => ({
        id: c.id,
        name: c.name,
        bundleIds: c.bundleIds,
        ...(c.minQuantities ? { minQuantities: c.minQuantities } : {}),
        savings: {
          monthly: comboSavings(c, bundles, 'monthly'),
          annual: comboSavings(c, bundles, 'annual'),
        },
      }));
    // selfService=false for Marketplace-billed accounts: the catalog is still
    // returned (so the UI can explain add-ons are managed in AWS) but the
    // add/remove mutations are 403-gated. See bundleSelfServiceAllowed().
    return sendSuccess(res, 200, { bundles, selfService: bundleSelfServiceAllowed(), comboDiscounts });
  }));

  // POST /billing/portal — hosted session to add/update a payment method. Powers
  // the "Add a payment method" CTA shown after a 402 PAYMENT_METHOD_REQUIRED.
  router.post('/portal', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    // A past_due account is exactly who needs the hosted portal (to add/fix a
    // payment method and stop dunning), so include the full non-terminal set.
    const subscription = await Subscription.findOne({ orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] } });
    if (!subscription?.externalCustomerId) return sendError(res, 404, 'No billing customer for this account');

    const provider = getPaymentProvider();
    if (!provider.createBillingPortalSession) {
      return sendError(res, 501, 'The configured billing provider has no hosted payment portal');
    }

    // Land the user back on the billing page. Prefer the request Origin (works
    // across every deploy host); fall back to the configured frontend URL.
    const origin = (req.headers.origin as string | undefined) || config.frontendUrl;
    if (!origin) return sendError(res, 500, 'Cannot determine a return URL for the billing portal');
    const returnUrl = `${origin.replace(/\/$/, '')}/dashboard/billing`;

    const url = await provider.createBillingPortalSession(subscription.externalCustomerId, returnUrl);
    return sendSuccess(res, 200, { url });
  }));

  // POST /billing/subscriptions/:id/addons/preview
  router.post('/subscriptions/:id/addons/preview', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:read') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!bundlesEnabled()) return sendError(res, 404, 'Add-on bundles are not enabled');
    if (!bundleSelfServiceAllowed()) return sendError(res, 403, 'Add-ons for Marketplace-billed accounts are managed in AWS Marketplace');
    const validation = validateBody(req, AddonMutateSchema);
    if (!validation.ok) return sendError(res, 400, validation.error);
    const { bundleId, quantity } = validation.value;

    const loaded = await loadSubAndPlan(orgId);
    if (!loaded) return sendError(res, 404, 'No active subscription');
    const { subscription, plan } = loaded;
    if (!subscriptionIdMatches(req, subscription)) return sendError(res, 404, 'Subscription not found', ErrorCode.NOT_FOUND);

    const bundles = getBundleCatalog();
    const bundle = bundles.find((b) => b.id === bundleId && b.isActive);
    if (!bundle) return sendError(res, 400, `Unknown bundle "${bundleId}"`);
    if (!bundle.availableForTiers.includes(plan.tier)) {
      return sendError(res, 400, `Bundle "${bundleId}" is not available on the ${plan.tier} plan`);
    }

    const qty = bundle.stackable ? Math.max(0, Math.trunc(quantity ?? 1)) : (quantity && quantity > 0 ? 1 : 0);
    const current = (subscription.addons ?? []) as Addon[];
    const next = applyAddon(current, bundleId, qty);
    const { limits } = effectiveEntitlements(plan.tier, next, bundles);

    return sendSuccess(res, 200, {
      addons: next,
      effectiveLimits: limits,
      priceBreakdown: priceBreakdown(plan, next, bundles, subscription.interval),
      ...comboDelta(current, next, bundles, subscription.interval),
    });
  }));

  // POST /billing/subscriptions/:id/addons — add or set a bundle quantity
  router.post('/subscriptions/:id/addons', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!bundlesEnabled()) return sendError(res, 404, 'Add-on bundles are not enabled');
    if (!bundleSelfServiceAllowed()) return sendError(res, 403, 'Add-ons for Marketplace-billed accounts are managed in AWS Marketplace');
    const validation = validateBody(req, AddonMutateSchema);
    if (!validation.ok) return sendError(res, 400, validation.error);
    const { bundleId, quantity } = validation.value;

    const loaded = await loadSubAndPlan(orgId);
    if (!loaded) return sendError(res, 404, 'No active subscription');
    const { subscription, plan } = loaded;
    if (!subscriptionIdMatches(req, subscription)) return sendError(res, 404, 'Subscription not found', ErrorCode.NOT_FOUND);

    const bundles = getBundleCatalog();
    const bundle = bundles.find((b) => b.id === bundleId && b.isActive);
    if (!bundle) return sendError(res, 400, `Unknown bundle "${bundleId}"`);
    if (!bundle.availableForTiers.includes(plan.tier)) {
      return sendError(res, 400, `Bundle "${bundleId}" is not available on the ${plan.tier} plan`);
    }

    // Stackable packs take a quantity (>=1); boolean feature bundles are qty 1.
    const qty = bundle.stackable ? Math.max(1, Math.trunc(quantity ?? 1)) : 1;
    const current = (subscription.addons ?? []) as Addon[];
    const next = applyAddon(current, bundleId, qty);

    // Payment-method gate: a paid INCREASE needs a card on file so the charge can
    // settle. Matters most on the free (developer) tier, which may have no card
    // yet. Providers that don't manage cards (stub) expose no check → allowed.
    const currentQty = current.find((a) => a.bundleId === bundleId)?.quantity ?? 0;
    const unitPrice = subscription.interval === 'annual' ? bundle.prices.annual : bundle.prices.monthly;
    if (qty > currentQty && unitPrice > 0) {
      const provider = getPaymentProvider();
      const chargeable = provider.hasPaymentMethod
        ? await provider.hasPaymentMethod(subscription.externalCustomerId ?? '').catch(() => false)
        : true;
      if (!chargeable) {
        return sendError(res, 402, 'Add a payment method before purchasing add-ons', 'PAYMENT_METHOD_REQUIRED');
      }
    }

    // Over-cap gate (docs §8): reducing a pack below current usage is blocked
    // (an increase never trips it). Structured details drive the UI's "remove N".
    const overages = await checkEntitlementOvercap(orgId, plan.tier, next, '');
    if (overages.length > 0) {
      return sendError(res, 409, 'This change would put the account over its limit — remove members/resources first', 'ADDON_OVER_CAP', { overages });
    }

    subscription.addons = next;
    await subscription.save();

    // Recompute + push EFFECTIVE entitlements (tier + all add-ons) to both
    // targets (quota + platform). Root-scoped service token.
    const serviceAuth = billingServiceAuth(orgId);
    await syncEntitlements(orgId, plan.tier, serviceAuth, subscription._id.toString(), next);
    await syncProviderAddons(subscription.externalId, next, subscription.interval, orgId, subscription._id.toString(), 'addon_add');
    await createBillingEvent(orgId, 'subscription_updated', { reason: 'addon_added', bundleId, quantity: qty }, subscription._id.toString(), req.user?.sub);

    // Mirror the add-on purchase to the CENTRAL audit trail (alongside the local
    // billing_events row). Fire-and-forget; details are an explicit id/quantity
    // whitelist — no card/payment secret or AWS account id can leak.
    getAuditClient().record({
      action: 'billing.addon.add',
      actorId: req.user?.sub ?? 'system',
      orgId,
      targetId: bundleId,
      details: { bundleId, quantity: qty, subscriptionId: subscription._id.toString() },
    }, 'billing');

    logger.info('Add-on applied', { orgId, bundleId, quantity: qty });

    // A combo can end even on an ADD when the new packing drops a lower-value combo
    // that shared a member. Record combo_expired for any combo the change lost.
    const delta = comboDelta(current, next, bundles, subscription.interval);
    for (const c of delta.lostCombos) {
      await createBillingEvent(orgId, 'combo_expired', { comboId: c.comboId }, subscription._id.toString(), req.user?.sub);
      getAuditClient().record({
        action: 'billing.combo.expired',
        actorId: req.user?.sub ?? 'system',
        orgId,
        targetId: c.comboId,
        details: { comboId: c.comboId, creditCents: c.creditCents, subscriptionId: subscription._id.toString() },
      }, 'billing');
    }

    const { limits } = effectiveEntitlements(plan.tier, next, bundles);
    return sendSuccess(res, 200, {
      subscription: buildSubscriptionResponse(subscription, plan.name, plan.tier),
      addons: next,
      effectiveLimits: limits,
      priceBreakdown: priceBreakdown(plan, next, bundles, subscription.interval),
      ...delta,
    });
  }));

  // DELETE /billing/subscriptions/:id/addons/:bundleId — remove a bundle.
  // The over-cap gate below blocks a removal that would drop a pooled cap under
  // current usage (docs/billing-bundles.md §8); otherwise it removes + re-syncs.
  router.delete('/subscriptions/:id/addons/:bundleId', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!bundlesEnabled()) return sendError(res, 404, 'Add-on bundles are not enabled');
    if (!bundleSelfServiceAllowed()) return sendError(res, 403, 'Add-ons for Marketplace-billed accounts are managed in AWS Marketplace');
    const bundleId = getParam(req.params, 'bundleId');
    if (!bundleId) return sendError(res, 400, 'bundleId is required');

    const loaded = await loadSubAndPlan(orgId);
    if (!loaded) return sendError(res, 404, 'No active subscription');
    const { subscription, plan } = loaded;
    if (!subscriptionIdMatches(req, subscription)) return sendError(res, 404, 'Subscription not found', ErrorCode.NOT_FOUND);

    const current = (subscription.addons ?? []) as Addon[];
    const next = applyAddon(current, bundleId, 0);

    const overages = await checkEntitlementOvercap(orgId, plan.tier, next, '');
    if (overages.length > 0) {
      return sendError(res, 409, 'Removing this bundle would put the account over its limit — remove members/resources first', 'ADDON_OVER_CAP', { overages });
    }

    subscription.addons = next;
    await subscription.save();

    const serviceAuth = billingServiceAuth(orgId);
    await syncEntitlements(orgId, plan.tier, serviceAuth, subscription._id.toString(), next);
    await syncProviderAddons(subscription.externalId, next, subscription.interval, orgId, subscription._id.toString(), 'addon_remove');
    await createBillingEvent(orgId, 'subscription_updated', { reason: 'addon_removed', bundleId }, subscription._id.toString(), req.user?.sub);

    // Mirror the add-on removal to the CENTRAL audit trail (alongside the local
    // billing_events row). Fire-and-forget; details are an explicit id whitelist —
    // no card/payment secret or AWS account id can leak.
    getAuditClient().record({
      action: 'billing.addon.remove',
      actorId: req.user?.sub ?? 'system',
      orgId,
      targetId: bundleId,
      details: { bundleId, subscriptionId: subscription._id.toString() },
    }, 'billing');

    logger.info('Add-on removed', { orgId, bundleId });

    const bundles = getBundleCatalog();
    // Record combo_expired for any combo this removal ended.
    const delta = comboDelta(current, next, bundles, subscription.interval);
    for (const c of delta.lostCombos) {
      await createBillingEvent(orgId, 'combo_expired', { comboId: c.comboId }, subscription._id.toString(), req.user?.sub);
      getAuditClient().record({
        action: 'billing.combo.expired',
        actorId: req.user?.sub ?? 'system',
        orgId,
        targetId: c.comboId,
        details: { comboId: c.comboId, creditCents: c.creditCents, subscriptionId: subscription._id.toString() },
      }, 'billing');
    }

    const { limits } = effectiveEntitlements(plan.tier, next, bundles);
    return sendSuccess(res, 200, {
      subscription: buildSubscriptionResponse(subscription, plan.name, plan.tier),
      addons: next,
      effectiveLimits: limits,
      priceBreakdown: priceBreakdown(plan, next, bundles, subscription.interval),
      ...delta,
    });
  }));

  return router;
}
