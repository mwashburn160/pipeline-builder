import { useEffect, useState, useCallback, useRef } from 'react';
import { formatError } from '@/lib/constants';
import { useRouter } from 'next/router';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useAuth } from '@/hooks/useAuth';
import { useBillingEnabledState } from '@/hooks/useBillingEnabled';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Card } from '@/components/ui/Card';
import ReportTabs from '@/components/reports/ReportTabs';
import { LoadingPage } from '@/components/ui/Loading';
import { useToast } from '@/components/ui/Toast';
import type { Plan, Subscription, Bundle, ComboDiscount, AddonResult, BillingInterval, UsageRollup } from '@/types';
import type { MarketplaceEntitlements } from '@/lib/api/domains/billing';
import api, { ApiError } from '@/lib/api';
import { SubscriptionStatusCard } from '@/components/billing/SubscriptionStatusCard';
import { UsageCard } from '@/components/billing/UsageCard';
import { BillingDashboard } from '@/components/billing/BillingDashboard';
import { TeamUsageCard } from '@/components/billing/TeamUsageCard';
import { PlanGrid } from '@/components/billing/PlanGrid';
import { AddonGrid } from '@/components/billing/AddonGrid';
import { DiscountRedeem } from '@/components/billing/DiscountRedeem';
import { AddonPreviewModal } from '@/components/billing/AddonPreviewModal';
import { PlanChangeModal } from '@/components/billing/PlanChangeModal';
import { BillingHistory } from '@/components/billing/BillingHistory';

// Plan hierarchy (low → high). Used to detect a downgrade so the confirm dialog
// can warn that caps/features may drop.
const PLAN_RANK = ['developer', 'pro', 'team', 'enterprise'];

// Billing page is organized into tabs (same bar as the Reports page). Each is
// deep-linkable via `?tab=` so links/back-forward land on the right section.
const BILLING_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'plans', label: 'Plans & Add-ons' },
  { id: 'history', label: 'Billing History' },
] as const;
type BillingTab = (typeof BILLING_TABS)[number]['id'];
const BILLING_TAB_IDS = BILLING_TABS.map((t) => t.id) as readonly string[];

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
  const { user, isReady, isAdmin, isSuperAdmin, can, isReadOnly } = useAuthGuard({ requirePermission: 'billing:read' });
  const { organizations } = useAuth();
  // Whether the billing SERVICE is enabled in this deployment (`/api/billing/config`
  // probe). Replaces the old `features.isEnabled('billing')` gate — `'billing'` is
  // NOT a FeatureFlag, so that check was always false and this page redirected/span
  // forever for everyone. Tri-state so the redirect below only fires on a definitive
  // `false`, not while the probe is still resolving.
  const billingEnabled = useBillingEnabledState();
  const toast = useToast();
  // Billing lives at the ROOT org (pooled-at-root): the subscription, tier,
  // quota pool and add-ons all belong to the account boundary. A team (child
  // org) admin manages members within their team but cannot change the plan or
  // buy add-ons — those are managed from the parent org. Sysadmins are exempt.
  const activeOrg = organizations.find((o) => o.id === user?.organizationId);
  const activeOrgIsTeam = !!activeOrg?.parentOrgId;
  // Plan/add-on changes unlock on the `billing:manage` capability (or org-admin
  // role, which holds it in its bundle) — so a custom-group member granted the
  // perm can manage billing. Still root-only: teams manage billing at the parent.
  // `!isReadOnly` closes the read-only-impersonation dead-end: the `isAdmin ||`
  // short-circuit isn't read-only-aware (only `can()` is), so without this a
  // read-only "view-as" of an admin would keep the plan/add-on/cancel/portal
  // controls enabled, each of which the backend then 403s.
  const canChangePlan = (isAdmin || can('billing:manage')) && !isReadOnly && (isSuperAdmin || !activeOrgIsTeam);

  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [bundles, setBundles] = useState<Bundle[]>([]);
  // false for Marketplace-billed accounts: add-ons are managed in AWS, so the
  // catalog renders read-only with a note instead of purchase controls.
  const [bundleSelfService, setBundleSelfService] = useState(false);
  const [comboDiscounts, setComboDiscounts] = useState<ComboDiscount[]>([]);
  const [usage, setUsage] = useState<UsageRollup | null>(null);
  // Editable "Usage this period" window. Empty = derived (subscription/fallback).
  // A ref mirrors it so full-page reloads (`fetchData`) honour an active override
  // without `fetchData` taking `usagePeriod` as a dependency (which would double-fetch).
  const [usagePeriod, setUsagePeriod] = useState<{ periodStart?: string; periodEnd?: string }>({});
  const usagePeriodRef = useRef(usagePeriod);
  usagePeriodRef.current = usagePeriod;
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');
  const [billingEvents, setBillingEvents] = useState<Array<{ id: string; type: string; orgId: string; createdAt: string; detail?: Record<string, unknown> }>>([]);
  const [showEvents, setShowEvents] = useState(false);

  // Active tab, hydrated from `?tab=` and kept in sync (shallow) so tab state is
  // shareable/back-forward-friendly — same pattern as the Reports page.
  const [activeTab, setActiveTab] = useState<BillingTab>('overview');
  useEffect(() => {
    const raw = Array.isArray(router.query.tab) ? router.query.tab[0] : router.query.tab;
    if (raw && BILLING_TAB_IDS.includes(raw)) {
      if (raw !== activeTab) setActiveTab(raw as BillingTab);
      return;
    }
    // A `?highlight=<feature>` upsell link (no explicit tab) targets an add-on,
    // which lives on the Plans & Add-ons tab — land there.
    if (router.query.highlight && activeTab !== 'plans') setActiveTab('plans');
  }, [router.query.tab, router.query.highlight]); // eslint-disable-line react-hooks/exhaustive-deps
  const changeTab = (id: string) => {
    setActiveTab(id as BillingTab);
    // A DORA upsell deep-link (`?highlight=`) lands on Plans & Add-ons; preserve it.
    void router.replace({ query: { ...router.query, tab: id } }, undefined, { shallow: true });
  };

  // Deep-link: `?highlight=<feature>` (e.g. from the Reports DORA upsell CTA)
  // emphasizes + scrolls to the add-on bundle that grants that feature.
  const highlightRaw = router.query.highlight;
  const highlightFeature = Array.isArray(highlightRaw) ? highlightRaw[0] : highlightRaw ?? null;

  // Billing service disabled in this deployment → redirect to dashboard. Only on a
  // DEFINITIVE `false` (probe resolved + reported disabled); while `undefined`
  // (probe in flight/failed) we wait rather than bounce the user out prematurely.
  useEffect(() => {
    if (isReady && billingEnabled === false) {
      router.replace('/dashboard');
    }
  }, [isReady, billingEnabled, router]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Usage rolls into the same fetch so the page renders the full picture
      // in one network round-trip. A usage-endpoint failure must not gate the
      // whole page  billing data is the primary surface; usage degrades.
      const [plansRes, subRes, usageRes, bundlesRes] = await Promise.all([
        api.getPlans(),
        api.getSubscription(),
        api.getBillingUsage(usagePeriodRef.current).catch(() => null),
        api.getBundles().catch(() => null),
      ]);

      if (plansRes.success && plansRes.data?.plans) {
        setPlans(plansRes.data.plans);
      }
      if (bundlesRes?.success && bundlesRes.data?.bundles) {
        setBundles(bundlesRes.data.bundles);
        setBundleSelfService(bundlesRes.data.selfService ?? false);
        setComboDiscounts(bundlesRes.data.comboDiscounts ?? []);
      }
      if (subRes.success) {
        setSubscription(subRes.data?.subscription ?? null);
        if (subRes.data?.subscription?.interval) {
          setBillingInterval(subRes.data.subscription.interval);
        }
      }
      if (usageRes?.success && usageRes.data) {
        setUsage(usageRes.data);
      }
    } catch {
      toast.error('Failed to load billing data');
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-fetch ONLY the usage rollup for a chosen display window (no full-page
  // reload). `undefined` values clear the override → derived period.
  const handleUsagePeriodChange = useCallback(async (periodStart?: string, periodEnd?: string) => {
    setUsagePeriod({ periodStart, periodEnd });
    const res = await api.getBillingUsage({ periodStart, periodEnd }).catch(() => null);
    if (res?.success && res.data) setUsage(res.data);
  }, []);

  const fetchEvents = useCallback(async () => {
    try {
      // Sysadmins see the fleet-wide feed (/admin/events, with the org column);
      // everyone else sees their OWN account's credit/discount/combo events
      // (/events, billing:read) rather than getting 403 off the admin route.
      const res = isSuperAdmin
        ? await api.listBillingEvents({ limit: 50 })
        : await api.listOwnBillingEvents({ limit: 50 });
      setBillingEvents(res.data?.events || []);
      setShowEvents(true);
    } catch { /* ignore */ }
  }, [isSuperAdmin]);

  useEffect(() => {
    if (user) fetchData();
  }, [user, fetchData]);

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
          await fetchData();
        }
      } else {
        const res = await api.createSubscription(planId, billingInterval);
        if (res.success) {
          toast.success('Subscription created successfully');
          await fetchData();
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

  // A proposed add-on change, held while the user confirms the previewed price.
  const [pendingAddon, setPendingAddon] = useState<{ bundleId: string; name: string; quantity: number } | null>(null);
  const [addonPreview, setAddonPreview] = useState<AddonResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // Set when a purchase is blocked by a 402 PAYMENT_METHOD_REQUIRED — swaps the
  // confirm modal for an "Add a payment method" CTA.
  const [paymentRequired, setPaymentRequired] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);

  /** Step 1: dry-run the change so the user sees the new price + effective limits
   *  before committing. Opens the confirm modal on success. */
  const requestAddonChange = async (bundleId: string, name: string, quantity: number) => {
    if (!subscription) return;
    setPendingAddon({ bundleId, name, quantity });
    setAddonPreview(null);
    setPaymentRequired(false);
    setPreviewLoading(true);
    try {
      const res = await api.previewAddon(subscription.id, bundleId, quantity);
      if (res.success && res.data) setAddonPreview(res.data);
    } catch (err) {
      toast.error(formatError(err, 'Failed to price this change'));
      setPendingAddon(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  /** Step 2: commit the previewed change. The server re-checks the over-cap gate;
   *  its 409 message is surfaced verbatim. */
  const confirmAddonChange = async () => {
    if (!subscription || !pendingAddon) return;
    const { bundleId, quantity } = pendingAddon;
    setActionLoading(true);
    try {
      const res = quantity <= 0
        ? await api.removeAddon(subscription.id, bundleId)
        : await api.addAddon(subscription.id, bundleId, quantity);
      if (res.success) {
        toast.success('Add-ons updated');
        setPendingAddon(null);
        setAddonPreview(null);
        await fetchData();
      }
    } catch (err) {
      // A paid purchase with no card on file → show the "add a payment method"
      // CTA in place of a dead-end error toast.
      if (err instanceof ApiError && (err.code === 'PAYMENT_METHOD_REQUIRED' || err.statusCode === 402)) {
        setPaymentRequired(true);
      } else {
        toast.error(formatError(err, 'Failed to update add-on'));
      }
    } finally {
      setActionLoading(false);
    }
  };

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

  const handleCancel = async () => {
    if (!subscription) return;
    setActionLoading(true);
    try {
      const res = await api.cancelSubscription(subscription.id);
      if (res.success) {
        toast.success('Subscription will be canceled at end of billing period');
        await fetchData();
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
        await fetchData();
      }
    } catch (err) {
      toast.error(formatError(err, 'Failed to reactivate'));
    } finally {
      setActionLoading(false);
    }
  };

  // Render the billing UI only once billing is DEFINITIVELY enabled; while the probe
  // is unknown (`undefined`) or disabled (`false` → redirect in flight) show loading.
  if (!isReady || loading || billingEnabled !== true) return <LoadingPage />;

  return (    <DashboardLayout title="Billing" subtitle="Plans, invoices, and payment details">
      <div className="page-section space-y-8">
        <ReportTabs tabs={[...BILLING_TABS]} activeTab={activeTab} onTabChange={changeTab} />

        {activeTab === 'overview' && (
          <div className="space-y-8">
            {/* Current subscription status */}
            {subscription && (
              <SubscriptionStatusCard
                subscription={subscription}
                canChangePlan={canChangePlan}
                actionLoading={actionLoading}
                portalLoading={portalLoading}
                onReactivate={handleReactivate}
                onCancel={handleCancel}
                onManageBilling={openBillingPortal}
              />
            )}

            {/* Cost & usage rollup. Renders even without an active subscription
                (developer-tier defaults still produce useful data). */}
            {usage && (
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
            {/* Billing interval toggle */}
            <div className="flex justify-center">
              <div className="card inline-flex items-center p-1">
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
              </div>
            </div>

            {/* Plan cards (tier pricing) */}
            <PlanGrid
              plans={plans}
              subscription={subscription}
              billingInterval={billingInterval}
              actionLoading={actionLoading}
              canChangePlan={canChangePlan}
              onSubscribe={requestPlanChange}
            />

            {!canChangePlan && (
              <p className="text-sm text-gray-400 dark:text-gray-500 text-center mt-6">
                {activeOrgIsTeam
                  ? 'This is a team. Its plan, add-ons and billing are managed by an admin at the parent organization.'
                  : 'Contact an organization admin to change your plan.'}
              </p>
            )}

            {/* Add-on bundles — extra capacity that stacks on the base plan and
                pools across the account's teams. Shown to plan managers even without
                an active subscription (read-only preview via `subscribed={false}`);
                purchase controls unlock once subscribed. */}
            {canChangePlan && bundles.length > 0 && (
              <AddonGrid
                bundles={bundles}
                billingInterval={billingInterval}
                bundleSelfService={bundleSelfService}
                subscribed={!!subscription}
                actionLoading={actionLoading}
                previewLoading={previewLoading}
                addonQty={addonQty}
                requestAddonChange={requestAddonChange}
                highlightFeature={highlightFeature}
                comboDiscounts={comboDiscounts}
              />
            )}

            {/* Discount-code redemption — attaches to the active subscription as a
                usage credit. Only rendered with a subscription in scope (a discount
                needs something to attach to). Fails soft (hides itself) when the
                discounts feature is disabled. */}
            {subscription && (
              <DiscountRedeem
                subscription={subscription}
                canManage={canChangePlan}
                onApplied={fetchData}
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
                combos). Sysadmins see the fleet-wide feed via /admin/events (with the
                org column); everyone else sees their own account via /events
                (billing:read). Quietly degrades to an empty section on rejection. */}
            <BillingHistory
              isSuperAdmin={isSuperAdmin}
              showEvents={showEvents}
              billingEvents={billingEvents}
              onViewEvents={fetchEvents}
            />
          </div>
        )}

        {/* Modals — available on any tab */}
        {pendingPlan && subscription && (
          <PlanChangeModal
            targetPlan={pendingPlan}
            currentPlanName={subscription.planName || subscription.planId}
            interval={billingInterval}
            isDowngrade={isPlanDowngrade(subscription.planId, pendingPlan.id)}
            loading={actionLoading}
            onConfirm={() => void doSubscribe(pendingPlan.id)}
            onClose={() => { if (!actionLoading) setPendingPlan(null); }}
          />
        )}

        {pendingAddon && (
          <AddonPreviewModal
            pendingAddon={pendingAddon}
            addonPreview={addonPreview}
            previewLoading={previewLoading}
            paymentRequired={paymentRequired}
            actionLoading={actionLoading}
            portalLoading={portalLoading}
            onClose={() => { if (!actionLoading) { setPendingAddon(null); setAddonPreview(null); setPaymentRequired(false); } }}
            onCancel={() => { setPendingAddon(null); setAddonPreview(null); setPaymentRequired(false); }}
            onConfirmAddonChange={confirmAddonChange}
            onOpenBillingPortal={openBillingPortal}
          />
        )}
      </div>

    </DashboardLayout>
  );
}

/**
 * Read-only panel listing the org's current AWS Marketplace entitlements. Only
 * meaningful for Marketplace-billed accounts — self-fetches and fails soft: a
 * 400 (provider isn't marketplace) or 404 (no marketplace subscription) simply
 * renders nothing, so non-Marketplace deployments never see it.
 */
function MarketplaceEntitlementsPanel() {
  const [data, setData] = useState<MarketplaceEntitlements | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getMarketplaceEntitlements()
      .then((res) => { if (!cancelled && res.success && res.data) setData(res.data); })
      .catch(() => { /* fail-soft: not a marketplace account, or none found */ });
    return () => { cancelled = true; };
  }, []);

  if (!data || data.entitlements.length === 0) return null;

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">AWS Marketplace Entitlements</h3>
        <span className="text-xs text-gray-400 dark:text-gray-500">Managed in AWS</span>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Current plan <code className="font-mono">{data.currentPlanId}</code> · customer{' '}
        <code className="font-mono break-all">{data.customerIdentifier}</code>
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
              <th className="py-2 pr-4">Plan</th>
              <th className="py-2 pr-4">Dimension</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Expires</th>
            </tr>
          </thead>
          <tbody>
            {data.entitlements.map((e, i) => (
              <tr key={`${e.planId}-${e.dimension}-${i}`} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                <td className="py-2 pr-4 font-mono text-gray-800 dark:text-gray-200">{e.planId}</td>
                <td className="py-2 pr-4 text-gray-600 dark:text-gray-400">{e.dimension}</td>
                <td className="py-2 pr-4">
                  {e.isEntitled
                    ? <span className="text-green-600 dark:text-green-400 font-medium">Entitled</span>
                    : <span className="text-gray-400 dark:text-gray-500">Not entitled</span>}
                </td>
                <td className="py-2 pr-4 text-gray-600 dark:text-gray-400">
                  {e.expirationDate ? new Date(e.expirationDate).toLocaleDateString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
