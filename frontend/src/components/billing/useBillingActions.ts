// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';
import { useToast } from '@/components/ui/Toast';
import { formatError } from '@/lib/constants';
import { newSubscriptionAction } from '@/components/billing/subscribe-action';
import { useAddonChange } from '@/components/billing/useAddonChange';
import { useCheckoutReturn } from '@/components/billing/useCheckoutReturn';
import type { BillingProvider } from '@/hooks/useBillingEnabled';
import type { Plan, Bundle, BillingInterval, Subscription } from '@/types';

/** sessionStorage key carrying the "I came for this add-on" intent across the
 *  plan-selection detour (including the hosted-Checkout redirect). */
const ADDON_INTENT_KEY = 'pb.billing.addonIntent';

interface UseBillingActionsOptions {
  subscription: Subscription | null;
  plans: Plan[];
  bundles: Bundle[];
  billingInterval: BillingInterval;
  /** The deployment's provider, `undefined` until the config probe resolves. */
  billingProvider: BillingProvider | undefined;
  /** Re-read whatever a mutation can have changed (bundle + usage catalogs). */
  onReload: () => void;
  /** Moves the page to another tab (the add-on intent detours via Plans). */
  changeTab: (id: string) => void;
}

/**
 * Every write the billing page performs: subscribing and switching plan,
 * add-on purchases, the hosted payment portal, cancel and reactivate — plus the
 * "I came for this add-on" intent that survives the plan-selection detour and
 * the hosted-Checkout redirect.
 *
 * They all share one `actionLoading` flag and one post-mutation reload, which
 * is why they move together: splitting them would have meant handing the page's
 * setter and reloader back out again.
 */
export function useBillingActions({
  subscription, plans, bundles, billingInterval, billingProvider, onReload, changeTab,
}: UseBillingActionsOptions) {
  const router = useRouter();
  const toast = useToast();
  const [actionLoading, setActionLoading] = useState(false);

  // "Subscribe to add" on an add-on preview card: remember which pack the buyer
  // came for, send them to plan selection, then bring them back to that card once
  // a plan exists. Parked in sessionStorage so the round-trip survives the hosted
  // Checkout redirect (which leaves the app entirely).
  const [addonIntentId, setAddonIntentId] = useState<string | null>(null);
  useEffect(() => {
    try {
      setAddonIntentId(sessionStorage.getItem(ADDON_INTENT_KEY));
    } catch { /* storage blocked (private window) — the round-trip just won't persist */ }
  }, []);
  const addonIntent = addonIntentId ? bundles.find((b) => b.id === addonIntentId) ?? null : null;

  const startAddonIntent = (bundle: Bundle) => {
    setAddonIntentId(bundle.id);
    try { sessionStorage.setItem(ADDON_INTENT_KEY, bundle.id); } catch { /* not fatal */ }
    changeTab('plans');
  };

  const clearAddonIntent = () => {
    setAddonIntentId(null);
    try { sessionStorage.removeItem(ADDON_INTENT_KEY); } catch { /* not fatal */ }
  };

  /** Land back on the pack the buyer originally wanted, highlighted. */
  const finishAddonIntent = () => {
    let id: string | null = addonIntentId;
    try { id = id ?? sessionStorage.getItem(ADDON_INTENT_KEY); } catch { /* not fatal */ }
    if (!id) return;
    clearAddonIntent();
    // useUrlTab follows the URL to the Add-ons tab.
    void router.replace({ query: { ...router.query, tab: 'addons', highlight: id } }, undefined, { shallow: true });
  };

  /** After any billing mutation: re-read everything it can have changed. The
   *  page refreshes in place (open dialogs, tab and scroll survive). */
  const reloadAll = () => {
    invalidate.subscription();
    onReload();
  };

  // Returning from hosted Checkout: poll until the webhook provisions the
  // subscription, then reload and resume any add-on the buyer came for.
  useCheckoutReturn(() => {
    reloadAll();
    finishAddonIntent();
  });

  // A proposed plan switch, held while the user confirms. Unlike add-ons there's
  // no proration-preview endpoint, so this is a plain confirm (with a downgrade
  // warning). A brand-new subscription skips the modal — nothing to change yet.
  const [pendingPlan, setPendingPlan] = useState<Plan | null>(null);

  const doSubscribe = async (planId: string) => {
    setActionLoading(true);
    try {
      if (subscription) {
        const res = await api.changeSubscription(subscription.id, { planId, interval: billingInterval });
        if (res.success) {
          toast.success('Plan changed successfully');
          setPendingPlan(null);
          reloadAll();
          finishAddonIntent();
        }
      } else {
        // Brand-new subscription — branch by provider (pure decision, unit-tested).
        const plan = plans.find((p) => p.id === planId);
        const isFree = !!plan && plan.prices.monthly === 0 && plan.prices.annual === 0;
        const action = newSubscriptionAction(billingProvider, isFree);
        if (action === 'blocked-loading') {
          toast.info('Billing is still loading — try again in a moment.');
          return;
        }
        if (action === 'blocked-marketplace') {
          toast.info('This account is billed through AWS Marketplace — manage plans from your AWS Marketplace subscription.');
          return;
        }
        // Stripe requires a card → hosted Checkout (collects payment + creates the
        // sub; the webhook provisions the local row). A free plan or `stub` needs no
        // card → create directly.
        if (action === 'checkout') {
          const res = await api.createCheckoutSession(planId, billingInterval);
          if (res.success && res.data?.url) {
            window.location.href = res.data.url; // leave for hosted Checkout
            return; // keep the loading state while navigating away
          }
          throw new Error('Could not start checkout');
        }
        const res = await api.createSubscription(planId, billingInterval);
        if (res.success) {
          toast.success('Subscription created successfully');
          reloadAll();
          finishAddonIntent();
        }
      }
    } catch (err) {
      toast.error(formatError(err, 'Failed to update subscription'));
    } finally {
      setActionLoading(false);
    }
  };

  /** Entry point from the plan grid. Existing subscription → confirm first;
   *  first-time signup → subscribe straight away. */
  const requestPlanChange = (planId: string) => {
    const plan = plans.find((p) => p.id === planId);
    if (subscription && plan) {
      setPendingPlan(plan);
    } else {
      void doSubscribe(planId);
    }
  };

  /** Current purchased quantity of a bundle (0 if none). */
  const addonQty = (bundleId: string): number =>
    subscription?.addons?.find((a) => a.bundleId === bundleId)?.quantity ?? 0;

  // Add-on change: preview the price, then confirm (see useAddonChange).
  const addon = useAddonChange(subscription, reloadAll);
  const [portalLoading, setPortalLoading] = useState(false);

  /** Redirect to the provider's hosted portal to add/update a payment method,
   *  returning to this page afterward. */
  const openBillingPortal = async () => {
    setPortalLoading(true);
    try {
      const res = await api.createBillingPortalSession();
      if (res.success && res.data?.url) {
        window.location.href = res.data.url;
        return; // navigating away
      }
      toast.error('Could not open the payment portal');
    } catch (err) {
      toast.error(formatError(err, 'Could not open the payment portal'));
    } finally {
      setPortalLoading(false);
    }
  };

  // Cancelling is confirmed first — it's a step-up-gated, account-wide change.
  const [confirmCancel, setConfirmCancel] = useState(false);
  const handleCancel = async () => {
    if (!subscription) return;
    setActionLoading(true);
    try {
      const res = await api.cancelSubscription(subscription.id);
      if (res.success) {
        toast.success('Subscription will be canceled at end of billing period');
        setConfirmCancel(false);
        reloadAll();
      }
    } catch (err) {
      toast.error(formatError(err, 'Failed to cancel'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleReactivate = async () => {
    if (!subscription) return;
    setActionLoading(true);
    try {
      const res = await api.reactivateSubscription(subscription.id);
      if (res.success) {
        toast.success('Subscription reactivated');
        reloadAll();
      }
    } catch (err) {
      toast.error(formatError(err, 'Failed to reactivate'));
    } finally {
      setActionLoading(false);
    }
  };

  return {
    actionLoading,
    /** Any billing mutation in flight disables the other purchase controls. */
    busy: actionLoading || addon.committing,
    addon,
    addonIntent,
    startAddonIntent,
    clearAddonIntent,
    pendingPlan,
    setPendingPlan,
    requestPlanChange,
    doSubscribe,
    addonQty,
    portalLoading,
    openBillingPortal,
    confirmCancel,
    setConfirmCancel,
    handleCancel,
    handleReactivate,
    reloadAll,
  };
}
