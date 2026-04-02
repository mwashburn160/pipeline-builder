import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { motion } from 'framer-motion';
import {
  Shield, Package, BarChart3,
  Cpu, Cloud, Server, Container,
  Bot, Globe, Zap, ArrowRight, Check, LogIn, Terminal, Sparkles,
  Menu, X, Moon, Sun,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useDarkMode } from '@/hooks/useDarkMode';
import { LoadingSpinner } from '@/components/ui/Loading';

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
  const [error, setError] = useState<string | null>(null);
  const sessionExpired = router.query.expired === '1';

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!identifier || !password) { setError('Enter your email and password'); return; }
    try { await login(identifier, password); }
    catch (err) { setError(err instanceof Error ? err.message : 'Sign in failed'); }
  };

  return (
    <section id="top" className="pt-24 pb-12 px-6">
      <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-5 gap-10 items-start">
        {/* Left — 3 cols */}
        <div className="lg:col-span-3 pt-2">
          <motion.h1
            className="text-3xl sm:text-4xl font-bold leading-tight mb-4"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            CI/CD pipelines from code or{' '}
            <span className="text-[var(--pb-brand)]">AI</span>
          </motion.h1>
          <motion.p
            className="text-[var(--pb-text-muted)] mb-6 leading-relaxed max-w-lg"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.08 }}
          >
            Deploy as native AWS CodePipeline in your account.
            125 plugins, per-org compliance, zero lock-in.
          </motion.p>
          <motion.div
            className="flex flex-wrap gap-4 text-sm text-[var(--pb-text-muted)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, delay: 0.15 }}
          >
            {['Dashboard', 'AI Prompt', 'CLI', 'REST API', 'CDK'].map((t) => (
              <span key={t} className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-[var(--pb-success)]" strokeWidth={2} />
                {t}
              </span>
            ))}
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
          <div className="card p-5">
            <h2 className="font-bold mb-4">Sign in</h2>

            {sessionExpired && !error && (
              <p className="text-xs text-[var(--pb-accent)] mb-3">Session expired. Please sign in again.</p>
            )}
            {error && <div className="alert-error mb-3 text-sm">{error}</div>}

            <form onSubmit={handleSignIn} className="space-y-3">
              <input
                id="signin-identifier"
                type="text"
                autoComplete="username"
                required
                className="input"
                placeholder="Email or username"
                aria-label="Email or username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                disabled={isLoading}
              />
              <input
                id="signin-password"
                type="password"
                autoComplete="current-password"
                required
                className="input"
                placeholder="Password"
                aria-label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
              />
              <button type="submit" disabled={isLoading} className="btn btn-primary btn-full text-sm">
                {isLoading
                  ? <><LoadingSpinner size="sm" className="mr-2" /> Signing in...</>
                  : <><LogIn className="w-4 h-4 mr-1.5" /> Sign in</>
                }
              </button>
            </form>

            <p className="text-xs text-[var(--pb-text-muted)] mt-4 text-center">
              New here?{' '}
              <Link href="/auth/register" className="text-[var(--pb-brand)] hover:underline">
                Create account
              </Link>
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Value props — single row
// ---------------------------------------------------------------------------

const highlights = [
  { icon: Shield, text: 'Per-org compliance' },
  { icon: Package, text: '125 plugins' },
  { icon: BarChart3, text: 'Execution analytics' },
];

function ValueProps() {
  return (
    <section className="py-10 px-6 bg-[var(--pb-surface-muted)]">
      <div className="max-w-3xl mx-auto flex flex-wrap items-center justify-center gap-8">
        {highlights.map((h, i) => (
          <motion.div
            key={h.text}
            className="flex items-center gap-2 text-sm"
            variants={fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            custom={i}
          >
            <h.icon className="w-5 h-5 text-[var(--pb-brand)]" strokeWidth={1.5} />
            <span className="text-[var(--pb-text-muted)]">{h.text}</span>
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
  { name: 'Ollama', icon: Cpu },
  { name: 'Anthropic', icon: Bot },
  { name: 'OpenAI', icon: Sparkles },
  { name: 'Google', icon: Globe },
  { name: 'xAI', icon: Zap },
  { name: 'Bedrock', icon: Cloud },
];

function AI() {
  return (
    <section className="py-14 px-6">
      <div className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
        <motion.div
          initial={{ opacity: 0, x: -12 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4 }}
        >
          <h2 className="text-2xl font-bold mb-3">Paste a Git URL, get a pipeline</h2>
          <p className="text-sm text-[var(--pb-text-muted)] mb-4 leading-relaxed">
            AI analyzes your repo and generates stages and plugins automatically.
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
// Plugins
// ---------------------------------------------------------------------------

const categories = [
  'Language 11', 'Security 40', 'Quality 17', 'Testing 14',
  'Artifact 16', 'Deploy 11', 'Infra 5', 'Monitoring 3', 'Notify 5', 'AI 2',
];

function Plugins() {
  return (
    <section id="plugins" className="py-14 px-6 bg-[var(--pb-surface-muted)]">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-2xl font-bold mb-2">125 pre-built plugins</h2>
        <p className="text-sm text-[var(--pb-text-muted)] mb-5">Full CI/CD lifecycle in containerized steps</p>
        <div className="flex flex-wrap justify-center gap-2">
          {categories.map((c) => {
            const [name, count] = c.split(' ');
            return (
              <span key={c} className="px-2.5 py-1 rounded-full text-xs bg-[var(--pb-surface)] border border-[var(--pb-border)]">
                {name} <span className="text-[var(--pb-brand)] font-bold">{count}</span>
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

const deploys = [
  { name: 'Local', cost: 'Free', icon: Terminal },
  { name: 'Minikube', cost: 'Free', icon: Container },
  { name: 'EC2', cost: '~$30/mo', icon: Server },
  { name: 'Fargate', cost: '~$100/mo', icon: Cloud },
];

function Deploy() {
  return (
    <section id="deploy" className="py-14 px-6">
      <div className="max-w-3xl mx-auto">
        <h2 className="text-2xl font-bold text-center mb-6">Deploy anywhere</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {deploys.map((d, i) => (
            <motion.div
              key={d.name}
              className="card p-4 text-center"
              variants={fadeUp}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              custom={i}
            >
              <d.icon className="w-5 h-5 text-[var(--pb-brand)] mx-auto mb-2" strokeWidth={1.5} />
              <p className="font-semibold text-sm">{d.name}</p>
              <p className="text-xs text-[var(--pb-brand)]">{d.cost}</p>
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
        <h2 className="text-2xl font-bold mb-3">Ready to start?</h2>
        <p className="text-sm text-[var(--pb-text-muted)] mb-5">Build your first pipeline in minutes.</p>
        <Link href="/auth/register" className="btn btn-primary px-6 py-2.5 text-sm">
          Create Account <ArrowRight className="w-3.5 h-3.5 ml-1.5 inline" />
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
      <ValueProps />
      <AI />
      <CTA />
      <Footer />
    </div>
  );
}
