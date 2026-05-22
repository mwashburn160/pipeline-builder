import { useEffect, useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { formatBytes } from '@/lib/format';
import { useRouter } from 'next/router';
import { Check, AlertCircle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFeatures } from '@/hooks/useFeatures';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { useToast } from '@/components/ui/Toast';
import type { Plan, Subscription, BillingInterval, UsageRollup } from '@/types';
import api from '@/lib/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLAN_COLORS: Record<string, { border: string; badge: string; bg: string }> = {
  developer: {
    border: 'border-green-500',
    badge: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    bg: 'bg-green-50 dark:bg-green-950',
  },
  pro: {
    border: 'border-blue-500',
    badge: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    bg: 'bg-blue-50 dark:bg-blue-950',
  },
  unlimited: {
    border: 'border-purple-500',
    badge: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
    bg: 'bg-purple-50 dark:bg-purple-950',
  },
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
              <div className="mt-1 h-2 w-full bg-gray-200 dark:bg-gray-700 rounded">
                <div
                  className={`h-2 rounded ${barColor}`}
                  style={{ width: `${isUnlimited ? 0: (entry.percentOfLimit ?? 0)}%` }}
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
  const features = useFeatures();
  const toast = useToast();
  const canChangePlan = isAdmin;

  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [usage, setUsage] = useState<UsageRollup | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [interval, setInterval] = useState<BillingInterval>('monthly');
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
      const [plansRes, subRes, usageRes] = await Promise.all([
        api.getPlans(),
        api.getSubscription(),
        api.getBillingUsage().catch(() => null),
      ]);

      if (plansRes.success && plansRes.data?.plans) {
        setPlans(plansRes.data.plans);
      }
      if (subRes.success) {
        setSubscription(subRes.data?.subscription ?? null);
        if (subRes.data?.subscription?.interval) {
          setInterval(subRes.data.subscription.interval);
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
        const res = await api.changeSubscription(subscription.id, { planId, interval });
        if (res.success) {
          toast.success('Plan changed successfully');
          await fetchData();
        }
      } else {
        const res = await api.createSubscription(planId, interval);
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
                <p className="text-lg font-medium text-gray-900 dark:text-gray-100 capitalize">
                  {subscription.status}
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
              onClick={() => setInterval('monthly')}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                interval === 'monthly'
                  ? 'bg-blue-600 text-white'
: 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setInterval('annual')}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                interval === 'annual'
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {plans.map((plan) => {
            const colors = PLAN_COLORS[plan.id] || PLAN_COLORS.developer;
            const isCurrent = subscription?.planId === plan.id;
            const price = interval === 'annual' ? plan.prices.annual: plan.prices.monthly;

            return (              <div
                key={plan.id}
                className={`card relative p-6 transition-all ${
                  isCurrent
                    ? `border-2 ${colors.border} ${colors.bg} shadow-lg`
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
                  <span className={`inline-block text-xs font-semibold px-3 py-1 rounded-full ${colors.badge}`}>
                    {plan.name}
                  </span>
                  <p className="mt-4 text-4xl font-bold text-gray-900 dark:text-gray-100">
                    {formatPrice(price)}
                  </p>
                  {price > 0 && (                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      per {interval === 'annual' ? 'year': 'month'}
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
            Contact an organization admin to change your plan.
          </p>
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
