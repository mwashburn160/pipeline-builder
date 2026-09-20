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
import { queries } from '@/lib/api-cache';
import { formatDate } from '@/lib/format';
import { useUrlTab } from '@/hooks/useUrlTab';
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
import { MarketplaceEntitlementsPanel } from '@/components/billing/MarketplaceEntitlementsPanel';
import { useBillingActions } from '@/components/billing/useBillingActions';

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
  }, [router.isReady, router.query.tab, router.query.highlight]); // eslint-disable-line react-hooks/exhaustive-deps -- `selectTab` depends on router.query, so it changes identity on every navigation

  // Deep-link: `?highlight=<feature>` (e.g. from the Reports DORA upsell CTA)
  // emphasizes + scrolls to the add-on bundle that grants that feature.
  const highlightRaw = router.query.highlight;
  const highlightFeature = Array.isArray(highlightRaw) ? highlightRaw[0] : highlightRaw ?? null;

  // Billing service disabled in this deployment → show a "Billing not enabled"
  // card (below) rather than a silent redirect. A silent bounce made the page
  // feel broken (and, while the probe was undefined, could spin forever); the
  // explicit card tells the user what's happening.

  // The primary billing reads (plans + subscription) failing is an error +
  // retry, so a paying customer isn't shown an empty "no subscription" page.
  const loadError = plansQ.error ?? subQ.error;
  const initialLoading = (plansQ.loading && !plansQ.data) || (subQ.loading && !subQ.data);

  // Every billing write, plus the "I came for this add-on" intent that survives
  // the plan-selection detour and the hosted-Checkout redirect.
  const {
    actionLoading, busy, addon, addonIntent, startAddonIntent, clearAddonIntent,
    pendingPlan, setPendingPlan, requestPlanChange, doSubscribe, addonQty,
    portalLoading, openBillingPortal, confirmCancel, setConfirmCancel,
    handleCancel, handleReactivate, reloadAll,
  } = useBillingActions({
    subscription,
    plans,
    bundles,
    billingInterval,
    billingProvider,
    changeTab,
    onReload: () => { bundlesQ.refetch(); usageQ.refetch(); },
  });

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
              ? 'bg-brand text-white'
              : 'text-fg-muted hover:text-fg'
          }`}
        >
          Monthly
        </button>
        <button
          onClick={() => setBillingInterval('annual')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            billingInterval === 'annual'
              ? 'bg-brand text-white'
              : 'text-fg-muted hover:text-fg'
          }`}
        >
          Annual
          <span className="ml-1 text-xs text-success">Save ~17%</span>
        </button>
      </Card>
    </div>
  );

  return (    <DashboardLayout title="Billing" subtitle="Plans, invoices, and payment details">
      <div className="page-section space-y-6">
        <TabBar items={BILLING_TABS} activeId={activeTab} onSelect={changeTab} ariaLabel="Billing sections" />

        {activeTab === 'overview' && (
          <div className="space-y-6">
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
                    <CreditCard className="w-5 h-5 shrink-0 text-fg-subtle" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-fg">Payment provider</p>
                      <p className="text-xs text-fg-muted">
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
          <div className="space-y-6">
            {intervalToggle}

            {/* Why they're here: arrived from an add-on's "Subscribe to add". Name
                the pack and the plans that sell it, so the choice isn't a guess. */}
            {addonIntent && (
              <div className="flex items-start justify-between gap-3 rounded-lg border border-info-border bg-info-bg px-4 py-3">
                <p className="text-sm text-info-strong">
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
              <p className="text-sm text-fg-subtle text-center mt-6">
                {activeOrgIsTeam
                  ? 'This is a team. Its plan, add-ons and billing are managed by an admin at the parent organization.'
                  : 'Contact an organization admin to change your plan.'}
              </p>
            )}
          </div>
        )}

        {activeTab === 'addons' && (
          <div className="space-y-6">
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
              <p className="text-sm text-fg-subtle text-center">
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
          <div className="space-y-6">
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
