// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  requireAuth,
  requireAdmin,
  sendSuccess,
  sendError,
  createLogger,
  getParam,
  getServiceAuthHeader,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import {
  bundleSelfServiceAllowed,
  bundlesEnabled,
  buildSubscriptionResponse,
  checkEntitlementOvercap,
  createBillingEvent,
  effectiveEntitlements,
  getBundleCatalog,
  syncEntitlements,
} from '../helpers/billing-helpers.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

/** Best-effort: reconcile the external provider's add-on line items. Local
 *  entitlements are already applied, so a provider error must not fail the
 *  request (it's logged and reconciled on the next change/webhook). */
async function syncProviderAddons(
  externalId: string | null | undefined,
  addons: Addon[],
  interval: 'monthly' | 'annual',
  orgId: string,
): Promise<void> {
  if (!externalId) return;
  try {
    await getPaymentProvider().syncAddons?.(externalId, addons, interval);
  } catch (err) {
    logger.warn('Provider add-on sync failed (local entitlements already applied)', { orgId, error: String(err) });
  }
}

const logger = createLogger('billing-addons');
const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

type Addon = { bundleId: string; quantity: number };

/** Set a bundle's quantity in the add-on list (quantity 0 removes it). */
function applyAddon(addons: Addon[], bundleId: string, quantity: number): Addon[] {
  const rest = addons.filter((a) => a.bundleId !== bundleId);
  if (quantity > 0) rest.push({ bundleId, quantity });
  return rest;
}

/** Itemized price breakdown: base plan line + one line per add-on. */
function priceBreakdown(
  plan: { name: string; prices: { monthly: number; annual: number } },
  addons: Addon[],
  bundles: readonly { id: string; name: string; prices: { monthly: number; annual: number } }[],
  interval: 'monthly' | 'annual',
): { interval: string; items: { label: string; quantity: number; cents: number }[]; totalCents: number } {
  const key = interval === 'annual' ? 'annual' : 'monthly';
  const byId = new Map(bundles.map((b) => [b.id, b]));
  const items = [{ label: plan.name, quantity: 1, cents: plan.prices[key] }];
  for (const a of addons) {
    const b = byId.get(a.bundleId);
    if (b) items.push({ label: b.name, quantity: a.quantity, cents: b.prices[key] * a.quantity });
  }
  return { interval, items, totalCents: items.reduce((s, i) => s + i.cents, 0) };
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
    const subscription = await Subscription.findOne({ orgId, status: 'active' });
    if (!subscription) return null;
    const plan = await Plan.findById(subscription.planId).lean();
    if (!plan) return null;
    return { subscription, plan };
  }

  // GET /billing/bundles — the add-on catalog filtered to the account's tier
  router.get('/bundles', requireAuth(AUTH_OPTS) as RequestHandler, withRoute(async ({ res, orgId }) => {
    if (!bundlesEnabled()) return sendSuccess(res, 200, { bundles: [], selfService: false });
    const loaded = await loadSubAndPlan(orgId);
    const tier = loaded?.plan.tier;
    const bundles = getBundleCatalog().filter((b) => b.isActive && (!tier || b.availableForTiers.includes(tier)));
    // selfService=false for Marketplace-billed accounts: the catalog is still
    // returned (so the UI can explain add-ons are managed in AWS) but the
    // add/remove mutations are 403-gated. See bundleSelfServiceAllowed().
    return sendSuccess(res, 200, { bundles, selfService: bundleSelfServiceAllowed() });
  }));

  // POST /billing/portal — hosted session to add/update a payment method. Powers
  // the "Add a payment method" CTA shown after a 402 PAYMENT_METHOD_REQUIRED.
  router.post('/portal', requireAuth(AUTH_OPTS) as RequestHandler, requireAdmin as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    const subscription = await Subscription.findOne({ orgId, status: 'active' });
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
  router.post('/subscriptions/:id/addons/preview', requireAuth(AUTH_OPTS) as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!bundlesEnabled()) return sendError(res, 404, 'Add-on bundles are not enabled');
    if (!bundleSelfServiceAllowed()) return sendError(res, 403, 'Add-ons for Marketplace-billed accounts are managed in AWS Marketplace');
    const { bundleId, quantity } = (req.body ?? {}) as { bundleId?: string; quantity?: number };
    if (typeof bundleId !== 'string') return sendError(res, 400, 'bundleId is required');

    const loaded = await loadSubAndPlan(orgId);
    if (!loaded) return sendError(res, 404, 'No active subscription');
    const { subscription, plan } = loaded;

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
    });
  }));

  // POST /billing/subscriptions/:id/addons — add or set a bundle quantity
  router.post('/subscriptions/:id/addons', requireAuth(AUTH_OPTS) as RequestHandler, requireAdmin as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!bundlesEnabled()) return sendError(res, 404, 'Add-on bundles are not enabled');
    if (!bundleSelfServiceAllowed()) return sendError(res, 403, 'Add-ons for Marketplace-billed accounts are managed in AWS Marketplace');
    const { bundleId, quantity } = (req.body ?? {}) as { bundleId?: string; quantity?: number };
    if (typeof bundleId !== 'string') return sendError(res, 400, 'bundleId is required');

    const loaded = await loadSubAndPlan(orgId);
    if (!loaded) return sendError(res, 404, 'No active subscription');
    const { subscription, plan } = loaded;

    const bundles = getBundleCatalog();
    const bundle = bundles.find((b) => b.id === bundleId && b.isActive);
    if (!bundle) return sendError(res, 400, `Unknown bundle "${bundleId}"`);
    if (!bundle.availableForTiers.includes(plan.tier)) {
      return sendError(res, 400, `Bundle "${bundleId}" is not available on the ${plan.tier} plan`);
    }

    // Stackable packs take a quantity (>=1); boolean feature bundles are qty 1.
    const qty = bundle.stackable ? Math.max(1, Math.trunc(quantity ?? 1)) : 1;
    const next = applyAddon((subscription.addons ?? []) as Addon[], bundleId, qty);

    // Payment-method gate: a paid INCREASE needs a card on file so the charge can
    // settle. Matters most on the free (developer) tier, which may have no card
    // yet. Providers that don't manage cards (stub) expose no check → allowed.
    const currentQty = ((subscription.addons ?? []) as Addon[]).find((a) => a.bundleId === bundleId)?.quantity ?? 0;
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
    const serviceAuth = getServiceAuthHeader({ serviceName: 'billing', orgId, role: 'owner' });
    await syncEntitlements(orgId, plan.tier, serviceAuth, subscription._id.toString(), next);
    await syncProviderAddons(subscription.externalId, next, subscription.interval, orgId);
    await createBillingEvent(orgId, 'subscription_updated', { reason: 'addon_added', bundleId, quantity: qty }, subscription._id.toString());
    logger.info('Add-on applied', { orgId, bundleId, quantity: qty });

    const { limits } = effectiveEntitlements(plan.tier, next, bundles);
    return sendSuccess(res, 200, {
      subscription: buildSubscriptionResponse(subscription, plan.name, plan.tier),
      addons: next,
      effectiveLimits: limits,
      priceBreakdown: priceBreakdown(plan, next, bundles, subscription.interval),
    });
  }));

  // DELETE /billing/subscriptions/:id/addons/:bundleId — remove a bundle.
  // The over-cap gate below blocks a removal that would drop a pooled cap under
  // current usage (docs/billing-bundles.md §8); otherwise it removes + re-syncs.
  router.delete('/subscriptions/:id/addons/:bundleId', requireAuth(AUTH_OPTS) as RequestHandler, requireAdmin as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!bundlesEnabled()) return sendError(res, 404, 'Add-on bundles are not enabled');
    if (!bundleSelfServiceAllowed()) return sendError(res, 403, 'Add-ons for Marketplace-billed accounts are managed in AWS Marketplace');
    const bundleId = getParam(req.params, 'bundleId');
    if (!bundleId) return sendError(res, 400, 'bundleId is required');

    const loaded = await loadSubAndPlan(orgId);
    if (!loaded) return sendError(res, 404, 'No active subscription');
    const { subscription, plan } = loaded;

    const next = applyAddon((subscription.addons ?? []) as Addon[], bundleId, 0);

    const overages = await checkEntitlementOvercap(orgId, plan.tier, next, '');
    if (overages.length > 0) {
      return sendError(res, 409, 'Removing this bundle would put the account over its limit — remove members/resources first', 'ADDON_OVER_CAP', { overages });
    }

    subscription.addons = next;
    await subscription.save();

    const serviceAuth = getServiceAuthHeader({ serviceName: 'billing', orgId, role: 'owner' });
    await syncEntitlements(orgId, plan.tier, serviceAuth, subscription._id.toString(), next);
    await syncProviderAddons(subscription.externalId, next, subscription.interval, orgId);
    await createBillingEvent(orgId, 'subscription_updated', { reason: 'addon_removed', bundleId }, subscription._id.toString());
    logger.info('Add-on removed', { orgId, bundleId });

    const bundles = getBundleCatalog();
    const { limits } = effectiveEntitlements(plan.tier, next, bundles);
    return sendSuccess(res, 200, {
      subscription: buildSubscriptionResponse(subscription, plan.name, plan.tier),
      addons: next,
      effectiveLimits: limits,
      priceBreakdown: priceBreakdown(plan, next, bundles, subscription.interval),
    });
  }));

  return router;
}
