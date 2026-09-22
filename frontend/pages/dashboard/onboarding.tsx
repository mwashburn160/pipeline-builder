import { useState, useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { Sparkles } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useAuth } from '@/hooks/useAuth';
import { useFeatures } from '@/hooks/useFeatures';
import { useFetch } from '@/hooks/useFetch';
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
import { OrgSetupStep } from '@/components/onboarding/OrgSetupStep';
import { usePlans } from '@/hooks/usePlans';

/** An org the signed-in user's verified email domain could join, annotated with
 *  where this user already stands with it (see `GET /auth/onboarding/domain-orgs`). */
type DomainOrg = {
  orgId: string;
  orgName: string;
  autoJoin: 'off' | 'request' | 'auto';
  requestStatus?: 'pending' | 'approved' | 'denied';
  isMember?: boolean;
};

/** How long the submit buttons may wait on domain discovery before giving up. */
const DISCOVERY_TIMEOUT_MS = 6000;

/**
 * First-run onboarding AND the permanent "join an organization" surface.
 *
 * Two modes, keyed on the profile's `needsOnboarding` flag:
 *
 *   - FIRST RUN (`needsOnboarding`) — the social-signup path: name the
 *     auto-created org, pick a plan, or join a team your email domain matches.
 *     `useAuthGuard({ allowOnboarding: true })` opts the page out of the guard's
 *     own onboarding redirect so it doesn't loop.
 *   - JOIN (already onboarded) — the same domain discovery + join/request flow,
 *     re-enterable for good.
 *
 * The second mode exists because the first used to be the ONLY one: the flag is
 * cleared permanently by both "Continue" and "Skip for now", and this page is
 * in no nav or palette, so the entire domain-discovery + join-request feature
 * became unreachable the instant a user finished (or skipped) onboarding —
 * while the admin half of it, the approval queue in `DomainJoinSettings`, stayed
 * live. Worse, a user whose request came back `status: 'requested'` had nowhere
 * to see what became of it. Landing here already onboarded now shows that state
 * instead of bouncing to the dashboard.
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
  // Two-phase: after CREATING an org (Continue), show the CLI/setup step before
  // heading to the dashboard. Skip / domain-join go straight to the dashboard.
  const [phase, setPhase] = useState<'setup' | 'install'>('setup');

  // Domain-based discovery (P2b): orgs the user's verified email domain can join.
  const [joiningOrgId, setJoiningOrgId] = useState<string | null>(null);
  const [requestedOrgIds, setRequestedOrgIds] = useState<Set<string>>(new Set());

  // Seed the input with the auto-derived org name so the user edits rather than
  // types from scratch.
  useEffect(() => {
    if (user?.organizationName) setOrgName((prev) => prev || user.organizationName || '');
  }, [user?.organizationName]);

  // Already onboarded ⇒ the durable JOIN view rather than a redirect (see the
  // component docblock): this is the only surface the domain-join flow has.
  const joinOnly = isReady && !!user && !user.needsOnboarding;

  // Discover orgs the user could join by their verified email domain. Fail-soft
  // and optional: an error just means no suggestions.
  const discovery = useFetch<DomainOrg[]>(
    async (signal) => (await api.getDomainOrgs({ signal })).data?.orgs ?? [],
    [],
  );
  const domainOrgs = discovery.data ?? [];
  // Safety fallback: the client has no fetch timeout, so a hung request must
  // not leave the submit buttons disabled forever.
  const [discoveryTimedOut, setDiscoveryTimedOut] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDiscoveryTimedOut(true), DISCOVERY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []);
  const discoveryLoading = discovery.loading && !discoveryTimedOut;

  const goToDashboard = async () => {
    // Refresh first (syncs the new org name), THEN re-apply the optimistic clear —
    // so a stale read-replica returning needsOnboarding:true can't overwrite it and
    // bounce the user back to onboarding via the guard. A refresh failure must NOT
    // strand the user (the install-step "Continue" calls this fire-and-forget), so
    // swallow it and navigate regardless — markOnboardingComplete already cleared
    // the flag locally.
    try {
      await refreshUser();
    } catch {
      /* transient — proceed to the dashboard anyway */
    }
    markOnboardingComplete();
    void router.replace('/dashboard');
  };

  const handleJoin = async (org: { orgId: string }) => {
    setJoiningOrgId(org.orgId);
    setError(null);
    try {
      const res = await api.joinDomainOrg(org.orgId);
      if (res.data?.status === 'requested') {
        setRequestedOrgIds((prev) => new Set(prev).add(org.orgId));
        // Re-read so the row switches to its server-side state (and stays that
        // way on a later visit) rather than relying only on local memory.
        discovery.refetch();
        setJoiningOrgId(null);
        return; // async approval — the user can still set up their own org below
      }
      if (res.data?.status === 'denied') {
        setError(joinOnly
          ? 'A previous request to join this organization was declined. Ask one of its admins to invite you directly.'
          : 'A previous request to join this organization was declined. Contact an admin, or set up your own organization below.');
        discovery.refetch();
        setJoiningOrgId(null);
        return;
      }
      // Joined (or already a member). A first-run user still owes the backend a
      // completeOnboarding to clear the flag; an already-onboarded one doesn't.
      if (!joinOnly) await api.completeOnboarding({});
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
      if (withName) {
        // Created + named an org (the "Continue" path) → show the final install /
        // setup step before the dashboard. completeOnboarding already cleared
        // needsOnboarding, and this page is guard-exempt, so no bounce.
        setPhase('install');
        setSubmitting(false);
        return;
      }
      // "Skip for now" → opting out of setup; head straight to the dashboard.
      await goToDashboard();
    } catch (e) {
      setError(formatError(e));
      setSubmitting(false);
    }
  };

  /**
   * One discoverable org, in whichever of its four states applies. A row is only
   * actionable when there is something left to do — an org already joined, or
   * one whose request is pending or was refused, shows its state instead of a
   * button that would just re-post the same request (the backend treats a
   * denial as sticky and refuses to re-open it).
   */
  const orgRow = (org: DomainOrg) => {
    const pending = org.requestStatus === 'pending' || requestedOrgIds.has(org.orgId);
    return (
      <div key={org.orgId} className="flex items-center justify-between gap-3 rounded-md border border-default p-2.5">
        <span className="font-medium text-sm truncate">{org.orgName}</span>
        {org.isMember ? (
          <span className="text-xs text-fg-muted shrink-0 text-right" data-testid={`org-state-${org.orgId}`}>You&apos;re a member</span>
        ) : pending ? (
          <span className="text-xs text-success shrink-0 text-right" data-testid={`org-state-${org.orgId}`}>
            Request sent ✓<br /><span className="text-fg-muted">An admin will review it.</span>
          </span>
        ) : org.requestStatus === 'denied' ? (
          <span className="text-xs text-danger shrink-0 text-right" data-testid={`org-state-${org.orgId}`}>
            Request declined<br /><span className="text-fg-muted">Ask an admin to invite you.</span>
          </span>
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
    );
  };

  if (!isReady || !user) return <LoadingPage />;

  // -- JOIN mode: the durable surface for an already-onboarded user -----------
  if (joinOnly) {
    return (
      <>
        <Head><title>Join an organization</title></Head>
        <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-canvas">
          <Card className="w-full max-w-lg p-6">
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="w-5 h-5 text-brand" />
              <h1 className="text-xl font-bold">Join an organization</h1>
            </div>
            <p className="text-sm text-fg-muted mb-5">
              You&apos;re signed in to <span className="font-medium text-fg">{user.organizationName || 'your organization'}</span>.
              Organizations that have verified your email domain are listed here — along with any request you&apos;ve already sent.
            </p>

            {error && <div className="mb-4"><ErrorAlert message={error} /></div>}

            {/* The 6s `discoveryTimedOut` fallback exists to un-stick the
                first-run submit buttons; this view has none, so it waits on the
                real loading flag rather than claiming "nothing matches" while
                the answer is still in flight. */}
            {discovery.loading ? (
              <p className="text-sm text-fg-muted">Looking for organizations that match your email domain…</p>
            ) : domainOrgs.length > 0 ? (
              <div className="space-y-2">{domainOrgs.map(orgRow)}</div>
            ) : (
              <div className="rounded-lg border border-default bg-surface-muted p-3 text-xs text-fg-muted space-y-2">
                <p className="font-medium text-sm text-fg">No organizations match your email address.</p>
                <p>
                  Joining this way needs two things: your own email address verified, and an administrator of the
                  organization having verified your email domain and opened it to joining.
                </p>
                <p>If neither applies, ask an administrator there to send you an invitation instead.</p>
              </div>
            )}

            <div className="mt-6">
              <Button type="button" variant="secondary" onClick={() => void router.push('/dashboard')}>
                Back to dashboard
              </Button>
            </div>
          </Card>
        </div>
      </>
    );
  }

  if (phase === 'install') {
    const planTier = plans.find((p) => p.id === selectedPlan)?.tier;
    return (
      <>
        <Head><title>Welcome — Install the CLI</title></Head>
        <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-canvas">
          <Card className="w-full max-w-lg p-6">
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="w-5 h-5 text-brand" />
              <h1 className="text-xl font-bold">You&apos;re all set</h1>
            </div>
            <p className="text-sm text-fg-muted mb-5">
              Your organization is ready. Install the CLI to start building pipelines.
            </p>
            <OrgSetupStep planTier={planTier} onDone={() => void goToDashboard()} />
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <Head><title>Welcome — Set up your organization</title></Head>
      <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-canvas">
        <Card className="w-full max-w-lg p-6">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-5 h-5 text-brand" />
            <h1 className="text-xl font-bold">Welcome to Pipeline Builder</h1>
          </div>
          <p className="text-sm text-fg-muted mb-5">
            You signed up with a social account, so we created an organization for you.
            Give it a name{billingEnabled ? ' and pick a plan' : ''} to finish setting up.
          </p>

          {domainOrgs.length > 0 && (
            <div className="mb-5 rounded-lg border border-default bg-surface-muted p-3">
              <div className="text-sm font-semibold mb-1">Join your team</div>
              <p className="text-xs text-fg-muted mb-3">
                Your email domain matches {domainOrgs.length === 1 ? 'an organization' : 'organizations'} already on Pipeline Builder.
              </p>
              <div className="space-y-2">{domainOrgs.map(orgRow)}</div>
              <div className="text-2xs uppercase tracking-wide text-fg-muted mt-4">or set up your own</div>
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
                <p className="text-xs text-fg-muted mt-1">Start free — change or upgrade anytime in Billing.</p>
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
            {/* Skipping clears the first-run flag for good, so say where the
                join flow lives afterwards — it used to simply vanish. */}
            <p className="text-xs text-fg-subtle mt-3">
              Skipping is not final: you can come back to this page any time from Help → Join an organization.
            </p>
          </form>
        </Card>
      </div>
    </>
  );
}
