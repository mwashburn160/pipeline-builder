import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import { Check, AlertCircle } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useConfig } from '@/hooks/useConfig';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { Toast } from '@/components/ui/Toast';
import type { Plan, Subscription, BillingInterval } from '@/types';
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Billing and subscription management page. Displays current subscription status and plan selection with monthly/annual toggle. */
export default function BillingPage() {
  const router = useRouter();
  const { user, isReady, isSystemOrg, isSysAdmin } = useAuthGuard();
  const { config } = useConfig();
  const canChangePlan = isSysAdmin;

  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [interval, setInterval] = useState<BillingInterval>('monthly');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // System org or billing disabled — redirect to dashboard
  useEffect(() => {
    if (isReady && (isSystemOrg || !config.billingEnabled)) {
      router.replace('/dashboard');
    }
  }, [isReady, isSystemOrg, config.billingEnabled, router]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [plansRes, subRes] = await Promise.all([
        api.getPlans(),
        api.getSubscription(),
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
    } catch {
      setToast({ message: 'Failed to load billing data', type: 'error' });
    } finally {
      setLoading(false);
    }
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
          setToast({ message: 'Plan changed successfully', type: 'success' });
          await fetchData();
        }
      } else {
        const res = await api.createSubscription(planId, interval);
        if (res.success) {
          setToast({ message: 'Subscription created successfully', type: 'success' });
          await fetchData();
        }
      }
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to update subscription', type: 'error' });
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
        setToast({ message: 'Subscription will be canceled at end of billing period', type: 'success' });
        await fetchData();
      }
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to cancel', type: 'error' });
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
        setToast({ message: 'Subscription reactivated', type: 'success' });
        await fetchData();
      }
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to reactivate', type: 'error' });
    } finally {
      setActionLoading(false);
    }
  };

  if (!isReady || loading || isSystemOrg || !config.billingEnabled) return <LoadingPage />;

  return (
    <DashboardLayout title="Billing">
      <div className="space-y-8">
        {/* Current Subscription Status */}
        {subscription && (
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-6">
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
                  {subscription.cancelAtPeriodEnd && (
                    <span className="ml-2 inline-flex items-center text-xs text-amber-600 dark:text-amber-400">
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
            {canChangePlan && (
              <div className="mt-4 flex gap-3">
                {subscription.cancelAtPeriodEnd ? (
                  <button
                    onClick={handleReactivate}
                    disabled={actionLoading}
                    className="btn btn-primary text-sm"
                  >
                    {actionLoading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
                    Reactivate Subscription
                  </button>
                ) : subscription.planId !== 'developer' ? (
                  <button
                    onClick={handleCancel}
                    disabled={actionLoading}
                    className="btn btn-secondary text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950"
                  >
                    Cancel Subscription
                  </button>
                ) : null}
              </div>
            )}
          </div>
        )}

        {/* Billing Interval Toggle */}
        <div className="flex justify-center">
          <div className="inline-flex items-center bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-1">
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
            const price = interval === 'annual' ? plan.prices.annual : plan.prices.monthly;

            return (
              <div
                key={plan.id}
                className={`relative rounded-xl border-2 p-6 transition-all ${
                  isCurrent
                    ? `${colors.border} ${colors.bg} shadow-lg`
                    : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:shadow-md'
                }`}
              >
                {isCurrent && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
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
                  {price > 0 && (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      per {interval === 'annual' ? 'year' : 'month'}
                    </p>
                  )}
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{plan.description}</p>
                </div>

                <ul className="space-y-3 mb-6">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start text-sm text-gray-700 dark:text-gray-300">
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
                  {actionLoading ? (
                    <LoadingSpinner size="sm" />
                  ) : isCurrent ? (
                    'Current Plan'
                  ) : subscription ? (
                    'Switch to this plan'
                  ) : (
                    'Get Started'
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {!canChangePlan && (
          <p className="text-sm text-gray-400 dark:text-gray-500 text-center mt-6">
            Contact a system administrator to change your plan.
          </p>
        )}
      </div>

      {toast && (
        <Toast message={toast.message} type={toast.type} onDone={() => setToast(null)} />
      )}
    </DashboardLayout>
  );
}
