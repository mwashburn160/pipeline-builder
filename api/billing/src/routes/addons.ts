// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_ACTOR_ID,
  audited,
  requireAuth,
  requireOrgAdminAssurance,
  requirePermission,
  sendSuccess,
  sendError,
  sendBadRequest,
  ErrorCode,
  createLogger,
  getParam,
  validateBody,
  actorId,
  recordAudit,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { effectiveEntitlements } from '../config/entitlements.js';
import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import { config } from '../config.js';
import {
  applyAddon,
  bundleQuantityCapError,
  bundleRequiresError,
  bundleUnmetRequirement,
  cascadeRemoveDependents,
  comboDelta,
  comboSavings,
  priceBreakdown,
  resolvePurchasableBundle,
  type Addon,
  type ComboChange,
} from '../helpers/addon-catalog.js';
import { syncProviderAddons } from '../helpers/addon-prune.js';
import { bundleSelfServiceAllowed, bundlesEnabled, billingServiceAuth, createBillingEvent, getBundleCatalog } from '../helpers/billing-helpers.js';
import { getComboDiscounts } from '../helpers/combo-pricing.js';
import { checkEntitlementOvercap, syncEntitlements } from '../helpers/entitlement-sync.js';
import { refuseTeamBilling } from '../helpers/root-org-guard.js';
import { buildSubscriptionResponse } from '../helpers/subscription-response.js';
import { MANAGEABLE_SUBSCRIPTION_STATUSES, isGraceDowngraded } from '../helpers/subscription-status.js';
import { Plan } from '../models/plan.js';
import { Subscription, type SubscriptionDocument } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';
import { AddonMutateSchema } from '../validation/schemas.js';

const logger = createLogger('billing-addons');
const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

/**
 * The org policy "administrative actions require MFA" (the `org_admin_aal`
 * claim). Changing what the org pays for is an administrative action; billing
 * automation (API keys, service accounts) is legitimate, so machines pass and a
 * person needs an `aal: 2` session while the policy is on.
 */
const ADMIN_MFA = requireOrgAdminAssurance({ machines: 'allow' }) as RequestHandler;

/** Billing is owned by the account ROOT — a team org can't mutate it (see refuseTeamBilling). */
const ROOT_ONLY = refuseTeamBilling as RequestHandler;

/** Emit a `combo_expired` billing event + audit record for each combo a bundle
 *  change dropped. Shared by the add and remove handlers (was copy-pasted). */
async function recordLostCombos(orgId: string, lost: ComboChange[], subscriptionId: string, eventActorId?: string): Promise<void> {
  for (const c of lost) {
    await createBillingEvent(orgId, 'combo_expired', { comboId: c.comboId }, subscriptionId, eventActorId);
    recordAudit({
      action: 'billing.combo.expired',
      actorId: eventActorId ?? SYSTEM_ACTOR_ID,
      orgId,
      targetId: c.comboId,
      details: { comboId: c.comboId, creditCents: c.creditCents, subscriptionId },
    });
  }
}

/**
 * Commit an add-on change and run its side effects — shared by the add and remove
 * handlers so the two can't drift:
 *
 * 1. Guarded write (optimistic concurrency): commit `addons` ONLY if the doc hasn't
 *    changed since it was read (`__v` match), so two concurrent seat/add-on changes
 *    can't clobber each other or both slip past the over-cap gate. The durable
 *    `metadata.providerAddonSyncPending` marker rides the SAME write whenever the
 *    sub has an `externalId`, so a crash before `syncProviderAddons` still leaves it
 *    for `reconcileFailedProviderAddonSyncs` to re-drive (cleared on success).
 * 2. Push EFFECTIVE entitlements (tier + all add-ons) to quota + platform with a
 *    root-scoped service token, then rebuild the provider line items.
 * 3. Record the local billing event + mirror it to the CENTRAL audit trail
 *    (fire-and-forget; details are an explicit id/quantity whitelist — no
 *    card/payment secret or AWS account id can leak).
 *
 * Returns the committed document, or `null` on a version miss (caller → 409; the
 * client re-previews and retries).
 */
async function commitAddonChange(args: {
  /** The loaded (hydrated) doc — its `__v` is the optimistic-concurrency guard. */
  subscription: SubscriptionDocument & { __v?: number };
  tier: Parameters<typeof syncEntitlements>[1];
  orgId: string;
  next: Addon[];
  actorId: string | undefined;
  source: 'addon_add' | 'addon_remove';
  bundleId: string;
  eventDetails: Record<string, unknown>;
  auditDetails: Record<string, unknown>;
}): Promise<SubscriptionDocument | null> {
  const { subscription, tier, orgId, next, actorId: eventActorId, source, bundleId } = args;
  const committed = await Subscription.findOneAndUpdate(
    { _id: subscription._id, __v: subscription.__v },
    {
      $set: { addons: next, ...(subscription.externalId ? { 'metadata.providerAddonSyncPending': true } : {}) },
      $inc: { __v: 1 },
    },
    { new: true },
  );
  if (!committed) return null;

  const subscriptionId = committed._id.toString();
  // Push the EFFECTIVE tier, not the plan's nominal one. A `past_due` sub whose
  // grace already lapsed has been synced down to `developer` with no add-ons,
  // but it stays manageable (so the customer can still fix their billing), and
  // its plan still names the paid tier. Syncing `plan.tier` here therefore
  // RESTORED the paid tier on any add-on add or remove — free, and permanently,
  // because the drift reconciler deliberately skips `past_due` rows so nothing
  // ever put it back. The add-ons themselves stay persisted on the subscription
  // (the customer owns them); they simply carry no entitlement until they pay.
  const lapsed = isGraceDowngraded(committed);
  await syncEntitlements(
    orgId,
    lapsed ? 'developer' : tier,
    billingServiceAuth(orgId),
    subscriptionId,
    lapsed ? [] : next,
  );
  await syncProviderAddons(committed.externalId, next, committed.interval, orgId, subscriptionId, source);
  await createBillingEvent(orgId, 'subscription_updated', args.eventDetails, subscriptionId, eventActorId);
  recordAudit({
    action: source === 'addon_add' ? 'billing.addon.add' : 'billing.addon.remove',
    actorId: eventActorId ?? SYSTEM_ACTOR_ID,
    orgId,
    targetId: bundleId,
    details: { ...args.auditDetails, subscriptionId },
  });
  return committed;
}

/**
 * Add-on bundle management routes (root-org billing; behind
 * `BILLING_BUNDLES_ENABLED`). See docs/billing-bundles.md.
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
    const catalog = getBundleCatalog();
    const offeredBundles = catalog.filter((b) => b.isActive && (!tier || b.availableForTiers.includes(tier)));
    // Prerequisites the account doesn't meet yet (e.g. DORA History Pack without
    // Advanced Reporting), evaluated as if the bundle were added now — the SAME
    // gate the add route 400s on — so the UI can disable the control and say why
    // before the click. Only computable with a plan in scope (tier + held add-ons).
    const current = (loaded?.subscription.addons ?? []) as Addon[];
    const bundles = offeredBundles.map((b) => {
      const unmet = tier
        ? bundleUnmetRequirement(b, applyAddon(current, b.id, Math.max(1, current.find((a) => a.bundleId === b.id)?.quantity ?? 0)), catalog, tier)
        : null;
      return unmet ? { ...b, unmetRequirement: unmet } : b;
    });
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
  router.post('/portal', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, ADMIN_MFA, ROOT_ONLY, withRoute(async ({ req, res, orgId }) => {
    // A past_due account is exactly who needs the hosted portal (to add/fix a
    // payment method and stop dunning), so include the full non-terminal set.
    const subscription = await Subscription.findOne({ orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] } });
    if (!subscription?.externalCustomerId) return sendError(res, 404, 'No billing customer for this account', ErrorCode.NOT_FOUND);

    const provider = getPaymentProvider();
    if (!provider.createBillingPortalSession) {
      return sendError(res, 501, 'The configured billing provider has no hosted payment portal', ErrorCode.NOT_IMPLEMENTED);
    }

    // Land the user back on the billing page. Prefer the request Origin (works
    // across every deploy host); fall back to the configured frontend URL.
    const origin = (req.headers.origin as string | undefined) || config.frontendUrl;
    if (!origin) return sendError(res, 500, 'Cannot determine a return URL for the billing portal', ErrorCode.INTERNAL_ERROR);
    const returnUrl = `${origin.replace(/\/$/, '')}/dashboard/billing`;

    const url = await provider.createBillingPortalSession(subscription.externalCustomerId, returnUrl);
    return sendSuccess(res, 200, { url });
  }));

  // POST /billing/subscriptions/:id/addons/preview
  router.post('/subscriptions/:id/addons/preview', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:read') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!bundlesEnabled()) return sendError(res, 404, 'Add-on bundles are not enabled', ErrorCode.NOT_FOUND);
    if (!bundleSelfServiceAllowed()) return sendError(res, 403, 'Add-ons for Marketplace-billed accounts are managed in AWS Marketplace', ErrorCode.INSUFFICIENT_PERMISSIONS);
    const validation = validateBody(req, AddonMutateSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const { bundleId, quantity } = validation.value;

    const loaded = await loadSubAndPlan(orgId);
    if (!loaded) return sendError(res, 404, 'No active subscription', ErrorCode.NOT_FOUND);
    const { subscription, plan } = loaded;
    if (!subscriptionIdMatches(req, subscription)) return sendError(res, 404, 'Subscription not found', ErrorCode.NOT_FOUND);

    const bundles = getBundleCatalog();
    const resolved = resolvePurchasableBundle(bundles, bundleId, plan.tier);
    if ('error' in resolved) return sendError(res, 400, resolved.error, ErrorCode.VALIDATION_ERROR);
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
    const requiresError = bundleRequiresError(bundle, applied, bundles, plan.tier);
    if (requiresError) return sendError(res, 400, requiresError, ErrorCode.VALIDATION_ERROR);
    // Cascade parity with the real DELETE: removing a bundle that is a `requires`
    // prerequisite of another held bundle drops the dependent(s) too (Advanced
    // can't outlive Standard). Preview it so a removal of Standard SHOWS Advanced
    // would be cascaded out — the effective limits/price/combos below reflect the
    // fully-unwound set, and `cascaded` lists the ids the change would remove.
    const { addons: next, removed: cascaded } = cascadeRemoveDependents(applied, bundles, plan.tier);
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
  router.post('/subscriptions/:id/addons', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, ADMIN_MFA, ROOT_ONLY, audited('billing.addon.add', 'billing.combo.expired'), withRoute(async ({ req, res, orgId }) => {
    if (!bundlesEnabled()) return sendError(res, 404, 'Add-on bundles are not enabled', ErrorCode.NOT_FOUND);
    if (!bundleSelfServiceAllowed()) return sendError(res, 403, 'Add-ons for Marketplace-billed accounts are managed in AWS Marketplace', ErrorCode.INSUFFICIENT_PERMISSIONS);
    const validation = validateBody(req, AddonMutateSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const { bundleId, quantity } = validation.value;

    const loaded = await loadSubAndPlan(orgId);
    if (!loaded) return sendError(res, 404, 'No active subscription', ErrorCode.NOT_FOUND);
    const { subscription, plan } = loaded;
    if (!subscriptionIdMatches(req, subscription)) return sendError(res, 404, 'Subscription not found', ErrorCode.NOT_FOUND);

    const bundles = getBundleCatalog();
    const resolved = resolvePurchasableBundle(bundles, bundleId, plan.tier);
    if ('error' in resolved) return sendError(res, 400, resolved.error, ErrorCode.VALIDATION_ERROR);
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
    const requiresError = bundleRequiresError(bundle, next, bundles, plan.tier);
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

    // Over-cap gate (docs/billing-bundles.md): reducing a pack below current usage is blocked
    // (an increase never trips it). Structured details drive the UI's "remove N".
    const overages = await checkEntitlementOvercap(orgId, plan.tier, next, '');
    if (overages.length > 0) {
      return sendError(res, 409, 'This change would put the account over its limit — remove members/resources first', ErrorCode.ADDON_OVER_CAP, { overages });
    }

    const committed = await commitAddonChange({
      subscription,
      tier: plan.tier,
      orgId,
      next,
      actorId: req.user?.sub,
      source: 'addon_add',
      bundleId,
      eventDetails: { reason: 'addon_added', bundleId, quantity: qty },
      auditDetails: { bundleId, quantity: qty },
    });
    if (!committed) {
      return sendError(res, 409, 'This subscription was modified concurrently — please retry', ErrorCode.CONFLICT);
    }

    logger.info('Add-on applied', { orgId, bundleId, quantity: qty });

    // A combo can end even on an ADD when the new packing drops a lower-value combo
    // that shared a member. Record combo_expired for any combo the change lost.
    const delta = comboDelta(current, next, bundles, committed.interval);
    await recordLostCombos(orgId, delta.lostCombos, committed._id.toString(), req.user?.sub);

    const { limits } = effectiveEntitlements(plan.tier, next, bundles);
    return sendSuccess(res, 200, {
      subscription: buildSubscriptionResponse(committed, plan.name, plan.tier),
      addons: next,
      effectiveLimits: limits,
      priceBreakdown: priceBreakdown(plan, next, bundles, committed.interval),
      ...delta,
    });
  }));

  // DELETE /billing/subscriptions/:id/addons/:bundleId — remove a bundle.
  // The over-cap gate below blocks a removal that would drop a pooled cap under
  // current usage (docs/billing-bundles.md); otherwise it removes + re-syncs.
  router.delete('/subscriptions/:id/addons/:bundleId', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, ADMIN_MFA, ROOT_ONLY, audited('billing.addon.remove', 'billing.combo.expired'), withRoute(async ({ req, res, orgId, userId }) => {
    if (!bundlesEnabled()) return sendError(res, 404, 'Add-on bundles are not enabled', ErrorCode.NOT_FOUND);
    if (!bundleSelfServiceAllowed()) return sendError(res, 403, 'Add-ons for Marketplace-billed accounts are managed in AWS Marketplace', ErrorCode.INSUFFICIENT_PERMISSIONS);
    const bundleId = getParam(req.params, 'bundleId');
    if (!bundleId) return sendError(res, 400, 'bundleId is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const loaded = await loadSubAndPlan(orgId);
    if (!loaded) return sendError(res, 404, 'No active subscription', ErrorCode.NOT_FOUND);
    const { subscription, plan } = loaded;
    if (!subscriptionIdMatches(req, subscription)) return sendError(res, 404, 'Subscription not found', ErrorCode.NOT_FOUND);

    const bundles = getBundleCatalog();
    const current = (subscription.addons ?? []) as Addon[];
    // Removing a bundle that is a prerequisite of another held bundle cascades:
    // the dependent(s) can't outlive their prerequisite, so drop them in the same
    // change (e.g. cancel Standard Compliance while Advanced is held → Advanced
    // goes too; remove Advanced Reporting below Enterprise → the DORA History Pack
    // goes too). Generic on `requires` / `requiresFeatures`; iterated to a fixpoint.
    const { addons: next, removed: cascaded } = cascadeRemoveDependents(
      applyAddon(current, bundleId, 0),
      bundles,
      plan.tier,
    );

    const overages = await checkEntitlementOvercap(orgId, plan.tier, next, '');
    if (overages.length > 0) {
      return sendError(res, 409, 'Removing this bundle would put the account over its limit — remove members/resources first', ErrorCode.ADDON_OVER_CAP, { overages });
    }

    const committed = await commitAddonChange({
      subscription,
      tier: plan.tier,
      orgId,
      next,
      actorId: req.user?.sub,
      source: 'addon_remove',
      bundleId,
      eventDetails: { reason: 'addon_removed', bundleId },
      auditDetails: { bundleId },
    });
    if (!committed) {
      return sendError(res, 409, 'This subscription was modified concurrently — please retry', ErrorCode.CONFLICT);
    }

    // Cascade-removed dependents (their `requires` prerequisite just went away):
    // record each as its own removal in the local billing_events + central audit
    // trail, tagged `cascadedFrom` the bundle the user explicitly removed.
    for (const dep of cascaded) {
      await createBillingEvent(orgId, 'subscription_updated', { reason: 'addon_removed', bundleId: dep, cascadedFrom: bundleId }, committed._id.toString(), req.user?.sub);
      recordAudit({
        action: 'billing.addon.remove',
        actorId: actorId({ userId }),
        orgId,
        targetId: dep,
        details: { bundleId: dep, cascadedFrom: bundleId, subscriptionId: committed._id.toString() },
      });
    }

    logger.info('Add-on removed', { orgId, bundleId, cascaded });

    // Record combo_expired for any combo this removal ended.
    const delta = comboDelta(current, next, bundles, committed.interval);
    await recordLostCombos(orgId, delta.lostCombos, committed._id.toString(), req.user?.sub);

    const { limits } = effectiveEntitlements(plan.tier, next, bundles);
    return sendSuccess(res, 200, {
      subscription: buildSubscriptionResponse(committed, plan.name, plan.tier),
      addons: next,
      effectiveLimits: limits,
      priceBreakdown: priceBreakdown(plan, next, bundles, subscription.interval),
      ...delta,
    });
  }));

  return router;
}
