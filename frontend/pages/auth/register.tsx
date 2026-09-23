import { useState, useEffect } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { UserPlus, CheckCircle, Check, ArrowLeft, Sparkles, Package, Cloud, Shield, BarChart3, LogIn } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useFeatures } from '@/hooks/useFeatures';
import { useFetch } from '@/hooks/useFetch';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { Button } from '@/components/ui/Button';
import api from '@/lib/api';
import { DEFAULT_PLAN_ID } from '@/components/billing/helpers';
import { SelectablePlanCard } from '@/components/billing/SelectablePlanCard';
import { usePlans } from '@/hooks/usePlans';
import { readMarketplaceRef } from '@/hooks/usePendingMarketplaceClaim';
import { siteUrlServerSideProps, DEFAULT_SITE_URL, type WithSiteUrl } from '@/lib/site-url';
import { startOAuthLogin } from '@/lib/oauth-intent';
import { formatError, providerLabel } from '@/lib/constants';

// sessionStorage key carrying the OAuth "intent" across the provider redirect.
// Must match the login card (LandingPage) + the callback page
// (pages/auth/callback/[provider].tsx). Social sign-up reuses the 'login' intent:
// the OAuth callback auto-provisions the account on first authorization.


/** Value/solution panel shown next to the form when there are no plans to pick —
 *  i.e. billing is off (the org gets the `unlimited` default: every feature, no
 *  caps) or the plan catalog didn't load. Keeps the signup from being a bare,
 *  context-free form by restating what the product actually does. */
const SOLUTION_POINTS: { icon: typeof Sparkles; text: string }[] = [
  { icon: Sparkles, text: 'AI turns a Git URL or a prompt into a working pipeline — Anthropic, OpenAI, Google, xAI, or Bedrock.' },
  { icon: Package, text: '119 plugins across 10 categories — build, test, security scans, and deploys.' },
  { icon: Cloud, text: 'Deploys as native AWS CodePipeline in your own account — zero lock-in.' },
  { icon: Shield, text: 'Per-org compliance, role-based access, and a tamper-evident audit trail on every build.' },
  { icon: BarChart3, text: 'Execution and team analytics, plus DORA delivery metrics.' },
  { icon: Check, text: 'Build your way — Dashboard, AI prompt, CLI, REST API, or CDK.' },
];

function SolutionPanel({ billingOff }: { billingOff: boolean }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wide text-fg-muted mb-2">What you get</div>
      {billingOff && (
        <div className="mb-4 rounded-xl border border-default bg-[color:color-mix(in_srgb,var(--pb-brand)_6%,transparent)] p-3">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="w-4 h-4 text-brand" strokeWidth={2} /> Full platform, unlocked
          </div>
          <p className="text-xs text-fg-muted mt-1 leading-relaxed">
            Billing is off on this instance — every feature is enabled with no plan gating and no seat, pipeline, or usage caps.
          </p>
        </div>
      )}
      <ul className="space-y-3">
        {SOLUTION_POINTS.map((p) => (
          <li key={p.text} className="flex items-start gap-2.5">
            <p.icon className="w-4 h-4 mt-0.5 shrink-0 text-brand" strokeWidth={1.75} />
            <span className="text-sm text-fg-muted leading-relaxed">{p.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function RegisterPage({ siteUrl = DEFAULT_SITE_URL }: Partial<WithSiteUrl>) {
  const OG_IMAGE = `${siteUrl}/og-image.png`;
  const { register, isSubmitting } = useAuth();
  const features = useFeatures();
  const billingEnabled = features.isEnabled('billing');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [selectedPlan, setSelectedPlan] = useState(DEFAULT_PLAN_ID);
  const { plans } = usePlans(billingEnabled);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState(false);
  // Enabled SSO/OAuth providers. Fail-soft: an empty list (none configured, or
  // the endpoint 404s) renders no extra UI — password sign-up is unchanged.
  // If the visitor arrived from an AWS Marketplace purchase (a resolved ref is
  // stashed), show the plan they already bought — it's linked automatically after
  // sign-up, so they don't re-pick it here.
  const [marketplacePlan, setMarketplacePlan] = useState<string | null | undefined>(undefined);
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);

  const validateField = (field: string, value: string) => {
    let err = '';
    if (field === 'username' && value && value.length < 3) err = 'Min 3 characters';
    if (field === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) err = 'Invalid email';
    if (field === 'password' && value && value.length < 8) err = 'Min 8 characters';
    if (field === 'confirmPassword' && value && password && value !== password) err = 'Passwords do not match';
    setFieldErrors(prev => ({ ...prev, [field]: err }));
  };

  // Fail-soft: no answer means no social buttons, never a broken form.
  const oauthProviders = useFetch<string[]>(
    async (signal) => (await api.listOAuthProviders({ signal })).data?.providers ?? [],
    [],
  );
  const providers = oauthProviders.data ?? [];

  // Detect an in-flight AWS Marketplace registration (client-only; the ref is in
  // sessionStorage/cookie set by the fulfillment page).
  useEffect(() => { setMarketplacePlan(readMarketplaceRef()?.planName ?? null); }, []);

  // Start the OAuth dance: fetch the provider authorize URL (backend mints the
  // CSRF state), stash a "login" intent under that state so the callback page
  // can complete it (first login auto-provisions the account), then hand the
  // browser to the provider.
  const startOAuth = async (provider: string) => {
    setError(null);
    setOauthBusy(provider);
    try {
      await startOAuthLogin(provider);
    } catch (err) {
      setError(formatError(err, `Could not sign up with ${providerLabel(provider)}`));
      setOauthBusy(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!username || !email || !password) { setError('Fill in all required fields'); return; }
    if (username.length < 3) { setError('Username must be at least 3 characters'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Enter a valid email'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }

    try {
      // `register` establishes the session and NAVIGATES — `login` routes to the
      // saved return path, or to passkey enrolment for a session that must
      // enrol first. This page must not navigate on top of it: a second
      // `router.push('/dashboard')` here won, so a visitor who signed up from a
      // guarded deep link (e.g. a CLI device approval) lost it — `takeReturnPath`
      // had already consumed it — and an enrolment redirect was overridden too.
      await register(username, email, password, organizationName || undefined, billingEnabled ? selectedPlan : undefined);
      setSuccess(true);
    } catch (err) {
      setError(formatError(err, 'Registration failed'));
    }
  };

  const hasPlans = plans.length > 0;
  // Marketplace purchasers don't choose a plan here — AWS already sold them one,
  // and it's linked automatically after sign-up.
  const isMarketplace = typeof marketplacePlan === 'string';

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <Card as={motion.div} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="p-8 max-w-xs text-center" role="status" aria-live="polite">
          <CheckCircle className="w-10 h-10 text-success mx-auto mb-3" />
          <p className="font-bold">Account created!</p>
          <p className="text-sm text-fg-muted mt-1">Redirecting...</p>
        </Card>
      </div>
    );
  }

  return (
    <>
      <Head>
        <title>Create account - Pipeline Builder</title>
        <meta name="description" content="Create your Pipeline Builder account — self-service, production-ready AWS CI/CD from TypeScript, CLI, CDK, or a single AI prompt. Native AWS CodePipeline, no lock-in." />
        <meta property="og:title" content="Create your Pipeline Builder account" />
        <meta property="og:description" content="Self-service CI/CD for AWS — 119 plugins, AI generation, per-org compliance. Deploys as native AWS CodePipeline in your account." />
        <meta property="og:type" content="website" />
        <meta property="og:image" content={OG_IMAGE} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:alt" content="Pipeline Builder — Self-Service CI/CD for AWS" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:image" content={OG_IMAGE} />
      </Head>
      <div className="min-h-screen px-6 py-10">
        <div className="max-w-4xl mx-auto mb-6">
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </Link>
        </div>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-4xl mx-auto">
          <h1 className="text-xl font-bold text-center mb-1">Create account</h1>
          <p className="text-sm text-fg-muted text-center mb-6">
            Have an account? <Link href="/" className="text-brand hover:underline">Sign in</Link>
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
            {/* Sign-up form */}
            <Card className="p-5 lg:col-span-2">
              {isMarketplace && (
                <div className="mb-4 rounded-lg border border-default bg-[color:color-mix(in_srgb,var(--pb-brand)_6%,transparent)] p-3 text-sm">
                  <span className="font-semibold">AWS Marketplace</span>
                  <p className="text-fg-muted mt-1 leading-relaxed">
                    Create your account to finish linking your{marketplacePlan ? <> <span className="font-medium text-fg">{marketplacePlan}</span></> : ''} subscription — billing is handled by AWS, so there&apos;s no plan to choose here.
                  </p>
                </div>
              )}
              <form onSubmit={handleSubmit} className="space-y-3">
                <ErrorAlert message={error} className="text-sm" />

                <div>
                  <Input id="reg-username" type="text" autoComplete="username" required className={fieldErrors.username ? 'input-error' : ''} placeholder="Username" aria-label="Username" value={username} onChange={(e) => setUsername(e.target.value)} onBlur={() => validateField('username', username)} disabled={isSubmitting} />
                  {fieldErrors.username && <p className="form-error mt-1">{fieldErrors.username}</p>}
                </div>
                <div>
                  <Input id="reg-email" type="email" autoComplete="email" required className={fieldErrors.email ? 'input-error' : ''} placeholder="Email" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => validateField('email', email)} disabled={isSubmitting} />
                  {fieldErrors.email && <p className="form-error mt-1">{fieldErrors.email}</p>}
                </div>
                <Input id="reg-org" type="text" placeholder="Organization (optional)" aria-label="Organization name" value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} disabled={isSubmitting} />
                <div>
                  <Input id="reg-password" type="password" autoComplete="new-password" required className={fieldErrors.password ? 'input-error' : ''} placeholder="Password (min 8 chars)" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} onBlur={() => validateField('password', password)} disabled={isSubmitting} />
                  {fieldErrors.password && <p className="form-error mt-1">{fieldErrors.password}</p>}
                </div>
                <div>
                  <Input id="reg-confirm" type="password" autoComplete="new-password" required className={fieldErrors.confirmPassword ? 'input-error' : ''} placeholder="Confirm password" aria-label="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} onBlur={() => validateField('confirmPassword', confirmPassword)} disabled={isSubmitting} />
                  {fieldErrors.confirmPassword && <p className="form-error mt-1">{fieldErrors.confirmPassword}</p>}
                </div>

                {hasPlans && !isMarketplace && (
                  <p className="text-xs text-fg-muted pt-1">
                    Selected plan: <span className="font-semibold text-fg">{plans.find((p) => p.id === selectedPlan)?.name ?? 'Developer'}</span>. Change it anytime — start free, no card required.
                  </p>
                )}

                <Button type="submit" disabled={isSubmitting} fullWidth className="text-sm mt-1">
                  {isSubmitting
                    ? <><LoadingSpinner size="sm" className="mr-2" /> Creating...</>
                    : <><UserPlus className="w-4 h-4 mr-1.5" /> Create account</>
                  }
                </Button>
              </form>

              {providers.length > 0 && (
                <div className="mt-4">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="flex-1 h-px bg-[var(--pb-border)]" />
                    <span className="text-2xs uppercase tracking-wide text-fg-muted">or</span>
                    <span className="flex-1 h-px bg-[var(--pb-border)]" />
                  </div>
                  <div className="space-y-2">
                    {providers.map((p) => (
                      <Button
                        key={p}
                        type="button"
                        variant="secondary"
                        fullWidth
                        onClick={() => startOAuth(p)}
                        disabled={isSubmitting || oauthBusy !== null}
                        className="text-sm"
                      >
                        {oauthBusy === p
                          ? <><LoadingSpinner size="sm" className="mr-2" /> Redirecting…</>
                          : <><LogIn className="w-4 h-4 mr-1.5" /> Sign up with {providerLabel(p)}</>}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            {/* Right column: tier comparison + bundles when billing is on,
                otherwise a solution/value panel so signup isn't a bare form.
                Marketplace purchasers get the value panel (no plan to choose). */}
            <div className="lg:col-span-3">
              {hasPlans && !isMarketplace ? (
                <>
                  <div className="text-2xs uppercase tracking-wide text-fg-muted mb-2">Choose your plan</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {plans.map((plan) => (
                      <SelectablePlanCard
                        key={plan.id}
                        plan={plan}
                        selected={selectedPlan === plan.id}
                        popular={plan.tier === 'pro'}
                        disabled={isSubmitting}
                        onSelect={() => setSelectedPlan(plan.id)}
                      />
                    ))}
                  </div>

                  <div className="mt-3 rounded-xl border border-default bg-surface-muted p-3">
                    <div className="flex items-center gap-1.5 text-sm font-semibold mb-1">
                      <Sparkles className="w-4 h-4 text-brand" strokeWidth={2} /> Scale any plan with add-on packs
                    </div>
                    <p className="text-xs text-fg-muted leading-relaxed">
                      Stackable bundles raise your limits without switching tiers — per-Seat (with volume discounts),
                      Pipeline&nbsp;(+5), Plugin&nbsp;(+25), API&nbsp;(+100k), AI&nbsp;(+2.5k) &amp; Storage&nbsp;(+10&nbsp;GB) packs
                      — plus the Scale&nbsp;Bundle, SSO, Audit&nbsp;Log, DORA reporting, and Team&nbsp;Usage&nbsp;Analytics.
                      Add them anytime from Billing.
                    </p>
                  </div>
                </>
              ) : (
                <SolutionPanel billingOff={!billingEnabled} />
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </>
  );
}

export const getServerSideProps = siteUrlServerSideProps;
