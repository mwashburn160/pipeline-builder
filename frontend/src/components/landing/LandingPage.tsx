import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { motion } from 'framer-motion';
import {
  Shield, BarChart3, Cloud,
  Bot, Globe, Zap, ArrowRight, Check, LogIn, Sparkles,
  Menu, X, Moon, Sun, Eye, EyeOff,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useDarkMode } from '@/hooks/useDarkMode';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import api from '@/lib/api';

// sessionStorage key carrying the OAuth "intent" across the provider redirect.
// Must match the callback page (pages/auth/callback/[provider].tsx).
const OAUTH_INTENT_KEY = 'pb_oauth_intent';

const PROVIDER_LABELS: Record<string, string> = { google: 'Google', github: 'GitHub' };
const providerLabel = (p: string) => PROVIDER_LABELS[p] ?? (p.charAt(0).toUpperCase() + p.slice(1));

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.05, duration: 0.35, ease: 'easeOut' as const },
  }),
};

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

function NavBar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { isDark, toggle: toggleDark } = useDarkMode();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 32);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
      scrolled || mobileOpen
        ? 'bg-[var(--pb-surface)]/90 backdrop-blur-lg border-b border-[var(--pb-border)] shadow-sm'
        : 'bg-transparent'
    }`}>
      <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <a href="#top" className="font-serif text-lg font-bold text-[var(--pb-text)]" aria-label="Pipeline Builder home">
          Pipeline Builder
        </a>
        <div className="flex items-center gap-2">
          <button onClick={toggleDark} className="p-2 text-[var(--pb-text-muted)] hover:text-[var(--pb-text)] transition-colors" aria-label="Toggle dark mode">
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <Link href="/auth/register" className="hidden sm:inline-flex btn btn-primary text-sm px-4 py-1.5">
            Get Started
          </Link>
          <button onClick={() => setMobileOpen(!mobileOpen)} className="sm:hidden p-2 text-[var(--pb-text-muted)]" aria-label="Menu">
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>
      {/* Mobile menu */}
      {mobileOpen && (
        <div className="sm:hidden border-t border-[var(--pb-border)] bg-[var(--pb-surface)] px-6 py-4 space-y-3">
          <a href="#signin" onClick={() => setMobileOpen(false)} className="block text-sm text-[var(--pb-text-muted)]">Sign in</a>
          <Link href="/auth/register" onClick={() => setMobileOpen(false)} className="block btn btn-primary text-sm text-center">Get Started</Link>
        </div>
      )}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Hero — headline left, sign-in right
// ---------------------------------------------------------------------------

function Hero() {
  const { login, isLoading } = useAuth();
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enabled SSO/OAuth providers. Fail-soft: an empty list (none configured, or
  // the endpoint 404s) renders no extra UI — password login is unchanged.
  const [providers, setProviders] = useState<string[]>([]);
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);
  const sessionExpired = router.query.expired === '1';

  useEffect(() => {
    let cancelled = false;
    api.listOAuthProviders()
      .then((res) => { if (!cancelled) setProviders(res.data?.providers ?? []); })
      .catch(() => { if (!cancelled) setProviders([]); });
    return () => { cancelled = true; };
  }, []);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!identifier || !password) { setError('Enter your email and password'); return; }
    try { await login(identifier, password); }
    catch (err) { setError(err instanceof Error ? err.message : 'Sign in failed'); }
  };

  // Start the OAuth dance: fetch the provider authorize URL (backend mints the
  // CSRF state), stash a "login" intent under that state so the callback page
  // can complete it, then hand the browser to the provider.
  const startOAuth = async (provider: string) => {
    setError(null);
    setOauthBusy(provider);
    try {
      const res = await api.getOAuthUrl(provider);
      const url = res.data?.url;
      const state = res.data?.state;
      if (!url || !state) throw new Error('Could not start sign-in with this provider');
      try {
        sessionStorage.setItem(OAUTH_INTENT_KEY, JSON.stringify({ state, kind: 'login', returnUrl: '/dashboard' }));
      } catch { /* storage unavailable — backend still validates state */ }
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not sign in with ${providerLabel(provider)}`);
      setOauthBusy(null);
    }
  };

  return (
    <section id="top" className="pt-24 pb-12 px-6">
      <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-5 gap-10 items-start">
        {/* Left — 3 cols */}
        <div className="lg:col-span-3 pt-2">
          <motion.div
            className="inline-flex items-center gap-1.5 mb-4 px-3 py-1 rounded-full text-xs font-medium bg-[var(--pb-surface)] border border-[var(--pb-border)] text-[var(--pb-text-muted)]"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <Sparkles className="w-3.5 h-3.5 text-[var(--pb-brand)]" strokeWidth={2} />
            Self-service CI/CD for AWS
          </motion.div>
          <motion.h1
            className="text-4xl sm:text-5xl font-bold leading-[1.1] mb-4"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.05 }}
          >
            CI/CD pipelines from code or{' '}
            <span className="text-[var(--pb-brand)]">AI</span>
          </motion.h1>
          <motion.p
            className="text-[var(--pb-text-muted)] text-base mb-6 leading-relaxed max-w-xl"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
          >
            Turn a Git URL or a prompt into a working pipeline — deployed as native
            AWS CodePipeline in your own account. 119 plugins, per-org compliance,
            zero lock-in.
          </motion.p>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, delay: 0.18 }}
          >
            <div className="text-[11px] uppercase tracking-wide text-[var(--pb-text-muted)] mb-2">Build it your way</div>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-[var(--pb-text-muted)] mb-6">
              {['Dashboard', 'AI Prompt', 'CLI', 'REST API', 'CDK'].map((t) => (
                <span key={t} className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-[var(--pb-success)]" strokeWidth={2} />
                  {t}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/auth/register" className="btn btn-primary px-5 py-2.5 text-sm">
                Get started free <ArrowRight className="w-3.5 h-3.5 ml-1.5 inline" />
              </Link>
              <a href="#how" className="btn btn-secondary px-5 py-2.5 text-sm">See how it works</a>
            </div>
            <p className="text-xs text-[var(--pb-text-muted)] mt-4">
              Apache-2.0 · Runs in your AWS account · No credit card required
            </p>
          </motion.div>
        </div>

        {/* Right — 2 cols, sign-in card */}
        <motion.div
          id="signin"
          className="lg:col-span-2"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
        >
          <Card className="p-5">
            <h2 className="font-bold mb-4">Sign in</h2>

            {sessionExpired && !error && (
              <div className="alert-warning mb-3" role="status" aria-live="polite">
                <p>Session expired. Please sign in again.</p>
              </div>
            )}
            <ErrorAlert message={error} className="mb-3" />

            <form onSubmit={handleSignIn} className="space-y-3">
              <Input
                id="signin-identifier"
                type="text"
                autoComplete="username"
                required
                placeholder="Email or username"
                aria-label="Email or username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                disabled={isLoading}
              />
              <div className="relative">
                <Input
                  id="signin-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  className="pr-10"
                  placeholder="Password"
                  aria-label="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isLoading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  disabled={isLoading}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-[var(--pb-text-muted)] hover:text-[var(--pb-text)] focus:outline-none focus:ring-2 focus:ring-[color:var(--pb-brand)]"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
                </button>
              </div>
              <Button type="submit" fullWidth disabled={isLoading} className="text-sm">
                {isLoading
                  ? <><LoadingSpinner size="sm" className="mr-2" /> Signing in...</>
                  : <><LogIn className="w-4 h-4 mr-1.5" /> Sign in</>
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
                        : <><LogIn className="w-4 h-4 mr-1.5" /> Sign in with {providerLabel(p)}</>}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <p className="text-xs text-[var(--pb-text-muted)] mt-4 text-center">
              New here?{' '}
              <Link href="/auth/register" className="text-[var(--pb-brand)] hover:underline">
                Create account
              </Link>
            </p>
          </Card>
        </motion.div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Strengths — the three positioning pillars (why this, not a generic CI/CD tool)
// ---------------------------------------------------------------------------

const strengths = [
  {
    icon: Cloud,
    title: 'Own your infrastructure',
    text: 'Pipelines deploy as native AWS CodePipeline in your own account — standard resources you can inspect, extend, and keep. Zero lock-in.',
  },
  {
    icon: Shield,
    title: 'Governed by default',
    text: 'Per-org compliance rules, role-based access, and a tamper-evident audit trail apply to every build — governance without the bottleneck.',
  },
  {
    icon: Sparkles,
    title: 'Generate, don’t configure',
    text: 'AI turns a Git URL or a plain-English prompt into a working, plugin-wired pipeline in minutes — no YAML archaeology.',
  },
];

function Strengths() {
  return (
    <section className="py-12 px-6 bg-[var(--pb-surface-muted)]">
      <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8">
        {strengths.map((s, i) => (
          <motion.div
            key={s.title}
            className="flex flex-col gap-2"
            variants={fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            custom={i}
          >
            <s.icon className="w-6 h-6 text-[var(--pb-brand)]" strokeWidth={1.5} />
            <h3 className="font-semibold text-[var(--pb-text)]">{s.title}</h3>
            <p className="text-sm text-[var(--pb-text-muted)] leading-relaxed">{s.text}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// AI + Providers
// ---------------------------------------------------------------------------

const aiProviders = [
  { name: 'Anthropic', icon: Bot },
  { name: 'OpenAI', icon: Sparkles },
  { name: 'Google', icon: Globe },
  { name: 'xAI', icon: Zap },
  { name: 'Bedrock', icon: Cloud },
];

function AI() {
  return (
    <section id="how" className="py-16 px-6 scroll-mt-16">
      <div className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
        <motion.div
          initial={{ opacity: 0, x: -12 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4 }}
        >
          <div className="text-[11px] uppercase tracking-wide text-[var(--pb-brand)] font-semibold mb-2">How it works</div>
          <h2 className="text-2xl font-bold mb-3">Paste a Git URL, get a pipeline</h2>
          <p className="text-sm text-[var(--pb-text-muted)] mb-4 leading-relaxed">
            AI reads your repo, picks the right plugins, and wires up build, test, and
            deploy stages. You review the plan and ship — no YAML to hand-write.
          </p>
          <div className="flex flex-wrap gap-2">
            {aiProviders.map((p) => (
              <span key={p.name} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs bg-[var(--pb-surface)] border border-[var(--pb-border)]">
                <p.icon className="w-3 h-3 text-[var(--pb-brand)]" strokeWidth={1.5} />
                {p.name}
              </span>
            ))}
          </div>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, x: 12 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, delay: 0.08 }}
        >
          <TerminalBlock title="terminal" code={`$ curl -X POST /api/pipelines/generate \\
  -d '{ "prompt": "Node.js + tests + CDK deploy" }'

{ "stages": [
    { "plugin": "nodejs" },
    { "plugin": "jest" },
    { "plugin": "cdk-deploy" }
  ]
}`} />
        </motion.div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Features — the full value-prop set, grouped so it's comprehensive but scannable
// ---------------------------------------------------------------------------

const featureGroups = [
  {
    icon: Sparkles,
    title: 'Generate',
    items: ['AI from a Git URL or prompt', '119 plugins across 10 categories', 'Golden-path templates', 'Dashboard, CLI, REST API & CDK'],
  },
  {
    icon: Cloud,
    title: 'Deploy',
    items: ['Native AWS CodePipeline + CodeBuild', 'Runs in your own AWS account', 'Per-org container registry', 'Zero lock-in'],
  },
  {
    icon: Shield,
    title: 'Govern',
    items: ['Per-org compliance rules & scans', 'Role-based access control', 'Tamper-evident audit trail', 'SSO / OAuth + step-up auth'],
  },
  {
    icon: BarChart3,
    title: 'Measure',
    items: ['Execution analytics', 'Team usage analytics', 'DORA metrics & trends', 'Observability + quotas'],
  },
];

function Features() {
  return (
    <section className="py-14 px-6">
      <div className="max-w-5xl mx-auto">
        <motion.h2
          className="text-2xl font-bold text-center mb-2"
          initial={{ opacity: 0, y: 8 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4 }}
        >
          Everything you get
        </motion.h2>
        <p className="text-sm text-[var(--pb-text-muted)] text-center mb-8">
          Generate, deploy, govern, and measure — in one self-service platform.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {featureGroups.map((g, i) => (
            <motion.div
              key={g.title}
              variants={fadeUp}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              custom={i}
            >
              <Card className="h-full p-5">
                <div className="flex items-center gap-2 mb-3">
                  <g.icon className="w-5 h-5 text-[var(--pb-brand)]" strokeWidth={1.5} />
                  <h3 className="font-semibold">{g.title}</h3>
                </div>
                <ul className="space-y-2">
                  {g.items.map((item) => (
                    <li key={item} className="flex items-start gap-1.5 text-sm text-[var(--pb-text-muted)]">
                      <Check className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--pb-success)]" strokeWidth={2} />
                      {item}
                    </li>
                  ))}
                </ul>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// CTA
// ---------------------------------------------------------------------------

function CTA() {
  return (
    <section className="py-16 px-6 bg-[var(--pb-surface-muted)]">
      <div className="max-w-md mx-auto text-center">
        <h2 className="text-2xl font-bold mb-3">Ship your first pipeline today</h2>
        <p className="text-sm text-[var(--pb-text-muted)] mb-5">
          Generate it from a repo or a prompt — deployed in your own AWS account, governed from day one.
        </p>
        <Link href="/auth/register" className="btn btn-primary px-6 py-2.5 text-sm">
          Get started free <ArrowRight className="w-3.5 h-3.5 ml-1.5 inline" />
        </Link>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function Footer() {
  return (
    <footer className="border-t border-[var(--pb-border)] py-6 px-6">
      <div className="max-w-5xl mx-auto flex items-center justify-between text-xs text-[var(--pb-text-muted)]">
        <span className="font-serif font-bold text-sm text-[var(--pb-text)]">Pipeline Builder</span>
        <span>Apache 2.0</span>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Terminal block
// ---------------------------------------------------------------------------

function TerminalBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="rounded-lg border border-[var(--pb-border)] bg-[var(--pb-surface)] overflow-hidden shadow-sm">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[var(--pb-border)] bg-[var(--pb-surface-muted)]">
        <span className="w-2 h-2 rounded-full bg-red-400/60" />
        <span className="w-2 h-2 rounded-full bg-yellow-400/60" />
        <span className="w-2 h-2 rounded-full bg-green-400/60" />
        <span className="ml-2 text-[10px] text-[var(--pb-text-muted)]">{title}</span>
      </div>
      <pre className="p-3 text-[11px] leading-relaxed font-mono text-[var(--pb-text-muted)] overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <NavBar />
      <Hero />
      <Strengths />
      <AI />
      <Features />
      <CTA />
      <Footer />
    </div>
  );
}
