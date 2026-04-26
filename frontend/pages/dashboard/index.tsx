import { useEffect, useMemo, useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  GitBranch, ArrowRight, Upload, Wand2, Puzzle, Activity, CheckCircle2,
  BarChart3, XCircle, Shield, Users, FileText, MessageSquare, Settings,
  CreditCard, Clock, Star, Search,
} from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import type { BuilderProps } from '@/types';
import { LoadingPage } from '@/components/ui/Loading';
import api from '@/lib/api';
import CreatePipelineModal from '@/components/pipeline/CreatePipelineModal';
import { NewOrgWelcome } from '@/components/dashboard/NewOrgWelcome';
import { dismissKey, shouldShowOnboarding, visitedPluginsKey } from '@/lib/onboarding';

// ─── Types ──────────────────────────────────────────────

interface ExecutionCount {
  id: string;
  total: number;
  succeeded: number;
  failed: number;
}

interface TimelineEntry {
  period: string;
  succeeded: number;
  failed: number;
  canceled: number;
}

interface PluginSummary {
  total: number;
  active: number;
}

// ─── Service catalog (AWS Console-style) ────────────────

interface ServiceTile {
  name: string;
  description: string;
  href: string;
  icon: typeof GitBranch;
}

const SERVICES: ServiceTile[] = [
  { name: 'Pipelines', description: 'Define and manage CI/CD pipelines', href: '/dashboard/pipelines', icon: GitBranch },
  { name: 'Plugins', description: 'Reusable build steps and plugins', href: '/dashboard/plugins', icon: Puzzle },
  { name: 'Compliance', description: 'Rules, policies, and audit trail', href: '/dashboard/compliance', icon: Shield },
  { name: 'Reports', description: 'Execution analytics and metrics', href: '/dashboard/reports', icon: BarChart3 },
  { name: 'Activity', description: 'Pipeline events and audit log', href: '/dashboard/activity', icon: Activity },
  { name: 'Team', description: 'Members, roles, and invitations', href: '/dashboard/team', icon: Users },
  { name: 'Messages', description: 'Org announcements and conversations', href: '/dashboard/messages', icon: MessageSquare },
  { name: 'Billing', description: 'Plans, subscriptions, and usage', href: '/dashboard/billing', icon: CreditCard },
  { name: 'Settings', description: 'Account and organization settings', href: '/dashboard/settings', icon: Settings },
  { name: 'Documentation', description: 'Guides, samples, and reference', href: '/dashboard/help', icon: FileText },
];

const SERVICE_BY_NAME = new Map(SERVICES.map(s => [s.name, s]));

// ─── Helpers ────────────────────────────────────────────

const stagger = {
  container: { hidden: {}, show: { transition: { staggerChildren: 0.04 } } },
  item: { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.2 } } },
};

const RECENT_KEY = 'pb-recently-visited';

function loadRecent(): string[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

// ─── Page ───────────────────────────────────────────────

/** Dashboard home — AWS Console-style services grid + welcome + activity. */
export default function DashboardPage() {
  const { user, isReady, isAuthenticated, isSysAdmin } = useAuthGuard();
  const [gitUrl, setGitUrl] = useState('');
  const [serviceSearch, setServiceSearch] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [modalGitUrl, setModalGitUrl] = useState<string | undefined>();
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);

  // Stats
  const [executions, setExecutions] = useState<ExecutionCount[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [pluginSummary, setPluginSummary] = useState<PluginSummary | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [pipelineCount, setPipelineCount] = useState<number | null>(null);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [onboardingVisitedPlugins, setOnboardingVisitedPlugins] = useState(false);

  const fetchData = useCallback(async () => {
    const [execRes, timelineRes, pluginRes, pipelineRes] = await Promise.allSettled([
      api.getExecutionCount(),
      api.getExecutionTimeline({ interval: 'day' }),
      api.getPluginSummary(),
      api.listPipelines({ limit: '1' }),
    ]);

    if (execRes.status === 'fulfilled') setExecutions(execRes.value.data?.pipelines || []);
    if (timelineRes.status === 'fulfilled') setTimeline((timelineRes.value.data?.timeline || []).slice(-7));
    if (pluginRes.status === 'fulfilled') setPluginSummary(pluginRes.value.data?.summary || null);
    if (pipelineRes.status === 'fulfilled') setPipelineCount(pipelineRes.value.data?.pagination?.total ?? 0);
  }, []);

  useEffect(() => {
    if (isAuthenticated) fetchData();
  }, [isAuthenticated, fetchData]);

  useEffect(() => {
    setRecent(loadRecent());
  }, []);

  // Read onboarding flags from localStorage once the user/org is known.
  useEffect(() => {
    if (typeof window === 'undefined' || !user) return;
    const orgId = user.organizationId ?? '';
    if (!orgId) return;
    setOnboardingDismissed(localStorage.getItem(dismissKey(orgId)) === '1');
    setOnboardingVisitedPlugins(localStorage.getItem(visitedPluginsKey(orgId)) === '1');
  }, [user]);

  // ─── Computed (must run on every render — hooks before early return) ───

  const stats = useMemo(() => {
    const totalExec = executions.reduce((s, p) => s + p.total, 0);
    const totalPass = executions.reduce((s, p) => s + p.succeeded, 0);
    const totalFailed = executions.reduce((s, p) => s + p.failed, 0);
    const successRate = totalExec > 0 ? Math.round((totalPass / totalExec) * 100) : null;
    return [
      { label: 'Pipelines', value: String(executions.length || 0), icon: GitBranch, color: 'text-blue-500' },
      { label: 'Total Executions', value: String(totalExec), icon: BarChart3, color: 'text-indigo-500' },
      { label: 'Failed Executions', value: String(totalFailed), icon: XCircle, color: totalFailed > 0 ? 'text-red-500' : 'text-gray-400' },
      { label: 'Success Rate', value: successRate !== null ? `${successRate}%` : '--', icon: CheckCircle2, color: successRate !== null && successRate >= 90 ? 'text-green-500' : successRate !== null && successRate >= 70 ? 'text-yellow-500' : 'text-red-500' },
      { label: 'Active Plugins', value: pluginSummary ? String(pluginSummary.active) : '--', icon: Puzzle, color: 'text-purple-500' },
    ];
  }, [executions, pluginSummary]);

  const filteredServices = useMemo(() => {
    if (!serviceSearch) return SERVICES;
    const q = serviceSearch.toLowerCase();
    return SERVICES.filter(s =>
      s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [serviceSearch]);

  const recentServices = useMemo(
    () => recent.map(name => SERVICE_BY_NAME.get(name)).filter((s): s is ServiceTile => !!s).slice(0, 6),
    [recent],
  );

  const timelineMax = useMemo(
    () => Math.max(1, ...timeline.map(e => e.succeeded + e.failed + e.canceled)),
    [timeline],
  );

  if (!isReady || !user) return <LoadingPage />;

  const trackVisit = (name: string) => {
    if (typeof window === 'undefined') return;
    const updated = [name, ...recent.filter(n => n !== name)].slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
    setRecent(updated);
  };

  // ─── Handlers ───

  const handleGenerateFromUrl = () => {
    if (!gitUrl.trim()) return;
    setModalGitUrl(gitUrl.trim());
    setCreateError(null);
    setCreateSuccess(null);
    setShowCreateModal(true);
  };

  const handleCreateSubmit = async (props: BuilderProps, accessModifier: 'public' | 'private', description?: string, keywords?: string[]) => {
    setCreateLoading(true);
    setCreateError(null);
    setCreateSuccess(null);
    try {
      await api.createPipeline({ project: props.project || '', organization: props.organization || '', props, accessModifier, description, keywords });
      setCreateSuccess('Pipeline created successfully!');
      setShowCreateModal(false);
      setGitUrl('');
      setModalGitUrl(undefined);
      fetchData();
    } catch (err: unknown) {
      setCreateError(formatError(err, 'Failed to create pipeline'));
    } finally {
      setCreateLoading(false);
    }
  };

  const openModalTab = () => {
    setModalGitUrl(undefined);
    setCreateError(null);
    setCreateSuccess(null);
    setShowCreateModal(true);
  };

  return (
    <DashboardLayout title="Console Home" subtitle={`Welcome back, ${user.username}`}>
      <motion.div variants={stagger.container} initial="hidden" animate="show" className="page-section">

        {/* ─── Welcome Banner with Git URL hero ─── */}
        <motion.div variants={stagger.item} className="card mb-4 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 border-blue-200 dark:border-blue-900">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-blue-600 flex items-center justify-center">
              <GitBranch className="w-6 h-6 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Generate a pipeline from Git</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">Paste a repository URL and let AI build your pipeline configuration.</p>
              <div className="mt-3 flex gap-2">
                <div className="flex-1 relative">
                  <GitBranch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    value={gitUrl}
                    onChange={(e) => setGitUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleGenerateFromUrl(); }}
                    placeholder="https://github.com/owner/repo"
                    className="input pl-9"
                  />
                </div>
                <button onClick={handleGenerateFromUrl} disabled={!gitUrl.trim()} className="btn btn-primary">
                  Generate
                  <ArrowRight className="w-4 h-4 ml-1.5" />
                </button>
              </div>
              <div className="mt-2 flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                <button onClick={openModalTab} className="action-link-muted underline">
                  <Upload className="w-3 h-3 inline mr-0.5" /> Upload config
                </button>
                <button onClick={openModalTab} className="action-link-muted underline">
                  <Wand2 className="w-3 h-3 inline mr-0.5" /> Create manually
                </button>
              </div>
            </div>
          </div>
        </motion.div>

        {/* ─── New-org onboarding (auto-hides once user has both pipelines and executions) ─── */}
        {pipelineCount !== null && (() => {
          const signals = {
            visitedPlugins: onboardingVisitedPlugins,
            pipelineCount,
            executionCount: executions.reduce((s, p) => s + p.total, 0),
          };
          const show = shouldShowOnboarding(signals, onboardingDismissed);
          if (!show) return null;
          return (
            <motion.div variants={stagger.item}>
              <NewOrgWelcome
                signals={signals}
                onDismiss={() => {
                  if (typeof window !== 'undefined' && user?.organizationId) {
                    localStorage.setItem(dismissKey(user.organizationId), '1');
                  }
                  setOnboardingDismissed(true);
                }}
              />
            </motion.div>
          );
        })()}

        {/* ─── Stats Strip ─── */}
        <motion.div variants={stagger.item} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
          {stats.map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.label} className="card py-3 px-4 flex items-center gap-3">
                <div className={`flex-shrink-0 ${s.color}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-xl font-bold text-gray-900 dark:text-gray-100 tabular-nums leading-tight">{s.value}</p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{s.label}</p>
                </div>
              </div>
            );
          })}
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* ─── Services Grid (AWS Console-style) ─── */}
          <motion.div variants={stagger.item} className="lg:col-span-2 card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Services</h3>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input
                  type="text"
                  value={serviceSearch}
                  onChange={(e) => setServiceSearch(e.target.value)}
                  placeholder="Search services"
                  className="input input-sm pl-8 w-48 text-xs"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {filteredServices.map((svc) => {
                const Icon = svc.icon;
                return (
                  <Link
                    key={svc.name}
                    href={svc.href}
                    onClick={() => trackVisit(svc.name)}
                    className="group flex items-start gap-2.5 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-blue-500 dark:hover:border-blue-500 hover:bg-blue-50/30 dark:hover:bg-blue-950/20 transition-all"
                  >
                    <div className="flex-shrink-0 w-8 h-8 rounded-md bg-gray-100 dark:bg-gray-800 group-hover:bg-blue-100 dark:group-hover:bg-blue-900/40 flex items-center justify-center transition-colors">
                      <Icon className="w-4 h-4 text-gray-600 dark:text-gray-300 group-hover:text-blue-600 dark:group-hover:text-blue-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{svc.name}</p>
                      <p className="text-[11px] text-gray-500 dark:text-gray-400 line-clamp-2">{svc.description}</p>
                    </div>
                  </Link>
                );
              })}
              {filteredServices.length === 0 && (
                <div className="col-span-full text-center py-6 text-sm text-gray-500 dark:text-gray-400">
                  No services match "{serviceSearch}"
                </div>
              )}
            </div>
          </motion.div>

          {/* ─── Recently Visited ─── */}
          <motion.div variants={stagger.item} className="card">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3 flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-gray-400" />
              Recently visited
            </h3>
            {recentServices.length > 0 ? (
              <ul className="space-y-1">
                {recentServices.map((svc) => {
                  const Icon = svc.icon;
                  return (
                    <li key={svc.name}>
                      <Link
                        href={svc.href}
                        onClick={() => trackVisit(svc.name)}
                        className="flex items-center gap-2 px-2 py-1.5 rounded text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                      >
                        <Icon className="w-4 h-4 text-gray-400" />
                        <span className="truncate">{svc.name}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="text-center py-6 text-xs text-gray-500 dark:text-gray-400">
                <Star className="w-6 h-6 mx-auto mb-2 text-gray-300 dark:text-gray-600" />
                Visit a service to see it here
              </div>
            )}
          </motion.div>
        </div>

        {/* ─── Execution Timeline (full width) ─── */}
        {timeline.length > 0 && (
          <motion.div variants={stagger.item} className="card mt-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                <Activity className="w-4 h-4 inline mr-1.5 text-gray-400" />
                Execution Trend (last 7 days)
              </h3>
              <Link href="/dashboard/reports" className="action-link text-xs">
                Full reports →
              </Link>
            </div>

            <div className="flex items-end gap-1.5 h-20">
              {timeline.map((entry) => {
                const total = entry.succeeded + entry.failed + entry.canceled;
                const height = total > 0 ? Math.max(8, (total / timelineMax) * 100) : 4;
                const failPct = total > 0 ? (entry.failed / total) * 100 : 0;
                const day = new Date(entry.period).toLocaleDateString(undefined, { weekday: 'short' });

                return (
                  <div key={entry.period} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      className="w-full rounded-md overflow-hidden relative"
                      style={{ height: `${height}%` }}
                      title={`${entry.succeeded} passed, ${entry.failed} failed`}
                    >
                      <div className="absolute inset-0 bg-green-500 dark:bg-green-400/80" />
                      {failPct > 0 && (
                        <div
                          className="absolute bottom-0 inset-x-0 bg-red-500 dark:bg-red-400/80"
                          style={{ height: `${failPct}%` }}
                        />
                      )}
                    </div>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500">{day}</span>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-3 mt-3 text-[11px] text-gray-400 dark:text-gray-500">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-500 inline-block" /> Passed</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500 inline-block" /> Failed</span>
            </div>
          </motion.div>
        )}
      </motion.div>

      {/* Create Pipeline Modal */}
      <CreatePipelineModal
        isOpen={showCreateModal}
        onClose={() => { setShowCreateModal(false); setModalGitUrl(undefined); }}
        onSubmit={handleCreateSubmit}
        createLoading={createLoading}
        createError={createError}
        createSuccess={createSuccess}
        canCreatePublic={isSysAdmin}
        initialGitUrl={modalGitUrl}
      />
    </DashboardLayout>
  );
}
