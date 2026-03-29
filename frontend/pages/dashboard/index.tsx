import { useEffect, useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { GitBranch, ArrowRight, Upload, Wand2, Puzzle, Activity, CheckCircle2, BarChart3, XCircle } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import type { BuilderProps } from '@/types';
import { LoadingPage } from '@/components/ui/Loading';
import api from '@/lib/api';
import CreatePipelineModal from '@/components/pipeline/CreatePipelineModal';
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

// ─── Helpers ────────────────────────────────────────────

const stagger = {
  container: { hidden: {}, show: { transition: { staggerChildren: 0.06 } } },
  item: { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } },
};

// ─── Page ───────────────────────────────────────────────

/** Dashboard home page. Git URL hero input, key stats, and execution timeline. */
export default function DashboardPage() {
  const { user, isReady, isAuthenticated, isSysAdmin } = useAuthGuard();
  const [gitUrl, setGitUrl] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [modalGitUrl, setModalGitUrl] = useState<string | undefined>();
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);

  // Stats
  const [executions, setExecutions] = useState<ExecutionCount[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [pluginSummary, setPluginSummary] = useState<PluginSummary | null>(null);

  const fetchData = useCallback(async () => {
    const [execRes, timelineRes, pluginRes] = await Promise.allSettled([
      api.getExecutionCount(),
      api.getExecutionTimeline({ interval: 'day' }),
      api.getPluginSummary(),
    ]);

    if (execRes.status === 'fulfilled') setExecutions(execRes.value.data?.pipelines || []);
    if (timelineRes.status === 'fulfilled') setTimeline((timelineRes.value.data?.timeline || []).slice(-7));
    if (pluginRes.status === 'fulfilled') setPluginSummary(pluginRes.value.data?.summary || null);
  }, []);

  useEffect(() => {
    if (isAuthenticated) fetchData();
  }, [isAuthenticated, fetchData]);

  if (!isReady || !user) return <LoadingPage />;

  // ─── Computed stats ───

  const totalExec = executions.reduce((s, p) => s + p.total, 0);
  const totalPass = executions.reduce((s, p) => s + p.succeeded, 0);
  const successRate = totalExec > 0 ? Math.round((totalPass / totalExec) * 100) : null;

  const totalFailed = executions.reduce((s, p) => s + p.failed, 0);

  const stats = [
    { label: 'Pipelines', value: String(executions.length || 0), icon: GitBranch, color: 'text-blue-500' },
    { label: 'Total Executions', value: String(totalExec), icon: BarChart3, color: 'text-indigo-500' },
    { label: 'Failed Executions', value: String(totalFailed), icon: XCircle, color: totalFailed > 0 ? 'text-red-500' : 'text-gray-400' },
    { label: 'Success Rate', value: successRate !== null ? `${successRate}%` : '--', icon: CheckCircle2, color: successRate !== null && successRate >= 90 ? 'text-green-500' : successRate !== null && successRate >= 70 ? 'text-yellow-500' : 'text-red-500' },
    { label: 'Active Plugins', value: pluginSummary ? String(pluginSummary.active) : '--', icon: Puzzle, color: 'text-purple-500' },
  ];

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

  // ─── Timeline chart helpers ───

  const timelineMax = Math.max(1, ...timeline.map(e => e.succeeded + e.failed + e.canceled));

  return (
    <DashboardLayout title="Dashboard" subtitle="Overview of pipelines, plugins, and activity">
      <motion.div variants={stagger.container} initial="hidden" animate="show" className="page-section">

        {/* Hero Section — Git URL Input */}
        <motion.div variants={stagger.item} className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Welcome back, {user.username}
          </h2>
          <p className="mt-1 text-gray-600 dark:text-gray-400">
            Generate a pipeline from any Git repository
          </p>

          <div className="mt-6 flex gap-3">
            <div className="flex-1 relative">
              <GitBranch className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 dark:text-gray-500" />
              <input
                type="text"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleGenerateFromUrl(); }}
                placeholder="https://github.com/owner/repo"
                className="input input-lg pl-12 pr-4"
              />
            </div>
            <button
              onClick={handleGenerateFromUrl}
              disabled={!gitUrl.trim()}
              className="btn btn-primary btn-lg"
            >
              Generate
              <ArrowRight className="w-5 h-5 ml-2" />
            </button>
          </div>

          <div className="mt-3 flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
            <span>or:</span>
            <button onClick={openModalTab} className="action-link-muted underline underline-offset-2">
              <Upload className="w-3.5 h-3.5 inline mr-1" />
              Upload config
            </button>
            <button onClick={openModalTab} className="action-link-muted underline underline-offset-2">
              <Wand2 className="w-3.5 h-3.5 inline mr-1" />
              Create manually
            </button>
          </div>
        </motion.div>

        {/* Stats Overview — 3 cards */}
        <motion.div variants={stagger.item} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
          {stats.map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.label} className="card py-4 px-5 flex items-center gap-3">
                <div className={`flex-shrink-0 ${s.color}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">{s.value}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{s.label}</p>
                </div>
              </div>
            );
          })}
        </motion.div>


        {/* Execution Timeline (last 7 days) — full width */}
        {timeline.length > 0 && (
          <motion.div variants={stagger.item} className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                <Activity className="w-4 h-4 inline mr-1.5 text-gray-400" />
                Execution Trend
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
