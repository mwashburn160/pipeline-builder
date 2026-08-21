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
import type { QuotaTier } from '@pipeline-builder/api-core';
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
import type { SubscriptionDocument } from '../models/subscription.js';
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

/**
 * Resolve an active bundle that is purchasable on `tier`, or an error message.
 * Shared by the preview + add handlers so the "unknown bundle" / "not available
 * on this plan" gate (and its 400 copy) can't drift between them.
 */
function resolvePurchasableBundle(
  bundles: readonly BundleConfig[],
  bundleId: string,
  tier: QuotaTier,
): { bundle: BundleConfig } | { error: string } {
  const bundle = bundles.find((b) => b.id === bundleId && b.isActive);
  if (!bundle) return { error: `Unknown bundle "${bundleId}"` };
  if (!bundle.availableForTiers.includes(tier)) {
    return { error: `Bundle "${bundleId}" is not available on the ${tier} plan` };
  }
  return { bundle };
}

/** The over-`maxQuantity` (retention-ceiling) 400 message for a stacked bundle,
 *  or null when within cap. Shared so the preview + add gate stay identical. */
function bundleQuantityCapError(bundle: BundleConfig, qty: number): string | null {
  return bundle.maxQuantity !== undefined && qty > bundle.maxQuantity
    ? `Bundle "${bundle.id}" is capped at ${bundle.maxQuantity} (retention ceiling)`
    : null;
}

/** The set of bundle ids HELD (quantity > 0) in an add-on list. */
function heldBundleIds(addons: readonly Addon[]): Set<string> {
  return new Set(addons.filter((a) => a.quantity > 0).map((a) => a.bundleId));
}

/**
 * Generic `requires` gate (bundle.requires): the 400 message when `bundle`'s
 * prerequisite bundle ids are NOT all satisfied by the add-on set `next` (the set
 * AFTER the change), or null when satisfied / no prerequisites. A prerequisite
 * counts as satisfied when it is present in `next` — whether already held or added
 * in the same action (a combo/simultaneous add). Only enforced when `bundle`
 * itself is held after the change (qty > 0). Not compliance-specific: drives any
 * bundle with a `requires` list (e.g. `compliance_advanced`→`compliance_standard`).
 */
function bundleRequiresError(bundle: BundleConfig, next: readonly Addon[], bundles: readonly BundleConfig[]): string | null {
  const requires = bundle.requires ?? [];
  if (requires.length === 0) return null;
  const held = heldBundleIds(next);
  if (!held.has(bundle.id)) return null; // bundle isn't being added/kept — nothing to gate
  const missing = requires.filter((r) => !held.has(r));
  if (missing.length === 0) return null;
  const byId = new Map(bundles.map((b) => [b.id, b]));
  const names = missing.map((r) => byId.get(r)?.name ?? r);
  return `${bundle.name} requires the ${names.join(', ')} add-on`;
}

/**
 * Cascade-remove: after a bundle is removed, any OTHER held bundle whose
 * `requires[]` is no longer satisfied by the remaining set must go too (a
 * dependent can't outlive its prerequisite). Iterated to a fixpoint so a chain
 * (A requires B requires C; remove C ⇒ drop B then A) fully unwinds. Returns the
 * reduced add-on list plus the ids that were cascaded (for audit). Generic on
 * `bundle.requires` — not compliance-specific.
 */
function cascadeRemoveDependents(
  next: readonly Addon[],
  bundles: readonly BundleConfig[],
): { addons: Addon[]; removed: string[] } {
  const byId = new Map(bundles.map((b) => [b.id, b]));
  let addons: Addon[] = [...next];
  const removed: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    const held = heldBundleIds(addons);
    for (const a of addons) {
      if (a.quantity <= 0) continue;
      const requires = byId.get(a.bundleId)?.requires ?? [];
      if (requires.length > 0 && requires.some((r) => !held.has(r))) {
        addons = applyAddon(addons, a.bundleId, 0);
        removed.push(a.bundleId);
        changed = true;
        break;
      }
    }
  }
  return { addons, removed };
}

/**
 * Stamp the durable `metadata.providerAddonSyncPending` marker IN MEMORY so it
 * persists in the SAME `save()` that writes the new add-on set (crash-durability).
 *
 * Without this the marker was only set INSIDE `syncProviderAddons` on its failure
 * path — so a crash in the window between the add-on save and that call left the
 * account entitled-but-mis-billed (a purchased bundle unbilled, or a removed
 * bundle still billed) with NO marker for the lifecycle reconciler to recover.
 * Stamping it transactionally with the save closes that window: a subsequent
 * successful `syncProviderAddons` clears it, and a crash before that leaves the
 * marker for `reconcileFailedProviderAddonSyncs` to re-drive.
 *
 * Only meaningful when there's a provider subscription line item to reconcile
 * (`externalId`) — `syncProviderAddons` no-ops (and never clears) without one, so
 * stamping there would strand the marker forever.
 */
function stampProviderSyncPending(subscription: SubscriptionDocument): void {
  if (!subscription.externalId) return;
  subscription.metadata = { ...(subscription.metadata ?? {}), providerAddonSyncPending: true };
  // metadata is a Mixed path — mark it modified so the nested change is persisted.
  subscription.markModified('metadata');
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

/** Emit a `combo_expired` billing event + audit record for each combo a bundle
 *  change dropped. Shared by the add and remove handlers (was copy-pasted). */
async function recordLostCombos(orgId: string, lost: ComboChange[], subscriptionId: string, actorId?: string): Promise<void> {
  for (const c of lost) {
    await createBillingEvent(orgId, 'combo_expired', { comboId: c.comboId }, subscriptionId, actorId);
    getAuditClient().record({
      action: 'billing.combo.expired',
      actorId: actorId ?? 'system',
      orgId,
      targetId: c.comboId,
      details: { comboId: c.comboId, creditCents: c.creditCents, subscriptionId },
    }, 'billing');
  }
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
    const resolved = resolvePurchasableBundle(bundles, bundleId, plan.tier);
    if ('error' in resolved) return sendError(res, 400, resolved.error);
    const { bundle } = resolved;

    const qty = bundle.stackable ? Math.max(0, Math.trunc(quantity ?? 1)) : (quantity && quantity > 0 ? 1 : 0);
    // D7: a retention bundle can't be stacked past its 730-day ceiling
    // (`maxQuantity` on the config; e.g. retention_pack=7, dora_history_pack=1).
    // Bundles without a `maxQuantity` are unbounded (unchanged).
    const capError = bundleQuantityCapError(bundle, qty);
    if (capError) return sendError(res, 400, capError, ErrorCode.VALIDATION_ERROR);
    const current = (subscription.addons ?? []) as Addon[];
    const applied = applyAddon(current, bundleId, qty);
    // Prerequisite gate (bundle.requires): reject an ADD whose prerequisites
    // aren't satisfied by the effective set after the change (e.g. Advanced
    // Compliance without Standard Compliance). Generic on `requires`. Checked on
    // the pre-cascade set so an unmet-prereq add still 400s in preview.
    const requiresError = bundleRequiresError(bundle, applied, bundles);
    if (requiresError) return sendError(res, 400, requiresError, ErrorCode.VALIDATION_ERROR);
    // Cascade parity with the real DELETE: removing a bundle that is a `requires`
    // prerequisite of another held bundle drops the dependent(s) too (Advanced
    // can't outlive Standard). Preview it so a removal of Standard SHOWS Advanced
    // would be cascaded out — the effective limits/price/combos below reflect the
    // fully-unwound set, and `cascaded` lists the ids the change would remove.
    const { addons: next, removed: cascaded } = cascadeRemoveDependents(applied, bundles);
    const { limits } = effectiveEntitlements(plan.tier, next, bundles);

    return sendSuccess(res, 200, {
      addons: next,
      cascaded,
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
    const resolved = resolvePurchasableBundle(bundles, bundleId, plan.tier);
    if ('error' in resolved) return sendError(res, 400, resolved.error);
    const { bundle } = resolved;

    // Stackable packs take a quantity (>=1); boolean feature bundles are qty 1.
    const qty = bundle.stackable ? Math.max(1, Math.trunc(quantity ?? 1)) : 1;
    // D7: reject a retention bundle stacked past its 730-day ceiling (`maxQuantity`).
    const capError = bundleQuantityCapError(bundle, qty);
    if (capError) return sendError(res, 400, capError, ErrorCode.VALIDATION_ERROR);
    const current = (subscription.addons ?? []) as Addon[];
    const next = applyAddon(current, bundleId, qty);

    // Prerequisite gate (bundle.requires): reject an add whose prerequisites
    // aren't satisfied by the effective set after the change (e.g. Advanced
    // Compliance without Standard Compliance). Generic on `requires`.
    const requiresError = bundleRequiresError(bundle, next, bundles);
    if (requiresError) return sendError(res, 400, requiresError, ErrorCode.VALIDATION_ERROR);

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
        return sendError(res, 402, 'Add a payment method before purchasing add-ons', ErrorCode.PAYMENT_METHOD_REQUIRED);
      }
    }

    // Over-cap gate (docs §8): reducing a pack below current usage is blocked
    // (an increase never trips it). Structured details drive the UI's "remove N".
    const overages = await checkEntitlementOvercap(orgId, plan.tier, next, '');
    if (overages.length > 0) {
      return sendError(res, 409, 'This change would put the account over its limit — remove members/resources first', ErrorCode.ADDON_OVER_CAP, { overages });
    }

    subscription.addons = next;
    // Stamp the provider-sync-pending marker in the SAME save so a crash between
    // here and syncProviderAddons still leaves a durable marker the reconciler
    // recovers (syncProviderAddons clears it on success below).
    stampProviderSyncPending(subscription);
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
    await recordLostCombos(orgId, delta.lostCombos, subscription._id.toString(), req.user?.sub);

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

    const bundles = getBundleCatalog();
    const current = (subscription.addons ?? []) as Addon[];
    // Removing a bundle that is a `requires` prerequisite of another held bundle
    // cascades: the dependent(s) can't outlive their prerequisite, so drop them in
    // the same change (e.g. cancel Standard Compliance while Advanced is held →
    // Advanced goes too). Generic on `bundle.requires`; iterated to a fixpoint.
    const { addons: next, removed: cascaded } = cascadeRemoveDependents(
      applyAddon(current, bundleId, 0),
      bundles,
    );

    const overages = await checkEntitlementOvercap(orgId, plan.tier, next, '');
    if (overages.length > 0) {
      return sendError(res, 409, 'Removing this bundle would put the account over its limit — remove members/resources first', ErrorCode.ADDON_OVER_CAP, { overages });
    }

    subscription.addons = next;
    // Same crash-durability stamp as the add path: a removal that crashes before
    // syncProviderAddons would otherwise keep billing the removed bundle with no
    // marker — the reconciler re-drives the provider removal from this marker.
    stampProviderSyncPending(subscription);
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

    // Cascade-removed dependents (their `requires` prerequisite just went away):
    // record each as its own removal in the local billing_events + central audit
    // trail, tagged `cascadedFrom` the bundle the user explicitly removed.
    for (const dep of cascaded) {
      await createBillingEvent(orgId, 'subscription_updated', { reason: 'addon_removed', bundleId: dep, cascadedFrom: bundleId }, subscription._id.toString(), req.user?.sub);
      getAuditClient().record({
        action: 'billing.addon.remove',
        actorId: req.user?.sub ?? 'system',
        orgId,
        targetId: dep,
        details: { bundleId: dep, cascadedFrom: bundleId, subscriptionId: subscription._id.toString() },
      }, 'billing');
    }

    logger.info('Add-on removed', { orgId, bundleId, cascaded });

    // Record combo_expired for any combo this removal ended.
    const delta = comboDelta(current, next, bundles, subscription.interval);
    await recordLostCombos(orgId, delta.lostCombos, subscription._id.toString(), req.user?.sub);

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
