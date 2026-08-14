import { useState, useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { UserPlus, CheckCircle, Check, ArrowLeft, Sparkles, Package, Cloud, Shield, BarChart3, LogIn } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useFeatures } from '@/hooks/useFeatures';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { Button } from '@/components/ui/Button';
import type { Plan } from '@/types';
import api from '@/lib/api';
import { siteUrlServerSideProps, DEFAULT_SITE_URL, type WithSiteUrl } from '@/lib/site-url';

// sessionStorage key carrying the OAuth "intent" across the provider redirect.
// Must match the login card (LandingPage) + the callback page
// (pages/auth/callback/[provider].tsx). Social sign-up reuses the 'login' intent:
// the OAuth callback auto-provisions the account on first authorization.
const OAUTH_INTENT_KEY = 'pb_oauth_intent';

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
  facebook: 'Facebook',
  microsoft: 'Microsoft',
  gitlab: 'GitLab',
  linkedin: 'LinkedIn',
};
const providerLabel = (p: string) => PROVIDER_LABELS[p] ?? (p.charAt(0).toUpperCase() + p.slice(1));

function formatPrice(cents: number): string {
  return cents === 0 ? 'Free' : `$${(cents / 100).toFixed(2)}/mo`;
}

/** A selectable tier card — surfaces the plan's description + top limits so a
 *  new user can actually tell the tiers apart (the old tiles showed only name +
 *  price). The first few `features` entries are the per-tier quota lines
 *  (seats / plugins / pipelines / API calls), which is what differentiates them. */
function PlanCard({ plan, selected, popular, disabled, onSelect }: {
  plan: Plan; selected: boolean; popular: boolean; disabled: boolean; onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={`relative flex flex-col rounded-xl border p-3 text-left transition-all ${
        selected
          ? 'border-[var(--pb-brand)] ring-2 ring-[color:var(--pb-brand)] bg-[color:color-mix(in_srgb,var(--pb-brand)_6%,transparent)]'
          : 'border-[var(--pb-border)] hover:border-[var(--pb-text-muted)]'
      }`}
    >
      {popular && (
        <span className="absolute -top-2 right-3 rounded-full bg-[var(--pb-brand)] text-white text-[10px] font-semibold px-2 py-0.5">
          Popular
        </span>
      )}
      <div className="flex items-center justify-between">
        <span className="font-bold text-sm">{plan.name}</span>
        {selected && <Check className="w-3.5 h-3.5 text-[var(--pb-brand)] shrink-0" />}
      </div>
      <div className="text-[var(--pb-brand)] font-bold text-sm mt-0.5">{formatPrice(plan.prices.monthly)}</div>
      <p className="text-xs text-[var(--pb-text-muted)] mt-1 leading-snug">{plan.description}</p>
      <ul className="mt-2 space-y-1">
        {plan.features.slice(0, 4).map((f) => (
          <li key={f} className="flex items-start gap-1.5 text-[11px] text-[var(--pb-text-muted)]">
            <Check className="w-3 h-3 mt-0.5 shrink-0 text-[var(--pb-success)]" strokeWidth={2.5} />
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}

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
      <div className="text-[11px] uppercase tracking-wide text-[var(--pb-text-muted)] mb-2">What you get</div>
      {billingOff && (
        <div className="mb-4 rounded-xl border border-[var(--pb-border)] bg-[color:color-mix(in_srgb,var(--pb-brand)_6%,transparent)] p-3">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="w-4 h-4 text-[var(--pb-brand)]" strokeWidth={2} /> Full platform, unlocked
          </div>
          <p className="text-xs text-[var(--pb-text-muted)] mt-1 leading-relaxed">
            Billing is off on this instance — every feature is enabled with no plan gating and no seat, pipeline, or usage caps.
          </p>
        </div>
      )}
      <ul className="space-y-3">
        {SOLUTION_POINTS.map((p) => (
          <li key={p.text} className="flex items-start gap-2.5">
            <p.icon className="w-4 h-4 mt-0.5 shrink-0 text-[var(--pb-brand)]" strokeWidth={1.75} />
            <span className="text-sm text-[var(--pb-text-muted)] leading-relaxed">{p.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function RegisterPage({ siteUrl = DEFAULT_SITE_URL }: Partial<WithSiteUrl>) {
  const OG_IMAGE = `${siteUrl}/og-image.png`;
  const router = useRouter();
  const { register, isLoading } = useAuth();
  const features = useFeatures();
  const billingEnabled = features.isEnabled('billing');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [selectedPlan, setSelectedPlan] = useState('developer');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState(false);
  // Enabled SSO/OAuth providers. Fail-soft: an empty list (none configured, or
  // the endpoint 404s) renders no extra UI — password sign-up is unchanged.
  const [providers, setProviders] = useState<string[]>([]);
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);

  const validateField = (field: string, value: string) => {
    let err = '';
    if (field === 'username' && value && value.length < 3) err = 'Min 3 characters';
    if (field === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) err = 'Invalid email';
    if (field === 'password' && value && value.length < 8) err = 'Min 8 characters';
    if (field === 'confirmPassword' && value && password && value !== password) err = 'Passwords do not match';
    setFieldErrors(prev => ({ ...prev, [field]: err }));
  };

  useEffect(() => {
    if (!billingEnabled) return;
    api.getPlans().then((res) => {
      if (res.success && res.data?.plans) setPlans(res.data.plans);
    }).catch(() => {});
  }, [billingEnabled]);

  useEffect(() => {
    let cancelled = false;
    api.listOAuthProviders()
      .then((res) => { if (!cancelled) setProviders(res.data?.providers ?? []); })
      .catch(() => { if (!cancelled) setProviders([]); });
    return () => { cancelled = true; };
  }, []);

  // Start the OAuth dance: fetch the provider authorize URL (backend mints the
  // CSRF state), stash a "login" intent under that state so the callback page
  // can complete it (first login auto-provisions the account), then hand the
  // browser to the provider.
  const startOAuth = async (provider: string) => {
    setError(null);
    setOauthBusy(provider);
    try {
      const res = await api.getOAuthUrl(provider);
      const url = res.data?.url;
      const state = res.data?.state;
      if (!url || !state) throw new Error('Could not start sign-up with this provider');
      try {
        sessionStorage.setItem(OAUTH_INTENT_KEY, JSON.stringify({ state, kind: 'login', returnUrl: '/dashboard' }));
      } catch { /* storage unavailable — backend still validates state */ }
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not sign up with ${providerLabel(provider)}`);
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
      // `register` now establishes the session (authenticates immediately after
      // create) and `useAuth.login` routes to /dashboard. Show the confirmation
      // and land the new user in the dashboard — NOT back on the login screen.
      await register(username, email, password, organizationName || undefined, billingEnabled ? selectedPlan : undefined);
      setSuccess(true);
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    }
  };

  const hasPlans = plans.length > 0;

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="card p-8 max-w-xs text-center" role="status" aria-live="polite">
          <CheckCircle className="w-10 h-10 text-[var(--pb-success)] mx-auto mb-3" />
          <p className="font-bold">Account created!</p>
          <p className="text-sm text-[var(--pb-text-muted)] mt-1">Redirecting...</p>
        </motion.div>
      </div>
    );
  }

  return (
    <>
      <Head>
        <title>Create Account - Pipeline Builder</title>
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
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-[var(--pb-text-muted)] hover:text-[var(--pb-text)] transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </Link>
        </div>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-4xl mx-auto">
          <h1 className="text-xl font-bold text-center mb-1">Create account</h1>
          <p className="text-sm text-[var(--pb-text-muted)] text-center mb-6">
            Have an account? <Link href="/" className="text-[var(--pb-brand)] hover:underline">Sign in</Link>
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
            {/* Sign-up form */}
            <Card className="p-5 lg:col-span-2">
              <form onSubmit={handleSubmit} className="space-y-3">
                <ErrorAlert message={error} className="text-sm" />

                <div>
                  <Input id="reg-username" type="text" autoComplete="username" required className={fieldErrors.username ? 'input-error' : ''} placeholder="Username" aria-label="Username" value={username} onChange={(e) => setUsername(e.target.value)} onBlur={() => validateField('username', username)} disabled={isLoading} />
                  {fieldErrors.username && <p className="form-error mt-1">{fieldErrors.username}</p>}
                </div>
                <div>
                  <Input id="reg-email" type="email" autoComplete="email" required className={fieldErrors.email ? 'input-error' : ''} placeholder="Email" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => validateField('email', email)} disabled={isLoading} />
                  {fieldErrors.email && <p className="form-error mt-1">{fieldErrors.email}</p>}
                </div>
                <Input id="reg-org" type="text" placeholder="Organization (optional)" aria-label="Organization name" value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} disabled={isLoading} />
                <div>
                  <Input id="reg-password" type="password" autoComplete="new-password" required className={fieldErrors.password ? 'input-error' : ''} placeholder="Password (min 8 chars)" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} onBlur={() => validateField('password', password)} disabled={isLoading} />
                  {fieldErrors.password && <p className="form-error mt-1">{fieldErrors.password}</p>}
                </div>
                <div>
                  <Input id="reg-confirm" type="password" autoComplete="new-password" required className={fieldErrors.confirmPassword ? 'input-error' : ''} placeholder="Confirm password" aria-label="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} onBlur={() => validateField('confirmPassword', confirmPassword)} disabled={isLoading} />
                  {fieldErrors.confirmPassword && <p className="form-error mt-1">{fieldErrors.confirmPassword}</p>}
                </div>

                {hasPlans && (
                  <p className="text-xs text-[var(--pb-text-muted)] pt-1">
                    Selected plan: <span className="font-semibold text-[var(--pb-text)]">{plans.find((p) => p.id === selectedPlan)?.name ?? 'Developer'}</span>. Change it anytime — start free, no card required.
                  </p>
                )}

                <Button type="submit" disabled={isLoading} fullWidth className="text-sm mt-1">
                  {isLoading
                    ? <><LoadingSpinner size="sm" className="mr-2" /> Creating...</>
                    : <><UserPlus className="w-4 h-4 mr-1.5" /> Create account</>
                  }
                </Button>
              </form>

              {providers.length > 0 && (
                <div className="mt-4">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="flex-1 h-px bg-[var(--pb-border)]" />
                    <span className="text-[11px] uppercase tracking-wide text-[var(--pb-text-muted)]">or</span>
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
                        disabled={isLoading || oauthBusy !== null}
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
                otherwise a solution/value panel so signup isn't a bare form. */}
            <div className="lg:col-span-3">
              {hasPlans ? (
                <>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--pb-text-muted)] mb-2">Choose your plan</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {plans.map((plan) => (
                      <PlanCard
                        key={plan.id}
                        plan={plan}
                        selected={selectedPlan === plan.id}
                        popular={plan.tier === 'pro'}
                        disabled={isLoading}
                        onSelect={() => setSelectedPlan(plan.id)}
                      />
                    ))}
                  </div>

                  <div className="mt-3 rounded-xl border border-[var(--pb-border)] bg-[var(--pb-surface-muted)] p-3">
                    <div className="flex items-center gap-1.5 text-sm font-semibold mb-1">
                      <Sparkles className="w-4 h-4 text-[var(--pb-brand)]" strokeWidth={2} /> Scale any plan with add-on packs
                    </div>
                    <p className="text-xs text-[var(--pb-text-muted)] leading-relaxed">
                      Stackable bundles raise your limits without switching tiers — Seat&nbsp;(+5), Pipeline&nbsp;(+10),
                      Plugin&nbsp;(+100), API&nbsp;(+1M), AI&nbsp;(+5k) &amp; Storage&nbsp;(+50&nbsp;GB) packs — plus SSO, Audit&nbsp;Log,
                      DORA reporting, and Team&nbsp;Usage&nbsp;Analytics. Add them anytime from Billing.
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
