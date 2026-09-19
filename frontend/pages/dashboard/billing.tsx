import { useEffect, useState } from 'react';
import { formatError } from '@/lib/constants';
import { useRouter } from 'next/router';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useOrgHierarchy } from '@/hooks/useOrgHierarchy';
import { useBillingEnabledState, useBillingProvider } from '@/hooks/useBillingEnabled';
import { useQuery } from '@/hooks/useQuery';
import { useFetch } from '@/hooks/useFetch';
import { TIER_KEYS } from '@/lib/tiers';
import { tierAvailabilityText } from '@/lib/addon-tiers';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { FeatureDisabledCard } from '@/components/ui/FeatureDisabledCard';
import { Button } from '@/components/ui/Button';
import { TabBar } from '@/components/ui/TabBar';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RetryError } from '@/components/ui/RetryError';
import { LoadingPage } from '@/components/ui/Loading';
import { useToast } from '@/components/ui/Toast';
import { CreditCard } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import type { Plan, Bundle, BillingInterval } from '@/types';
import api from '@/lib/api';
import { queries, invalidate } from '@/lib/api-cache';
import { formatDate } from '@/lib/format';
import { useUrlTab } from '@/hooks/useUrlTab';
import { SubscriptionStatusCard } from '@/components/billing/SubscriptionStatusCard';
import { UsageCard } from '@/components/billing/UsageCard';
import { BillingDashboard } from '@/components/billing/BillingDashboard';
import { TeamUsageCard } from '@/components/billing/TeamUsageCard';
import { PlanGrid } from '@/components/billing/PlanGrid';
import { AddonGrid } from '@/components/billing/AddonGrid';
import { newSubscriptionAction } from '@/components/billing/subscribe-action';
import { DiscountRedeem } from '@/components/billing/DiscountRedeem';
import { AddonPreviewModal } from '@/components/billing/AddonPreviewModal';
import { PlanChangeModal } from '@/components/billing/PlanChangeModal';
import { BillingHistory } from '@/components/billing/BillingHistory';
import { MarketplaceEntitlementsPanel } from '@/components/billing/MarketplaceEntitlementsPanel';
import { useAddonChange } from '@/components/billing/useAddonChange';
import { useCheckoutReturn } from '@/components/billing/useCheckoutReturn';

// Plan hierarchy (low → high). Used to detect a downgrade so the confirm dialog
// can warn that caps/features may drop.
// Selectable tiers in ascending order — sourced from the shared TIER_KEYS so the
// rank never drifts from the tier catalog. (`unlimited` is intentionally absent.)
const PLAN_RANK: readonly string[] = TIER_KEYS;

// Billing page is organized into tabs (same bar as the Reports page). Each is
// deep-linkable via `?tab=` so links/back-forward land on the right section.
const BILLING_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'plans', label: 'Plans' },
  { id: 'addons', label: 'Add-ons' },
  { id: 'history', label: 'Billing History' },
] as const;
type BillingTab = (typeof BILLING_TABS)[number]['id'];
/** sessionStorage key carrying the "I came for this add-on" intent across the
 *  plan-selection detour (including the hosted-Checkout redirect). */
const ADDON_INTENT_KEY = 'pb.billing.addonIntent';

const BILLING_TAB_IDS: readonly BillingTab[] = BILLING_TABS.map((t) => t.id);

/** True only when BOTH plans are ranked and the target ranks below the current.
 *  An unknown plan id (custom/enterprise → rank -1) is never treated as a
 *  downgrade, so the caps/features warning can't fire on a false positive. */
function isPlanDowngrade(fromPlanId: string, toPlanId: string): boolean {
  const from = PLAN_RANK.indexOf(fromPlanId);
  const to = PLAN_RANK.indexOf(toPlanId);
  return from >= 0 && to >= 0 && to < from;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Billing and subscription management page. Displays current subscription status and plan selection with monthly/annual toggle. */
export default function BillingPage() {
  const router = useRouter();
  // The page's `billing:read` gate comes from its nav entry (page-access.ts).
  const { accessDenied, user, isReady, isAdmin, isSuperAdmin, can, isReadOnly } = useAuthGuard();
  // Whether the billing SERVICE is enabled in this deployment (`/api/billing/config`
  // probe). Replaces the old `features.isEnabled('billing')` gate — `'billing'` is
  // NOT a FeatureFlag, so that check was always false and this page redirected/span
  // forever for everyone. Tri-state so the redirect below only fires on a definitive
  // `false`, not while the probe is still resolving.
  const billingEnabled = useBillingEnabledState();
  const billingProvider = useBillingProvider();
  const toast = useToast();
  // Billing lives at the ROOT org (pooled-at-root): the subscription, tier,
  // quota pool and add-ons all belong to the account boundary. A team (child
  // org) admin manages members within their team but cannot change the plan or
  // buy add-ons — those are managed from the parent org. Sysadmins are exempt.
  const { isChildOrg: activeOrgIsTeam } = useOrgHierarchy();
  // Plan/add-on changes unlock on the `billing:manage` capability (or org-admin
  // role, which holds it in its bundle) — so a custom-group member granted the
  // perm can manage billing. Still root-only: teams manage billing at the parent.
  // `!isReadOnly` closes the read-only-impersonation dead-end: the `isAdmin ||`
  // short-circuit isn't read-only-aware (only `can()` is), so without this a
  // read-only "view-as" of an admin would keep the plan/add-on/cancel/portal
  // controls enabled, each of which the backend then 403s.
  const canChangePlan = (isAdmin || can('billing:manage')) && !isReadOnly && (isSuperAdmin || !activeOrgIsTeam);

  // Reads start once the viewer and the billing-enabled probe have resolved.
  const canRead = !!user && billingEnabled === true;
  // Plan catalog + subscription come through the shared query cache (the signup
  // and onboarding pickers and OrgAdminHome read the same keys). Every mutation
  // on this page invalidates the subscription, which re-reads it here in place.
  const plansQ = useQuery(canRead ? queries.plans() : null);
  const subQ = useQuery(canRead ? queries.subscription() : null);
  const plans: Plan[] = plansQ.data?.data?.plans ?? [];
  const subscription = subQ.data?.data?.subscription ?? null;

  // Add-on catalog: page-local, and re-read after any add-on/plan change (each
  // bundle's `unmetRequirement` depends on what the account holds).
  const bundlesQ = useFetch(
    async (signal) => (canRead ? (await api.getBundles({ signal })).data ?? null : null),
    [canRead, user?.organizationId],
  );
  const bundles: Bundle[] = bundlesQ.data?.bundles ?? [];
  // false for Marketplace-billed accounts: add-ons are managed in AWS, so the
  // catalog renders read-only with a note instead of purchase controls.
  const bundleSelfService = bundlesQ.data?.selfService ?? false;
  const comboDiscounts = bundlesQ.data?.comboDiscounts ?? [];

  // Editable "Usage this period" window. Empty = derived (subscription/fallback).
  const [usagePeriod, setUsagePeriod] = useState<{ periodStart?: string; periodEnd?: string }>({});
  const usageQ = useFetch(
    async (signal) => (canRead ? (await api.getBillingUsage(usagePeriod, { signal })).data ?? null : null),
    [canRead, user?.organizationId, usagePeriod.periodStart, usagePeriod.periodEnd],
  );
  const usage = usageQ.data;
  const handleUsagePeriodChange = (periodStart?: string, periodEnd?: string) => setUsagePeriod({ periodStart, periodEnd });

  const [actionLoading, setActionLoading] = useState(false);
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');
  // The toggle starts on the subscription's own cadence once it's known.
  useEffect(() => {
    if (subscription?.interval) setBillingInterval(subscription.interval);
  }, [subscription?.interval]);

  // Active tab lives in `?tab=` (shareable, back/forward-friendly). Tab changes
  // keep the rest of the query, so a `?highlight=` deep-link survives them.
  const [activeTab, selectTab] = useUrlTab<BillingTab>('tab', BILLING_TAB_IDS, 'overview');
  const changeTab = (id: string) => selectTab(id as BillingTab);
  // A `?highlight=<feature>` upsell link with no explicit tab targets an add-on,
  // which lives on the Add-ons tab — land there.
  useEffect(() => {
    if (router.isReady && !router.query.tab && router.query.highlight) selectTab('addons');
  }, [router.isReady, router.query.tab, router.query.highlight]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deep-link: `?highlight=<feature>` (e.g. from the Reports DORA upsell CTA)
  // emphasizes + scrolls to the add-on bundle that grants that feature.
  const highlightRaw = router.query.highlight;
  const highlightFeature = Array.isArray(highlightRaw) ? highlightRaw[0] : highlightRaw ?? null;

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

  // Billing service disabled in this deployment → show a "Billing not enabled"
  // card (below) rather than a silent redirect. A silent bounce made the page
  // feel broken (and, while the probe was undefined, could spin forever); the
  // explicit card tells the user what's happening.

  // The primary billing reads (plans + subscription) failing is an error +
  // retry, so a paying customer isn't shown an empty "no subscription" page.
  const loadError = plansQ.error ?? subQ.error;
  const initialLoading = (plansQ.loading && !plansQ.data) || (subQ.loading && !subQ.data);

  /** After any billing mutation: re-read everything it can have changed. The
   *  page refreshes in place (open dialogs, tab and scroll survive). */
  const reloadAll = () => {
    invalidate.subscription();
    bundlesQ.refetch();
    usageQ.refetch();
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

  /** Current purchased quantity of a bundle (0 if none). */
  const addonQty = (bundleId: string): number =>
    subscription?.addons?.find((a) => a.bundleId === bundleId)?.quantity ?? 0;

  // Add-on change: preview the price, then confirm (see useAddonChange).
  const addon = useAddonChange(subscription, reloadAll);
  const [portalLoading, setPortalLoading] = useState(false);
  // Any billing mutation in flight disables the other purchase controls.
  const busy = actionLoading || addon.committing;

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

  // While auth or the billing-enabled probe is still resolving, show loading.
  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || billingEnabled === undefined) return <LoadingPage />;

  // Billing service disabled in this deployment → explicit card (no silent redirect).
  if (billingEnabled === false) {
    return (
      <DashboardLayout title="Billing" subtitle="Plans, invoices, and payment details">
        <div className="page-section">
          <FeatureDisabledCard title="Billing is not enabled">
            The billing service is disabled in this deployment, so there are no plans or subscriptions to manage here.
          </FeatureDisabledCard>
        </div>
      </DashboardLayout>
    );
  }

  // Primary billing fetch failed → error + retry, so a paying customer isn't shown
  // an empty "no subscription" page that looks like a downgrade to free.
  if (loadError) {
    return (
      <DashboardLayout title="Billing" subtitle="Plans, invoices, and payment details">
        <div className="page-section">
          <RetryError
            message={`Couldn't load your billing details: ${formatError(loadError, 'Failed to load billing data')}`}
            onRetry={() => { plansQ.refetch(); subQ.refetch(); }}
          />
        </div>
      </DashboardLayout>
    );
  }

  if (initialLoading) return <LoadingPage />;

  // Monthly/annual toggle — shared by the Plans and Add-ons tabs (both price per
  // interval), so it's defined once and rendered on each.
  const intervalToggle = (
    <div className="flex justify-center">
      <Card className="inline-flex items-center p-1">
        <button
          onClick={() => setBillingInterval('monthly')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            billingInterval === 'monthly'
              ? 'bg-blue-600 text-white'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
          }`}
        >
          Monthly
        </button>
        <button
          onClick={() => setBillingInterval('annual')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            billingInterval === 'annual'
              ? 'bg-blue-600 text-white'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
          }`}
        >
          Annual
          <span className="ml-1 text-xs text-green-500">Save ~17%</span>
        </button>
      </Card>
    </div>
  );

  return (    <DashboardLayout title="Billing" subtitle="Plans, invoices, and payment details">
      <div className="page-section space-y-8">
        <TabBar items={BILLING_TABS} activeId={activeTab} onSelect={changeTab} ariaLabel="Billing sections" />

        {activeTab === 'overview' && (
          <div className="space-y-8">
            {/* Payment provider — deployment-level config (BILLING_PROVIDER), NOT a
                dashboard setting. Surfaced read-only so operators can see which
                provider a deployment runs (e.g. local/docker ships `stub`, which is
                why there are no Stripe / Marketplace controls or a card prompt). */}
            {(() => {
              const info = {
                stripe: { label: 'Stripe', color: 'blue' as const, desc: 'Card payments are collected through Stripe Checkout.' },
                'aws-marketplace': { label: 'AWS Marketplace', color: 'purple' as const, desc: 'Plans and payments are managed through your AWS Marketplace subscription.' },
                stub: { label: 'Local / dev (stub)', color: 'gray' as const, desc: 'No real payment provider is configured — subscriptions activate immediately with no card. Set BILLING_PROVIDER to stripe or aws-marketplace (in the billing service env) to enable real billing.' },
              }[billingProvider ?? 'stub'];
              return (
                <Card className="flex items-center justify-between gap-3 p-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <CreditCard className="w-5 h-5 shrink-0 text-gray-400" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Payment provider</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {billingProvider === undefined ? 'Detecting…' : info.desc}
                      </p>
                    </div>
                  </div>
                  <Badge color={info.color}>{info.label}</Badge>
                </Card>
              );
            })()}

            {/* Current subscription status */}
            {subscription && (
              <SubscriptionStatusCard
                subscription={subscription}
                canChangePlan={canChangePlan}
                actionLoading={busy}
                portalLoading={portalLoading}
                onReactivate={handleReactivate}
                onCancel={() => setConfirmCancel(true)}
                onManageBilling={openBillingPortal}
              />
            )}

            {/* Cost & usage rollup. Renders even without an active subscription
                (developer-tier defaults still produce useful data). */}
            {usageQ.error ? (
              <RetryError
                message={`Couldn't load usage for this period: ${formatError(usageQ.error, 'Failed to load usage')}`}
                onRetry={usageQ.refetch}
              />
            ) : usage && (
              <UsageCard
                rollup={usage}
                onPeriodChange={handleUsagePeriodChange}
                overridden={!!(usagePeriod.periodStart || usagePeriod.periodEnd)}
              />
            )}

            {/* Per-team usage breakdown (feature-gated: team_usage_analytics). */}
            <TeamUsageCard />

            {/* AWS Marketplace entitlements — read-only, self-fetching. Hides itself
                when the provider isn't marketplace (400) or the org has none (404). */}
            <MarketplaceEntitlementsPanel />
          </div>
        )}

        {activeTab === 'plans' && (
          <div className="space-y-8">
            {intervalToggle}

            {/* Why they're here: arrived from an add-on's "Subscribe to add". Name
                the pack and the plans that sell it, so the choice isn't a guess. */}
            {addonIntent && (
              <div className="flex items-start justify-between gap-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-4 py-3">
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  Pick a plan to add <span className="font-medium">{addonIntent.name}</span>
                  {tierAvailabilityText(addonIntent) ? ` — sold on ${tierAvailabilityText(addonIntent)}` : ''}.
                  {' '}You&apos;ll come back here to buy it.
                </p>
                <Button variant="secondary" size="sm" onClick={clearAddonIntent}>Dismiss</Button>
              </div>
            )}

            {/* Plan cards (tier pricing) */}
            <PlanGrid
              plans={plans}
              subscription={subscription}
              billingInterval={billingInterval}
              actionLoading={busy}
              canChangePlan={canChangePlan}
              selfService={billingProvider !== 'aws-marketplace'}
              onSubscribe={requestPlanChange}
            />

            {!canChangePlan && (
              <p className="text-sm text-gray-400 dark:text-gray-500 text-center mt-6">
                {activeOrgIsTeam
                  ? 'This is a team. Its plan, add-ons and billing are managed by an admin at the parent organization.'
                  : 'Contact an organization admin to change your plan.'}
              </p>
            )}
          </div>
        )}

        {activeTab === 'addons' && (
          <div className="space-y-8">
            {intervalToggle}

            {/* Add-on bundles — extra capacity that stacks on the base plan and
                pools across the account's teams. Shown to plan managers even without
                an active subscription (read-only preview via `subscribed={false}`);
                purchase controls unlock once subscribed. */}
            {bundlesQ.error ? (
              <RetryError
                message={`Couldn't load the add-on catalog: ${formatError(bundlesQ.error, 'Failed to load add-ons')}`}
                onRetry={bundlesQ.refetch}
              />
            ) : canChangePlan && bundles.length > 0 ? (
              <AddonGrid
                bundles={bundles}
                billingInterval={billingInterval}
                bundleSelfService={bundleSelfService}
                subscribed={!!subscription}
                actionLoading={busy}
                previewLoading={addon.previewLoading}
                changePending={!!addon.pendingAddon}
                addonQty={addonQty}
                requestAddonChange={addon.requestAddonChange}
                highlightFeature={highlightFeature}
                comboDiscounts={comboDiscounts}
                onSubscribeIntent={startAddonIntent}
              />
            ) : (
              <p className="text-sm text-gray-400 dark:text-gray-500 text-center">
                {!canChangePlan
                  ? (activeOrgIsTeam
                    ? 'This is a team. Its plan, add-ons and billing are managed by an admin at the parent organization.'
                    : 'Contact an organization admin to manage add-ons.')
                  : 'No add-ons are available for your plan.'}
              </p>
            )}

            {/* Discount-code redemption — attaches to the active subscription as a
                usage credit. Only rendered with a subscription in scope (a discount
                needs something to attach to). Fails soft (hides itself) when the
                discounts feature is disabled. */}
            {subscription && (
              <DiscountRedeem
                subscription={subscription}
                canManage={canChangePlan}
                onApplied={reloadAll}
              />
            )}
          </div>
        )}

        {activeTab === 'history' && (
          <div className="space-y-8">
            {/* Billing actuals — gross → discounts/credits → net + invoice history.
                Self-fetches; renders nothing until there's billing history. */}
            <BillingDashboard />

            {/* Billing history events (credit applied/consumed/exhausted, discounts,
                combos), paged on the server. Self-fetching on demand. */}
            <BillingHistory isSuperAdmin={isSuperAdmin} />
          </div>
        )}

        {/* Modals — available on any tab */}
        {pendingPlan && subscription && (
          <PlanChangeModal
            targetPlan={pendingPlan}
            currentPlanName={subscription.planName || subscription.planId}
            interval={billingInterval}
            isDowngrade={isPlanDowngrade(subscription.planId, pendingPlan.id)}
            loading={busy}
            onConfirm={() => void doSubscribe(pendingPlan.id)}
            onClose={() => { if (!actionLoading) setPendingPlan(null); }}
          />
        )}

        {confirmCancel && subscription && (
          <ConfirmDialog
            title="Cancel your subscription?"
            confirmLabel="Cancel subscription"
            cancelLabel="Keep subscription"
            tone="danger"
            loading={actionLoading}
            onConfirm={() => void handleCancel()}
            onCancel={() => setConfirmCancel(false)}
          >
            <p>
              Your {subscription.planName || subscription.planId} plan stays active until the end of the current
              billing period, <strong>{formatDate(subscription.currentPeriodEnd)}</strong>. After that it isn&apos;t
              renewed, and the plan&apos;s limits and any add-ons stop with it.
            </p>
            <p>You can reactivate at any time before then.</p>
          </ConfirmDialog>
        )}

        {addon.pendingAddon && (
          <AddonPreviewModal
            pendingAddon={addon.pendingAddon}
            addonPreview={addon.addonPreview}
            previewLoading={addon.previewLoading}
            paymentRequired={addon.paymentRequired}
            actionLoading={busy}
            portalLoading={portalLoading}
            onClose={addon.closeAddonChange}
            onCancel={addon.cancelAddonChange}
            onConfirmAddonChange={addon.confirmAddonChange}
            onOpenBillingPortal={openBillingPortal}
          />
        )}
      </div>

    </DashboardLayout>
  );
}
