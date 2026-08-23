import { useState, useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { Sparkles } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useAuth } from '@/hooks/useAuth';
import { useFeatures } from '@/hooks/useFeatures';
import { LoadingPage } from '@/components/ui/Loading';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { DEFAULT_PLAN_ID } from '@/components/billing/helpers';
import { SelectablePlanCard } from '@/components/billing/SelectablePlanCard';
import { usePlans } from '@/hooks/usePlans';

/**
 * First-run onboarding for social-signup (OAuth) users.
 *
 * Reached only when the profile carries `needsOnboarding` (set by the backend
 * for brand-new OAuth identities, which never got to name an org or pick a
 * plan). `useAuthGuard({ allowOnboarding: true })` opts this page out of the
 * guard's own onboarding redirect so it doesn't loop. Completing (or skipping)
 * clears the flag server-side; a user who lands here already onboarded is
 * bounced straight to the dashboard.
 */
export default function OnboardingPage() {
  const router = useRouter();
  const { user, isReady, refreshUser } = useAuthGuard({ allowOnboarding: true });
  const { markOnboardingComplete } = useAuth();
  const features = useFeatures();
  const billingEnabled = features.isEnabled('billing');

  const [orgName, setOrgName] = useState('');
  const { plans } = usePlans(billingEnabled);
  const [selectedPlan, setSelectedPlan] = useState(DEFAULT_PLAN_ID);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Domain-based discovery (P2b): orgs the user's verified email domain can join.
  const [domainOrgs, setDomainOrgs] = useState<Array<{ orgId: string; orgName: string; autoJoin: 'off' | 'request' | 'auto' }>>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(true);
  const [joiningOrgId, setJoiningOrgId] = useState<string | null>(null);
  const [requestedOrgIds, setRequestedOrgIds] = useState<Set<string>>(new Set());

  // Seed the input with the auto-derived org name so the user edits rather than
  // types from scratch.
  useEffect(() => {
    if (user?.organizationName) setOrgName((prev) => prev || user.organizationName || '');
  }, [user?.organizationName]);

  // Already onboarded (e.g. navigated here directly) — nothing to do.
  useEffect(() => {
    if (isReady && user && !user.needsOnboarding) router.replace('/dashboard');
  }, [isReady, user, router]);

  // Discover orgs the user could join by their verified email domain.
  useEffect(() => {
    let cancelled = false;
    // Safety fallback: discovery is fail-soft/optional, so never let a hung fetch
    // (no fetch timeout in the client) leave the submit buttons disabled forever.
    const fallback = setTimeout(() => { if (!cancelled) setDiscoveryLoading(false); }, 6000);
    api.getDomainOrgs()
      .then((res) => { if (!cancelled && res.success && res.data?.orgs) setDomainOrgs(res.data.orgs); })
      .catch(() => { /* fail-soft: discovery is optional */ })
      .finally(() => { if (!cancelled) setDiscoveryLoading(false); });
    return () => { cancelled = true; clearTimeout(fallback); };
  }, []);

  const goToDashboard = async () => {
    // Refresh first (syncs the new org name), THEN re-apply the optimistic clear —
    // so a stale read-replica returning needsOnboarding:true can't overwrite it and
    // bounce the user back to onboarding via the guard.
    await refreshUser();
    markOnboardingComplete();
    router.replace('/dashboard');
  };

  const handleJoin = async (org: { orgId: string }) => {
    setJoiningOrgId(org.orgId);
    setError(null);
    try {
      const res = await api.joinDomainOrg(org.orgId);
      if (res.data?.status === 'requested') {
        setRequestedOrgIds((prev) => new Set(prev).add(org.orgId));
        setJoiningOrgId(null);
        return; // async approval — the user can still set up their own org below
      }
      if (res.data?.status === 'denied') {
        setError('A previous request to join this organization was declined. Contact an admin, or set up your own organization below.');
        setJoiningOrgId(null);
        return;
      }
      // joined or already-member → clear the first-run flag and head in.
      await api.completeOnboarding({});
      await goToDashboard();
    } catch (e) {
      setError(formatError(e));
      setJoiningOrgId(null);
    }
  };

  const finish = async (withName: boolean) => {
    setSubmitting(true);
    setError(null);
    try {
      const trimmed = orgName.trim();
      await api.completeOnboarding({
        organizationName: withName && trimmed.length >= 2 ? trimmed : undefined,
        planId: billingEnabled ? selectedPlan : undefined,
      });
      // Optimistically clear the flag locally so the guard can't bounce us back
      // to onboarding if the follow-up profile refresh transiently fails; the
      // refresh then syncs the new org name (it swallows its own errors).
      await goToDashboard();
    } catch (e) {
      setError(formatError(e));
      setSubmitting(false);
    }
  };

  if (!isReady || !user) return <LoadingPage />;

  return (
    <>
      <Head><title>Welcome — Set up your organization</title></Head>
      <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-[var(--pb-bg)]">
        <Card className="w-full max-w-lg p-6">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-5 h-5 text-[var(--pb-brand)]" />
            <h1 className="text-xl font-bold">Welcome to Pipeline Builder</h1>
          </div>
          <p className="text-sm text-[var(--pb-text-muted)] mb-5">
            You signed up with a social account, so we created an organization for you.
            Give it a name{billingEnabled ? ' and pick a plan' : ''} to finish setting up.
          </p>

          {domainOrgs.length > 0 && (
            <div className="mb-5 rounded-lg border border-[var(--pb-border)] bg-[var(--pb-surface-muted)] p-3">
              <div className="text-sm font-semibold mb-1">Join your team</div>
              <p className="text-xs text-[var(--pb-text-muted)] mb-3">
                Your email domain matches {domainOrgs.length === 1 ? 'an organization' : 'organizations'} already on Pipeline Builder.
              </p>
              <div className="space-y-2">
                {domainOrgs.map((org) => (
                  <div key={org.orgId} className="flex items-center justify-between gap-3 rounded-md border border-[var(--pb-border)] p-2.5">
                    <span className="font-medium text-sm truncate">{org.orgName}</span>
                    {requestedOrgIds.has(org.orgId) ? (
                      <span className="text-xs text-[var(--pb-success)] shrink-0 text-right">Request sent ✓<br /><span className="text-[var(--pb-text-muted)]">An admin will review it.</span></span>
                    ) : (
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={joiningOrgId !== null || submitting}
                        onClick={() => void handleJoin(org)}
                      >
                        {joiningOrgId === org.orgId ? '…' : org.autoJoin === 'auto' ? 'Join' : 'Request access'}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <div className="text-[11px] uppercase tracking-wide text-[var(--pb-text-muted)] mt-4">or set up your own</div>
            </div>
          )}

          <form onSubmit={(e) => { e.preventDefault(); void finish(true); }}>
            <FormField label="Organization name" id="org-name" hint="You can rename this later in Settings.">
              <Input
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Acme Inc."
                minLength={2}
                maxLength={100}
                autoFocus
              />
            </FormField>

            {billingEnabled && plans.length > 0 && (
              <div className="mt-5">
                <span className="block text-sm font-medium mb-2">Plan</span>
                <div className="space-y-2">
                  {plans.map((plan) => (
                    <SelectablePlanCard
                      key={plan.id}
                      plan={plan}
                      variant="compact"
                      selected={selectedPlan === plan.id}
                      onSelect={() => setSelectedPlan(plan.id)}
                    />
                  ))}
                </div>
                <p className="text-xs text-[var(--pb-text-muted)] mt-1">Start free — change or upgrade anytime in Billing.</p>
              </div>
            )}

            {error && <div className="mt-4"><ErrorAlert message={error} /></div>}

            <div className="mt-6 flex items-center gap-3">
              {/* Gate on features.isLoaded (so a submit before /config resolves
                  can't silently drop the plan choice) and on discovery finishing
                  (so a fast user doesn't create a redundant org before their team
                  appears above). */}
              <Button type="submit" disabled={submitting || joiningOrgId !== null || !features.isLoaded || discoveryLoading} className="flex-1">
                {submitting ? 'Setting up…' : 'Continue to dashboard'}
              </Button>
              <Button type="button" variant="secondary" disabled={submitting || joiningOrgId !== null || !features.isLoaded || discoveryLoading} onClick={() => void finish(false)}>
                Skip for now
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
