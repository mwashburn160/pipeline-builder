import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { motion } from 'framer-motion';
import {
  Layout, Sparkles, Terminal, Code2, Blocks,
  Shield, Package, Users, BarChart3, Lock,
  Cpu, Cloud, Server, Container,
  Bot, Globe, Zap, ArrowRight, Check, LogIn,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { LoadingSpinner } from '@/components/ui/Loading';

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.06, duration: 0.4, ease: 'easeOut' as const },
  }),
};

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

function NavBar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 32);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'bg-[var(--pb-surface)]/90 backdrop-blur-lg border-b border-[var(--pb-border)] shadow-sm'
          : 'bg-transparent'
      }`}
    >
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <a href="#top" className="font-serif text-lg font-bold text-[var(--pb-text)]">
          Pipeline Builder
        </a>
        <div className="hidden md:flex items-center gap-5 text-sm text-[var(--pb-text-muted)]">
          <a href="#features" className="hover:text-[var(--pb-text)] transition-colors">Features</a>
          <a href="#plugins" className="hover:text-[var(--pb-text)] transition-colors">Plugins</a>
          <a href="#deploy" className="hover:text-[var(--pb-text)] transition-colors">Deploy</a>
        </div>
        <div className="flex items-center gap-3">
          <a href="#signin" className="text-sm text-[var(--pb-text-muted)] hover:text-[var(--pb-text)] transition-colors">
            Sign In
          </a>
          <Link href="/auth/register" className="btn btn-primary text-sm px-4 py-1.5">
            Get Started
          </Link>
        </div>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Hero with login form
// ---------------------------------------------------------------------------

function Hero() {
  const { login, isLoading } = useAuth();
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const sessionExpired = router.query.expired === '1';

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!identifier || !password) {
      setError('Enter your email and password');
      return;
    }
    try {
      await login(identifier, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    }
  };

  return (
    <section id="top" className="pt-24 pb-8 px-6">
      <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
        {/* Left — copy */}
        <div className="pt-4">
          <motion.p
            className="text-xs font-semibold text-[var(--pb-brand)] mb-3 tracking-widest uppercase"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
          >
            CI/CD Pipeline Platform
          </motion.p>
          <motion.h1
            className="text-3xl sm:text-4xl font-bold leading-tight mb-4"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            Build pipelines from code, CLI, or{' '}
            <span className="text-[var(--pb-brand)]">a single AI prompt</span>
          </motion.h1>
          <motion.p
            className="text-sm sm:text-base text-[var(--pb-text-muted)] mb-6 leading-relaxed"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            Deploy as native AWS CodePipeline in your own account.
            125 plugins. Per-org compliance. Zero lock-in.
          </motion.p>
          <motion.div
            className="hidden lg:block"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.2 }}
          >
            <div className="rounded-lg border border-[var(--pb-border)] bg-[var(--pb-surface)] shadow-lg overflow-hidden">
              <div className="flex items-center gap-1.5 px-4 py-2 border-b border-[var(--pb-border)] bg-[var(--pb-surface-muted)]">
                <span className="w-2.5 h-2.5 rounded-full bg-red-400/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-yellow-400/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-green-400/60" />
                <span className="ml-3 text-[10px] text-[var(--pb-text-muted)]">pipeline.ts</span>
              </div>
              <pre className="p-3 text-[10px] leading-relaxed overflow-x-auto font-mono text-[var(--pb-text-muted)]">
                <code>{`new PipelineBuilder(stack, 'MyPipeline', {
  project: 'my-app',
  synth: {
    source: { type: 'github', options: { repo: 'org/app' } },
    plugin: { name: 'cdk-synth', version: '1.0.0' },
  },
  stages: [
    { stageName: 'Test', steps: [{ plugin: { name: 'jest' } }] },
    { stageName: 'Deploy', steps: [{ plugin: { name: 'cdk-deploy' } }] },
  ],
});`}</code>
              </pre>
            </div>
          </motion.div>
        </div>

        {/* Right — sign in form */}
        <motion.div
          id="signin"
          className="w-full max-w-sm mx-auto lg:mx-0 lg:ml-auto"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
        >
          <div className="card p-6">
            <h2 className="text-lg font-bold mb-1">Sign in</h2>
            <p className="text-xs text-[var(--pb-text-muted)] mb-5">
              Or{' '}
              <Link href="/auth/register" className="text-[var(--pb-brand)] hover:underline">
                create a new account
              </Link>
            </p>

            {sessionExpired && !error && (
              <div className="rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 p-2.5 mb-4">
                <p className="text-xs text-yellow-800 dark:text-yellow-200">Session expired. Please sign in again.</p>
              </div>
            )}

            {error && (
              <div className="alert-error mb-4 text-sm">
                {error}
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-3">
              <div>
                <label htmlFor="landing-identifier" className="label text-xs">Email or Username</label>
                <input
                  id="landing-identifier"
                  type="text"
                  autoComplete="username"
                  required
                  className="input"
                  placeholder="you@example.com"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  disabled={isLoading}
                />
              </div>
              <div>
                <label htmlFor="landing-password" className="label text-xs">Password</label>
                <input
                  id="landing-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  className="input"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isLoading}
                />
              </div>
              <button
                type="submit"
                disabled={isLoading}
                className="btn btn-primary btn-full text-sm mt-1"
              >
                {isLoading ? (
                  <>
                    <LoadingSpinner size="sm" className="mr-2" />
                    Signing in...
                  </>
                ) : (
                  <>
                    <LogIn className="w-4 h-4 mr-1.5" />
                    Sign in
                  </>
                )}
              </button>
            </form>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// How It Works — connected steps
// ---------------------------------------------------------------------------

const steps = [
  { num: '1', label: 'Choose your interface', desc: 'Dashboard, AI, CLI, API, or CDK' },
  { num: '2', label: 'Configure your pipeline', desc: 'Select plugins for each stage' },
  { num: '3', label: 'Deploy to AWS', desc: 'Native CodePipeline, your account' },
];

function HowItWorks() {
  return (
    <section className="py-16 px-6 bg-[var(--pb-surface-muted)]">
      <div className="max-w-3xl mx-auto">
        <SectionLabel text="How It Works" />
        <div className="relative grid grid-cols-1 sm:grid-cols-3 gap-8">
          <div className="hidden sm:block absolute top-[18px] left-[16.6%] right-[16.6%] h-px bg-[var(--pb-border)]" />
          {steps.map((s, i) => (
            <motion.div
              key={s.num}
              className="relative text-center"
              variants={fadeUp}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              custom={i}
            >
              <div className="relative z-10 w-9 h-9 rounded-full bg-[var(--pb-brand)] text-white text-sm font-bold flex items-center justify-center mx-auto mb-3">
                {s.num}
              </div>
              <p className="font-semibold text-sm mb-1">{s.label}</p>
              <p className="text-xs text-[var(--pb-text-muted)]">{s.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

const interfaces = [
  { icon: Layout, title: 'Dashboard', desc: 'Visual builder' },
  { icon: Sparkles, title: 'AI Prompt', desc: 'From a Git URL' },
  { icon: Terminal, title: 'CLI', desc: 'Scripted workflows' },
  { icon: Code2, title: 'REST API', desc: 'Programmatic access' },
  { icon: Blocks, title: 'CDK', desc: 'Infrastructure-as-code' },
];

function Interfaces() {
  return (
    <section className="py-16 px-6">
      <div className="max-w-4xl mx-auto">
        <SectionLabel text="Five Ways to Build" />
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {interfaces.map((item, i) => (
            <motion.div
              key={item.title}
              className="card p-4 text-center"
              variants={fadeUp}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              custom={i}
            >
              <item.icon className="w-6 h-6 text-[var(--pb-brand)] mx-auto mb-2" strokeWidth={1.5} />
              <p className="font-semibold text-xs mb-0.5">{item.title}</p>
              <p className="text-[10px] text-[var(--pb-text-muted)]">{item.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

const featureList = [
  'Self-service pipeline creation — no AWS expertise needed',
  'Per-org compliance rules block non-compliant deploys',
  '125 containerized plugins across 10 categories',
  'Multi-tenant orgs with RBAC, secrets, and quotas',
  'Execution analytics with duration percentiles and failure heatmaps',
  'Deploys as native AWS CodePipeline — zero vendor lock-in',
];

const featureCards = [
  { icon: Shield, title: 'Compliance', desc: '18 operators, computed fields, published rule catalog, audit trail' },
  { icon: Package, title: 'Plugins', desc: 'Reusable build steps — builds, tests, scans, deploys, notifications' },
  { icon: BarChart3, title: 'Analytics', desc: 'Success rates, p95 durations, stage bottlenecks, error categorization' },
];

function Features() {
  return (
    <section id="features" className="py-16 px-6 bg-[var(--pb-surface-muted)]">
      <div className="max-w-5xl mx-auto">
        <SectionLabel text="Why Pipeline Builder" />
        <motion.div
          className="max-w-2xl mx-auto mb-12"
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4 }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
            {featureList.map((f) => (
              <div key={f} className="flex items-start gap-2">
                <Check className="w-4 h-4 text-[var(--pb-success)] mt-0.5 shrink-0" strokeWidth={2} />
                <span className="text-sm text-[var(--pb-text-muted)]">{f}</span>
              </div>
            ))}
          </div>
        </motion.div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {featureCards.map((item, i) => (
            <motion.div
              key={item.title}
              className="card p-6"
              variants={fadeUp}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              custom={i}
            >
              <item.icon className="w-7 h-7 text-[var(--pb-brand)] mb-3" strokeWidth={1.5} />
              <p className="font-semibold text-sm mb-1">{item.title}</p>
              <p className="text-xs text-[var(--pb-text-muted)] leading-relaxed">{item.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// AI
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
    <section className="py-16 px-6">
      <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
        <motion.div
          initial={{ opacity: 0, x: -16 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <SectionLabel text="AI Generation" align="left" />
          <h3 className="text-2xl font-bold mb-3">Paste a Git URL, get a pipeline</h3>
          <p className="text-sm text-[var(--pb-text-muted)] mb-5 leading-relaxed">
            The AI builder analyzes your repository — language, framework, test setup,
            Dockerfile — and generates the right stages and plugins automatically.
          </p>
          <div className="flex flex-wrap gap-3">
            {aiProviders.map((p) => (
              <span
                key={p.name}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-[var(--pb-surface)] border border-[var(--pb-border)]"
              >
                <p.icon className="w-3.5 h-3.5 text-[var(--pb-brand)]" strokeWidth={1.5} />
                {p.name}
              </span>
            ))}
          </div>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, x: 16 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1 }}
        >
          <div className="rounded-lg border border-[var(--pb-border)] bg-[var(--pb-surface)] shadow-lg overflow-hidden">
            <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-[var(--pb-border)] bg-[var(--pb-surface-muted)]">
              <span className="w-2.5 h-2.5 rounded-full bg-red-400/60" />
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-400/60" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-400/60" />
              <span className="ml-3 text-[10px] text-[var(--pb-text-muted)]">terminal</span>
            </div>
            <pre className="p-4 text-[11px] leading-relaxed overflow-x-auto font-mono text-[var(--pb-text-muted)]">
              <code>{`$ curl -X POST /api/pipelines/generate \\
  -d '{
    "prompt": "Build a Node.js app, run tests,
               and deploy with CDK",
    "provider": "anthropic"
  }'

{
  "success": true,
  "data": {
    "stages": [
      { "stageName": "Build", "plugin": "nodejs" },
      { "stageName": "Test",  "plugin": "jest" },
      { "stageName": "Scan",  "plugin": "snyk" },
      { "stageName": "Deploy","plugin": "cdk-deploy" }
    ]
  }
}`}</code>
            </pre>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

const pluginCategories = [
  { name: 'Language', count: 11 },
  { name: 'Security', count: 40 },
  { name: 'Quality', count: 17 },
  { name: 'Testing', count: 14 },
  { name: 'Artifact', count: 16 },
  { name: 'Deploy', count: 11 },
  { name: 'Infrastructure', count: 5 },
  { name: 'Monitoring', count: 3 },
  { name: 'Notification', count: 5 },
  { name: 'AI', count: 2 },
];

function Plugins() {
  const total = pluginCategories.reduce((sum, c) => sum + c.count, 0);

  return (
    <section id="plugins" className="py-16 px-6 bg-[var(--pb-surface-muted)]">
      <div className="max-w-3xl mx-auto text-center">
        <SectionLabel text="Plugin Catalog" />
        <h3 className="text-2xl font-bold mb-2">{total} pre-built plugins</h3>
        <p className="text-sm text-[var(--pb-text-muted)] mb-6">
          Containerized build steps covering the full CI/CD lifecycle
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {pluginCategories.map((cat) => (
            <span
              key={cat.name}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-[var(--pb-surface)] border border-[var(--pb-border)]"
            >
              {cat.name}
              <span className="text-[var(--pb-brand)] font-bold">{cat.count}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

const deployOptions = [
  { name: 'Local', sub: 'Docker Compose', cost: 'Free', icon: Terminal },
  { name: 'Minikube', sub: 'Local K8s', cost: 'Free', icon: Container },
  { name: 'EC2', sub: 'Dev / staging', cost: '~$30/mo', icon: Server },
  { name: 'Fargate', sub: 'Production', cost: '~$100/mo', icon: Cloud },
];

function Deploy() {
  return (
    <section id="deploy" className="py-16 px-6">
      <div className="max-w-3xl mx-auto">
        <SectionLabel text="Deployment" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {deployOptions.map((opt, i) => (
            <motion.div
              key={opt.name}
              className="card p-5 text-center"
              variants={fadeUp}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              custom={i}
            >
              <opt.icon className="w-6 h-6 text-[var(--pb-brand)] mx-auto mb-2" strokeWidth={1.5} />
              <p className="font-semibold text-sm">{opt.name}</p>
              <p className="text-[10px] text-[var(--pb-text-muted)] mb-1">{opt.sub}</p>
              <p className="text-xs font-medium text-[var(--pb-brand)]">{opt.cost}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Bottom CTA
// ---------------------------------------------------------------------------

function BottomCTA() {
  return (
    <section className="py-20 px-6 bg-[var(--pb-surface-muted)]">
      <div className="max-w-2xl mx-auto text-center">
        <h2 className="text-2xl sm:text-3xl font-bold mb-3">Ready to get started?</h2>
        <p className="text-sm text-[var(--pb-text-muted)] mb-6">
          Create an account and build your first pipeline in minutes.
        </p>
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
    <footer className="border-t border-[var(--pb-border)] py-8 px-6">
      <div className="max-w-6xl mx-auto flex items-center justify-between text-xs text-[var(--pb-text-muted)]">
        <span className="font-serif font-bold text-sm text-[var(--pb-text)]">Pipeline Builder</span>
        <span>Apache License 2.0</span>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function SectionLabel({ text, align = 'center' }: { text: string; align?: 'center' | 'left' }) {
  return (
    <p className={`text-xs font-semibold uppercase tracking-widest text-[var(--pb-brand)] mb-4 ${
      align === 'center' ? 'text-center' : 'text-left'
    }`}>
      {text}
    </p>
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
      <HowItWorks />
      <Interfaces />
      <Features />
      <AI />
      <Plugins />
      <Deploy />
      <BottomCTA />
      <Footer />
    </div>
  );
}
