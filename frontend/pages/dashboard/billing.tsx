import { useEffect, useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { formatBytes } from '@/lib/format';
import { useRouter } from 'next/router';
import { Check, AlertCircle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useAuth } from '@/hooks/useAuth';
import { useFeatures } from '@/hooks/useFeatures';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import type { Plan, Subscription, Bundle, AddonResult, BillingInterval, UsageRollup } from '@/types';
import { getTierMeta } from '@/lib/tiers';
import api, { ApiError } from '@/lib/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Plan badge styling comes from the shared TIER_META catalog (`getTierMeta`).
// Border/background tints stay local because they're page-specific accents
// (the "current plan" highlight) rather than a tier identity.
const PLAN_ACCENTS: Record<string, { border: string; bg: string }> = {
  developer:  { border: 'border-green-500',   bg: 'bg-green-50 dark:bg-green-950' },
  pro:        { border: 'border-blue-500',    bg: 'bg-blue-50 dark:bg-blue-950' },
  team:       { border: 'border-purple-500',  bg: 'bg-purple-50 dark:bg-purple-950' },
  enterprise: { border: 'border-amber-500',   bg: 'bg-amber-50 dark:bg-amber-950' },
};

/**
 * Formats a price in cents as a dollar string.
 * @param cents - Price in cents (0 returns "Free").
 * @returns Formatted price string, e.g. "$9.99".
 */
function formatPrice(cents: number): string {
  if (cents === 0) return 'Free';
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Formats an ISO date string as a human-readable date.
 * @param iso - ISO 8601 date string.
 * @returns Localized date string, e.g. "February 25, 2026".
 */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

// formatBytes lives in src/lib/format.ts so the registry table and any
// future byte-displaying surface share the same rounding.

/** Quota-type → human label. Keep in sync with the keys returned by
 * `GET /api/billing/usage`; falls back to the raw key for new types so the
 * UI degrades to "{key}: 12 / 100" instead of erroring. */
const QUOTA_LABELS: Record<string, { label: string; unit?: 'bytes' }> = {
  plugins: { label: 'Plugins' },
  pipelines: { label: 'Pipelines' },
  apiCalls: { label: 'API calls' },
  aiCalls: { label: 'AI calls' },
  storageBytes: { label: 'Registry storage', unit: 'bytes' },
};

/** Friendly labels for subscription status (avoids raw "Past_due" from CSS capitalize). */
const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  canceled: 'Canceled',
  past_due: 'Past due',
  trialing: 'Trialing',
  incomplete: 'Incomplete',
};

/** Read-only "this period" cost + usage rollup.. */
function UsageCard({ rollup }: { rollup: UsageRollup }) {
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (    <div className="card">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Usage this period</h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {rollup.period.daysElapsed} of {rollup.period.daysElapsed + rollup.period.daysRemaining} days elapsed
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Subscription</p>
          <p className="text-lg font-medium text-gray-900 dark:text-gray-100">
            {rollup.subscription ? `${dollars(rollup.cost.subscriptionCents)} / ${rollup.subscription.interval === 'annual' ? 'year': 'month'}`: 'No active plan'}
          </p>
        </div>
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Period start</p>
          <p className="text-sm text-gray-900 dark:text-gray-100">{formatDate(rollup.period.start)}</p>
        </div>
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Period end</p>
          <p className="text-sm text-gray-900 dark:text-gray-100">{formatDate(rollup.period.end)}</p>
        </div>
      </div>

      <div className="space-y-3">
        {Object.entries(rollup.usage).map(([key, entry]) => {
          const cfg = QUOTA_LABELS[key] ?? { label: key };
          const isBytes = cfg.unit === 'bytes';
          const isUnlimited = entry.percentOfLimit === null;
          const usedLabel = isBytes ? formatBytes(entry.used): entry.used.toLocaleString();
          const limitLabel = isUnlimited
            ? 'Unlimited'
: isBytes ? formatBytes(entry.limit): entry.limit.toLocaleString();
          // Color the bar by saturation  green up to 75%, amber 75-90%, red >90%.
          // Same thresholds the quota service uses for at-risk alerts so the UI
          // matches the operational view.
          const barColor = isUnlimited
            ? 'bg-gray-300 dark:bg-gray-600'
: (entry.percentOfLimit ?? 0) >= 90 ? 'bg-red-500'
: (entry.percentOfLimit ?? 0) >= 75 ? 'bg-amber-500'
: 'bg-green-500';
          return (            <div key={key}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium text-gray-900 dark:text-gray-100">{cfg.label}</span>
                <span className="text-gray-500 dark:text-gray-400">
                  {usedLabel} / {limitLabel}
                  {entry.percentOfLimit !== null && <span className="ml-2">({entry.percentOfLimit}%)</span>}
                </span>
              </div>
              <div className="mt-1 h-2 w-full bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
                <div
                  className={`h-2 rounded ${barColor}`}
                  style={{ width: `${isUnlimited ? 0: Math.min(100, entry.percentOfLimit ?? 0)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Billing and subscription management page. Displays current subscription status and plan selection with monthly/annual toggle. */
export default function BillingPage() {
  const router = useRouter();
  const { user, isReady, isAdmin, isSuperAdmin } = useAuthGuard();
  const { organizations } = useAuth();
  const features = useFeatures();
  const toast = useToast();
  // Billing lives at the ROOT org (pooled-at-root): the subscription, tier,
  // quota pool and add-ons all belong to the account boundary. A team (child
  // org) admin manages members within their team but cannot change the plan or
  // buy add-ons — those are managed from the parent org. Sysadmins are exempt.
  const activeOrg = organizations.find((o) => o.id === user?.organizationId);
  const activeOrgIsTeam = !!activeOrg?.parentOrgId;
  const canChangePlan = isAdmin && (isSuperAdmin || !activeOrgIsTeam);

  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [bundles, setBundles] = useState<Bundle[]>([]);
  // false for Marketplace-billed accounts: add-ons are managed in AWS, so the
  // catalog renders read-only with a note instead of purchase controls.
  const [bundleSelfService, setBundleSelfService] = useState(false);
  const [usage, setUsage] = useState<UsageRollup | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');
  const [billingEvents, setBillingEvents] = useState<Array<{ id: string; type: string; orgId: string; createdAt: string; detail?: Record<string, unknown> }>>([]);
  const [showEvents, setShowEvents] = useState(false);

  // Billing not available (disabled or system org)  redirect to dashboard
  useEffect(() => {
    if (isReady && !features.isEnabled('billing')) {
      router.replace('/dashboard');
    }
  }, [isReady, features, router]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Usage rolls into the same fetch so the page renders the full picture
      // in one network round-trip. A usage-endpoint failure must not gate the
      // whole page  billing data is the primary surface; usage degrades.
      const [plansRes, subRes, usageRes, bundlesRes] = await Promise.all([
        api.getPlans(),
        api.getSubscription(),
        api.getBillingUsage().catch(() => null),
        api.getBundles().catch(() => null),
      ]);

      if (plansRes.success && plansRes.data?.plans) {
        setPlans(plansRes.data.plans);
      }
      if (bundlesRes?.success && bundlesRes.data?.bundles) {
        setBundles(bundlesRes.data.bundles);
        setBundleSelfService(bundlesRes.data.selfService ?? false);
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

  const fetchEvents = useCallback(async () => {
    try {
      const res = await api.listBillingEvents({ limit: 50 });
      setBillingEvents(res.data?.events || []);
      setShowEvents(true);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (user) fetchData();
  }, [user, fetchData]);

  const handleSubscribe = async (planId: string) => {
    setActionLoading(true);
    try {
      if (subscription) {
        const res = await api.changeSubscription(subscription.id, { planId, interval: billingInterval });
        if (res.success) {
          toast.success('Plan changed successfully');
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

  if (!isReady || loading || !features.isEnabled('billing')) return <LoadingPage />;

  return (    <DashboardLayout title="Billing" subtitle="Plans, invoices, and payment details">
      <div className="page-section space-y-8">
        {/* Current Subscription Status */}
        {subscription && (          <div className="card">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Current Subscription</h2>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">Plan</p>
                <p className="text-lg font-medium text-gray-900 dark:text-gray-100">{subscription.planName || subscription.planId}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">Status</p>
                <p className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  {STATUS_LABELS[subscription.status] ?? subscription.status}
                  {subscription.cancelAtPeriodEnd && (                    <span className="ml-2 inline-flex items-center text-xs text-amber-600 dark:text-amber-400">
                      <AlertCircle className="w-3 h-3 mr-1" />
                      Cancels at period end
                    </span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">Billing Period</p>
                <p className="text-sm text-gray-900 dark:text-gray-100 capitalize">{subscription.interval}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">Next Billing Date</p>
                <p className="text-sm text-gray-900 dark:text-gray-100">{formatDate(subscription.currentPeriodEnd)}</p>
              </div>
            </div>
            {canChangePlan && (              <div className="mt-4 flex gap-3">
                {subscription.cancelAtPeriodEnd ? (                  <button
                    onClick={handleReactivate}
                    disabled={actionLoading}
                    className="btn btn-primary"
                  >
                    {actionLoading ? <LoadingSpinner size="sm" className="mr-2" />: null}
                    Reactivate Subscription
                  </button>
                ): subscription.planId !== 'developer' ? (                  <button
                    onClick={handleCancel}
                    disabled={actionLoading}
                    className="btn btn-danger-outline"
                  >
                    Cancel Subscription
                  </button>
                ): null}
              </div>
            )}
          </div>
        )}

        {/* Cost & usage rollup. Renders even without an active
            subscription (developer-tier defaults still produce useful data). */}
        {usage && <UsageCard rollup={usage} />}

        {/* Billing Interval Toggle */}
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

        {/* Plan Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {plans.map((plan) => {
            const accents = PLAN_ACCENTS[plan.id] || PLAN_ACCENTS.developer;
            const tierMeta = getTierMeta(plan.id);
            const isCurrent = subscription?.planId === plan.id;
            const price = billingInterval === 'annual' ? plan.prices.annual: plan.prices.monthly;

            return (              <div
                key={plan.id}
                className={`card relative p-6 transition-all ${
                  isCurrent
                    ? `border-2 ${accents.border} ${accents.bg} shadow-lg`
: 'hover:shadow-md'
                }`}
              >
                {isCurrent && (                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="bg-blue-600 text-white text-xs font-medium px-3 py-1 rounded-full">
                      Current Plan
                    </span>
                  </div>
                )}

                <div className="text-center mb-6">
                  <span className={`inline-block text-xs font-semibold px-3 py-1 rounded-full ${tierMeta.pillClass}`}>
                    {plan.name}
                  </span>
                  <p className="mt-4 text-4xl font-bold text-gray-900 dark:text-gray-100">
                    {formatPrice(price)}
                  </p>
                  {price > 0 && (                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      per {billingInterval === 'annual' ? 'year': 'month'}
                    </p>
                  )}
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{plan.description}</p>
                </div>

                <ul className="space-y-3 mb-6">
                  {plan.features.map((feature) => (                    <li key={feature} className="flex items-start text-sm text-gray-700 dark:text-gray-300">
                      <Check className="w-4 h-4 mr-2 mt-0.5 text-green-500 flex-shrink-0" />
                      {feature}
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => handleSubscribe(plan.id)}
                  disabled={isCurrent || actionLoading || !canChangePlan}
                  className={`w-full py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
                    isCurrent || !canChangePlan
                      ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed'
: 'btn btn-primary justify-center'
                  }`}
                >
                  {actionLoading ? (                    <LoadingSpinner size="sm" />
                  ): isCurrent ? (                    'Current Plan'
                  ): subscription ? (                    'Switch to this plan'
                  ): (                    'Get Started'
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {!canChangePlan && (          <p className="text-sm text-gray-400 dark:text-gray-500 text-center mt-6">
            {activeOrgIsTeam
              ? 'This is a team. Its plan, add-ons and billing are managed by an admin at the parent organization.'
              : 'Contact an organization admin to change your plan.'}
          </p>
        )}

        {/* Add-on bundles — extra capacity that stacks on the base plan and
            pools across the account's teams. Admin + active subscription only;
            the server rejects Marketplace-billed accounts with guidance. */}
        {canChangePlan && subscription && bundles.length > 0 && (          <div className="mt-10">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Add-ons</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {bundleSelfService
                ? 'Buy extra capacity that stacks on your plan and pools across your teams.'
                : 'Extra capacity that stacks on your plan and pools across your teams. This account is billed through AWS Marketplace — add or remove add-ons from your AWS Marketplace subscription.'}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {bundles.map((b) => {
                const qty = addonQty(b.id);
                const price = billingInterval === 'annual' ? b.prices.annual: b.prices.monthly;
                return (                  <div key={b.id} className="card flex flex-col">
                    <div className="flex items-start justify-between">
                      <h3 className="font-medium text-gray-900 dark:text-gray-100">{b.name}</h3>
                      <span className="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        ${(price / 100).toFixed(2)}/{billingInterval === 'annual' ? 'yr': 'mo'}{b.stackable ? ' ea': ''}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 flex-1">{b.description}</p>
                    <div className="mt-4 flex items-center gap-2">
                      {!bundleSelfService ? (                        <span className="text-sm text-gray-500 dark:text-gray-400">
                          {qty > 0 ? `${qty} active` : 'Managed in AWS Marketplace'}
                        </span>
                      ): b.stackable ? (                        <>
                          <button
                            type="button"
                            disabled={actionLoading || previewLoading || qty === 0}
                            onClick={() => requestAddonChange(b.id, b.name, qty - 1)}
                            className="btn btn-secondary btn-sm"
                            aria-label={`Remove one ${b.name}`}
                          >&minus;</button>
                          <span className="w-10 text-center tabular-nums">{qty}</span>
                          <button
                            type="button"
                            disabled={actionLoading || previewLoading}
                            onClick={() => requestAddonChange(b.id, b.name, qty + 1)}
                            className="btn btn-secondary btn-sm"
                            aria-label={`Add one ${b.name}`}
                          >+</button>
                        </>
                      ): (                        <button
                          type="button"
                          disabled={actionLoading || previewLoading}
                          onClick={() => requestAddonChange(b.id, b.name, qty > 0 ? 0: 1)}
                          className={`btn btn-sm ${qty > 0 ? 'btn-secondary': 'btn-primary'}`}
                        >
                          {qty > 0 ? 'Remove': 'Add'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Preview-and-confirm: show the itemized new price (and any over-cap
            note) before committing an add-on change. */}
        {pendingAddon && (          <Modal
            title={paymentRequired
              ? 'Payment method required'
              : (pendingAddon.quantity <= 0 ? `Remove ${pendingAddon.name}` : `Update ${pendingAddon.name}`)}
            onClose={() => { if (!actionLoading) { setPendingAddon(null); setAddonPreview(null); setPaymentRequired(false); } }}
            footer={
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setPendingAddon(null); setAddonPreview(null); setPaymentRequired(false); }}
                  disabled={actionLoading || portalLoading}
                  className="btn btn-secondary btn-sm"
                >Cancel</button>
                {paymentRequired ? (                  <button
                    type="button"
                    onClick={openBillingPortal}
                    disabled={portalLoading}
                    className="btn btn-primary btn-sm"
                  >
                    {portalLoading ? <><LoadingSpinner size="sm" className="mr-2" /> Opening…</> : 'Add a payment method'}
                  </button>
                ): (                  <button
                    type="button"
                    onClick={confirmAddonChange}
                    disabled={actionLoading || previewLoading || !addonPreview}
                    className="btn btn-primary btn-sm"
                  >
                    {actionLoading ? <><LoadingSpinner size="sm" className="mr-2" /> Applying…</> : 'Confirm'}
                  </button>
                )}
              </div>
            }
          >
            {paymentRequired ? (              <div className="space-y-3 py-1">
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  This account has no payment method on file, so paid add-ons can&apos;t be charged yet.
                  Add a card to continue — you&apos;ll return here afterward to complete the purchase.
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  You&apos;re taken to our payment provider&apos;s secure portal; we never store card details.
                </p>
              </div>
            ): previewLoading || !addonPreview ? (              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-4">
                <LoadingSpinner size="sm" /> Calculating new price…
              </div>
            ): (              <div className="space-y-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
                    New {addonPreview.priceBreakdown.interval === 'annual' ? 'annual' : 'monthly'} total
                  </p>
                  <ul className="text-sm divide-y divide-gray-100 dark:divide-gray-800">
                    {addonPreview.priceBreakdown.items.map((item, i) => (                      <li key={`${item.label}-${i}`} className="flex justify-between py-1.5">
                        <span className="text-gray-600 dark:text-gray-400">
                          {item.label}{item.quantity > 1 ? ` × ${item.quantity}` : ''}
                        </span>
                        <span className="tabular-nums text-gray-900 dark:text-gray-100">${(item.cents / 100).toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex justify-between border-t border-gray-200 dark:border-gray-700 mt-1 pt-2 text-sm font-semibold">
                    <span className="text-gray-900 dark:text-gray-100">Total</span>
                    <span className="tabular-nums text-gray-900 dark:text-gray-100">
                      ${(addonPreview.priceBreakdown.totalCents / 100).toFixed(2)}/{addonPreview.priceBreakdown.interval === 'annual' ? 'yr' : 'mo'}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Changes are prorated and pool across your organization&apos;s teams. You can adjust or remove add-ons anytime.
                </p>
              </div>
            )}
          </Modal>
        )}

        {/* Billing history. Sysadmins see fleet-wide via /admin/events;
            org-admins see their own org's events via the same endpoint
            (the backend gates by `orgId` query param when not sysadmin).
            Quietly degrades to an empty section if the backend rejects. */}
        {isAdmin && (          <div className="mt-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Billing history</h2>
              {!showEvents && (                <button onClick={fetchEvents} className="btn btn-secondary btn-sm">View events</button>
              )}
            </div>
            {showEvents && billingEvents.length > 0 && (              <div className="card overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-800/50">
                      <th className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300">When</th>
                      <th className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300">Type</th>
                      {isSuperAdmin && (
                        <th className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300">Organization</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {billingEvents.map((evt) => (                      <tr key={evt.id}>
                        <td className="px-4 py-2 text-gray-500 dark:text-gray-400"><RelativeTime value={evt.createdAt} /></td>
                        <td className="px-4 py-2"><Badge color="blue">{evt.type}</Badge></td>
                        {isSuperAdmin && (
                          <td className="px-4 py-2 text-gray-500 dark:text-gray-400 font-mono text-xs">{evt.orgId}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {showEvents && billingEvents.length === 0 && (
              <div className="card py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                No billing events recorded for this organization.
              </div>
            )}
          </div>
        )}
      </div>

    </DashboardLayout>
  );
}
