import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { GitBranch, ArrowRight, Upload, Wand2, Clock } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { pct, fmtNum, barColor } from '@/lib/quota-helpers';
import type { OrgQuotaResponse, QuotaType, Pipeline, BuilderProps } from '@/types';
import { LoadingPage } from '@/components/ui/Loading';
import api from '@/lib/api';
import CreatePipelineModal from '@/components/pipeline/CreatePipelineModal';

/** Dashboard home page. Git URL hero input, recent pipelines, and quota summary. */
export default function DashboardPage() {
  const { user, isReady, isAuthenticated, isAdmin } = useAuthGuard();
  const [quotaData, setQuotaData] = useState<OrgQuotaResponse | null>(null);
  const [recentPipelines, setRecentPipelines] = useState<Pipeline[]>([]);
  const [gitUrl, setGitUrl] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [modalGitUrl, setModalGitUrl] = useState<string | undefined>();
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);

  const fetchQuotas = useCallback(async () => {
    try {
      const res = await api.getOwnQuotas();
      setQuotaData((res.data?.quota || res.data) as OrgQuotaResponse);
    } catch {
      // Quota service may not be reachable
    }
  }, []);

  const fetchRecentPipelines = useCallback(async () => {
    try {
      const res = await api.listPipelines({ sortBy: 'createdAt', sortOrder: 'desc', limit: '5' });
      setRecentPipelines(res.data?.pipelines || []);
    } catch {
      // Pipeline service may not be reachable
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      fetchQuotas();
      fetchRecentPipelines();
    }
  }, [isAuthenticated, fetchQuotas, fetchRecentPipelines]);

  if (!isReady || !user) return <LoadingPage />;

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
      fetchRecentPipelines();
      fetchQuotas();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create pipeline';
      setCreateError(message);
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

  const QUOTA_LABELS: Record<QuotaType, string> = { plugins: 'Plugins', pipelines: 'Pipelines', apiCalls: 'API Calls' };

  return (
    <DashboardLayout title="Dashboard">
      {/* Hero Section — Git URL Input */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="mb-8"
      >
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
              className="w-full pl-12 pr-4 py-3 rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-base focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors placeholder:text-gray-400 dark:placeholder:text-gray-500"
            />
          </div>
          <button
            onClick={handleGenerateFromUrl}
            disabled={!gitUrl.trim()}
            className="btn btn-primary px-6 py-3 text-base"
          >
            Generate
            <ArrowRight className="w-5 h-5 ml-2" />
          </button>
        </div>

        <div className="mt-3 flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
          <span>or:</span>
          <button
            onClick={() => openModalTab()}
            className="hover:text-gray-700 dark:hover:text-gray-300 underline underline-offset-2"
          >
            <Upload className="w-3.5 h-3.5 inline mr-1" />
            Upload config
          </button>
          <button
            onClick={() => openModalTab()}
            className="hover:text-gray-700 dark:hover:text-gray-300 underline underline-offset-2"
          >
            <Wand2 className="w-3.5 h-3.5 inline mr-1" />
            Create manually
          </button>
        </div>
      </motion.div>

      {/* Recent Pipelines + Quotas */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Pipelines */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
          className="lg:col-span-2 card"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Recent Pipelines</h3>
            <Link href="/dashboard/pipelines" className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">
              View all →
            </Link>
          </div>

          {recentPipelines.length > 0 ? (
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {recentPipelines.map((p) => (
                <Link
                  key={p.id}
                  href={`/dashboard/pipelines/${p.id}`}
                  className="flex items-center justify-between py-3 px-2 -mx-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400">
                      {p.pipelineName || p.id}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                      {p.project} · {p.organization}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-4 shrink-0">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      p.isActive
                        ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                    }`}>
                      {p.isActive ? 'Active' : 'Inactive'}
                    </span>
                    <Clock className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
              No pipelines yet. Paste a Git URL above to get started.
            </p>
          )}
        </motion.div>

        {/* Quota Usage */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.15 }}
          className="card"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Quota Usage</h3>
            <Link href="/dashboard/quotas" className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">
              Manage →
            </Link>
          </div>

          {quotaData ? (
            <div className="space-y-4">
              {(['plugins', 'pipelines', 'apiCalls'] as QuotaType[]).map((key) => {
                const q = quotaData.quotas[key];
                const p = pct(q.used, q.limit);
                const pDisplay = q.unlimited ? 15 : p;
                const color = barColor(q.used, q.limit, q.unlimited);

                return (
                  <div key={key}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="font-medium text-gray-700 dark:text-gray-300">{QUOTA_LABELS[key]}</span>
                      <span className="text-gray-500 dark:text-gray-400 tabular-nums">
                        {fmtNum(q.used)} / {fmtNum(q.limit)}
                      </span>
                    </div>
                    <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-700 ${color}`}
                        style={{ width: `${pDisplay}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-4">
              {[0, 1, 2].map((i) => (
                <div key={i}>
                  <div className="h-4 skeleton w-1/3 mb-2" />
                  <div className="h-1.5 skeleton rounded-full" />
                </div>
              ))}
            </div>
          )}
        </motion.div>
      </div>

      {/* Create Pipeline Modal */}
      <CreatePipelineModal
        isOpen={showCreateModal}
        onClose={() => { setShowCreateModal(false); setModalGitUrl(undefined); }}
        onSubmit={handleCreateSubmit}
        createLoading={createLoading}
        createError={createError}
        createSuccess={createSuccess}
        canCreatePublic={isAdmin}
        initialGitUrl={modalGitUrl}
      />
    </DashboardLayout>
  );
}
