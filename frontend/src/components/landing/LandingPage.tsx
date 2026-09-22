import Link from 'next/link';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Shield, BarChart3, Cloud, Bot, Globe, Zap, ArrowRight, Check, Sparkles, Menu, X, Moon, Sun,
} from 'lucide-react';
import { useDarkMode } from '@/hooks/useDarkMode';
import { Card } from '@/components/ui/Card';
import { SignInCard } from '@/components/auth/SignInCard';

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
        ? 'bg-surface/90 backdrop-blur-lg border-b border-default shadow-sm'
        : 'bg-transparent'
    }`}>
      <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <a href="#top" className="font-serif text-lg font-bold text-fg" aria-label="Pipeline Builder home">
          Pipeline Builder
        </a>
        <div className="flex items-center gap-2">
          <Link href="/plugins" className="hidden sm:inline-flex text-sm font-medium text-fg-muted hover:text-fg px-2 py-1.5">
            Browse plugins
          </Link>
          <button onClick={toggleDark} className="p-2 text-fg-muted hover:text-fg transition-colors" aria-label="Dark mode" aria-pressed={isDark}>
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <Link href="/auth/register" className="hidden sm:inline-flex btn btn-primary text-sm px-4 py-1.5">
            Get Started
          </Link>
          <button onClick={() => setMobileOpen(!mobileOpen)} className="sm:hidden p-2 text-fg-muted" aria-label="Menu">
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>
      {/* Mobile menu */}
      {mobileOpen && (
        <div className="sm:hidden border-t border-default bg-surface px-6 py-4 space-y-3">
          <Link href="/plugins" onClick={() => setMobileOpen(false)} className="block text-sm text-fg-muted">Browse plugins</Link>
          <a href="#signin" onClick={() => setMobileOpen(false)} className="block text-sm text-fg-muted">Sign in</a>
          <Link href="/auth/register" onClick={() => setMobileOpen(false)} className="block btn btn-primary text-sm text-center">Get started</Link>
        </div>
      )}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Hero — headline left, sign-in right
// ---------------------------------------------------------------------------

function Hero() {
  return (
    <section id="top" className="pt-24 pb-10 px-6">
      <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-5 gap-10 items-start">
        {/* Left — 3 cols */}
        <div className="lg:col-span-3 pt-2">
          <motion.div
            className="inline-flex items-center gap-1.5 mb-3 px-3 py-1 rounded-full text-xs font-medium bg-surface border border-default text-fg-muted"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <Sparkles className="w-3.5 h-3.5 text-brand" strokeWidth={2} />
            Self-service CI/CD for AWS
          </motion.div>
          <motion.h1
            className="text-3xl sm:text-4xl font-bold leading-tight mb-3"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.05 }}
          >
            CI/CD pipelines from code or{' '}
            <span className="text-brand">AI</span>
          </motion.h1>
          <motion.p
            className="text-fg-muted text-sm mb-4 leading-relaxed max-w-lg"
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
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-fg-muted mb-5">
              {['Dashboard', 'AI Prompt', 'CLI', 'REST API', 'CDK'].map((t) => (
                <span key={t} className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-success" strokeWidth={2} />
                  {t}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/auth/register" className="btn btn-primary px-5 py-2 text-sm">
                Get started free <ArrowRight className="w-3.5 h-3.5 ml-1.5 inline" />
              </Link>
              <a href="#how" className="btn btn-secondary px-5 py-2 text-sm">See how it works</a>
              <span className="text-xs text-fg-muted">
                Apache-2.0 · No credit card
              </span>
            </div>
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
          <SignInCard />
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
    <section className="py-12 px-6 bg-surface-muted">
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
            <s.icon className="w-6 h-6 text-brand" strokeWidth={1.5} />
            <h3 className="font-semibold text-fg">{s.title}</h3>
            <p className="text-sm text-fg-muted leading-relaxed">{s.text}</p>
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
          <div className="text-2xs uppercase tracking-wide text-brand font-semibold mb-2">How it works</div>
          <h2 className="text-2xl font-bold mb-3">Paste a Git URL, get a pipeline</h2>
          <p className="text-sm text-fg-muted mb-4 leading-relaxed">
            AI reads your repo, picks the right plugins, and wires up build, test, and
            deploy stages. You review the plan and ship — no YAML to hand-write.
          </p>
          <div className="flex flex-wrap gap-2">
            {aiProviders.map((p) => (
              <span key={p.name} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs bg-surface border border-default">
                <p.icon className="w-3 h-3 text-brand" strokeWidth={1.5} />
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
        <p className="text-sm text-fg-muted text-center mb-8">
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
                  <g.icon className="w-5 h-5 text-brand" strokeWidth={1.5} />
                  <h3 className="font-semibold">{g.title}</h3>
                </div>
                <ul className="space-y-2">
                  {g.items.map((item) => (
                    <li key={item} className="flex items-start gap-1.5 text-sm text-fg-muted">
                      <Check className="w-3.5 h-3.5 mt-0.5 shrink-0 text-success" strokeWidth={2} />
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
    <section className="py-16 px-6 bg-surface-muted">
      <div className="max-w-md mx-auto text-center">
        <h2 className="text-2xl font-bold mb-3">Ship your first pipeline today</h2>
        <p className="text-sm text-fg-muted mb-5">
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
    <footer className="border-t border-default py-6 px-6">
      <div className="max-w-5xl mx-auto flex items-center justify-between text-xs text-fg-muted">
        <span className="font-serif font-bold text-sm text-fg">Pipeline Builder</span>
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
    <div className="rounded-lg border border-default bg-surface overflow-hidden shadow-sm">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-default bg-surface-muted">
        <span className="w-2 h-2 rounded-full bg-red-400/60" />
        <span className="w-2 h-2 rounded-full bg-yellow-400/60" />
        <span className="w-2 h-2 rounded-full bg-green-400/60" />
        <span className="ml-2 text-2xs text-fg-muted">{title}</span>
      </div>
      <pre className="p-3 text-2xs leading-relaxed font-mono text-fg-muted overflow-x-auto">
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
    // `marketing-canvas` carries the two-tone radial wash. It belongs to this
    // page: on `body` it would tint every table and card in the signed-in app.
    <div className="min-h-screen marketing-canvas">
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
