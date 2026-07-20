import { useEffect, useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { useRouter } from 'next/router';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useAuth } from '@/hooks/useAuth';
import { useFeatures } from '@/hooks/useFeatures';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage } from '@/components/ui/Loading';
import { useToast } from '@/components/ui/Toast';
import type { Plan, Subscription, Bundle, AddonResult, BillingInterval, UsageRollup } from '@/types';
import api, { ApiError } from '@/lib/api';
import { SubscriptionStatusCard } from '@/components/billing/SubscriptionStatusCard';
import { UsageCard } from '@/components/billing/UsageCard';
import { PlanGrid } from '@/components/billing/PlanGrid';
import { AddonGrid } from '@/components/billing/AddonGrid';
import { AddonPreviewModal } from '@/components/billing/AddonPreviewModal';
import { PlanChangeModal } from '@/components/billing/PlanChangeModal';
import { BillingHistory } from '@/components/billing/BillingHistory';

// Plan hierarchy (low → high). Used to detect a downgrade so the confirm dialog
// can warn that caps/features may drop.
const PLAN_RANK = ['developer', 'pro', 'team', 'enterprise'];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Billing and subscription management page. Displays current subscription status and plan selection with monthly/annual toggle. */
export default function BillingPage() {
  const router = useRouter();
  const { user, isReady, isAdmin, isSuperAdmin, can } = useAuthGuard({ requirePermission: 'billing:read' });
  const { organizations } = useAuth();
  const features = useFeatures();
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
  const canChangePlan = (isAdmin || can('billing:manage')) && (isSuperAdmin || !activeOrgIsTeam);

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

  if (!isReady || loading || !features.isEnabled('billing')) return <LoadingPage />;

  return (    <DashboardLayout title="Billing" subtitle="Plans, invoices, and payment details">
      <div className="page-section space-y-8">
        {/* Current Subscription Status */}
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
        <PlanGrid
          plans={plans}
          subscription={subscription}
          billingInterval={billingInterval}
          actionLoading={actionLoading}
          canChangePlan={canChangePlan}
          onSubscribe={requestPlanChange}
        />

        {!canChangePlan && (          <p className="text-sm text-gray-400 dark:text-gray-500 text-center mt-6">
            {activeOrgIsTeam
              ? 'This is a team. Its plan, add-ons and billing are managed by an admin at the parent organization.'
              : 'Contact an organization admin to change your plan.'}
          </p>
        )}

        {/* Add-on bundles — extra capacity that stacks on the base plan and
            pools across the account's teams. Admin + active subscription only;
            the server rejects Marketplace-billed accounts with guidance. */}
        {canChangePlan && subscription && bundles.length > 0 && (
          <AddonGrid
            bundles={bundles}
            billingInterval={billingInterval}
            bundleSelfService={bundleSelfService}
            actionLoading={actionLoading}
            previewLoading={previewLoading}
            addonQty={addonQty}
            requestAddonChange={requestAddonChange}
          />
        )}

        {/* Confirm a plan switch before it commits (parity with add-ons, which
            get a preview + confirm). A downgrade shows a caps/features warning. */}
        {pendingPlan && subscription && (
          <PlanChangeModal
            targetPlan={pendingPlan}
            currentPlanName={subscription.planName || subscription.planId}
            interval={billingInterval}
            isDowngrade={PLAN_RANK.indexOf(pendingPlan.id) < PLAN_RANK.indexOf(subscription.planId)}
            loading={actionLoading}
            onConfirm={() => void doSubscribe(pendingPlan.id)}
            onClose={() => { if (!actionLoading) setPendingPlan(null); }}
          />
        )}

        {/* Preview-and-confirm: show the itemized new price (and any over-cap
            note) before committing an add-on change. */}
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

        {/* Billing history. Sysadmins see fleet-wide via /admin/events;
            org-admins see their own org's events via the same endpoint
            (the backend gates by `orgId` query param when not sysadmin).
            Quietly degrades to an empty section if the backend rejects. */}
        {isAdmin && (
          <BillingHistory
            isSuperAdmin={isSuperAdmin}
            showEvents={showEvents}
            billingEvents={billingEvents}
            onViewEvents={fetchEvents}
          />
        )}
      </div>

    </DashboardLayout>
  );
}
