import { useEffect, useMemo, useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  GitBranch, ArrowRight, Upload, Wand2, Puzzle, Activity, CheckCircle2,
  BarChart3, XCircle, Inbox,
} from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { BuilderProps, ExecutionCountRow } from '@/types';
import { LoadingPage } from '@/components/ui/Loading';
import api from '@/lib/api';
import CreatePipelineModal from '@/components/pipeline/CreatePipelineModal';
import { NewOrgWelcome } from '@/components/dashboard/NewOrgWelcome';
import { SysadminHome } from '@/components/dashboard/SysadminHome';
import { OrgAdminHome } from '@/components/dashboard/OrgAdminHome';
import { dismissKey, isFreshAccount, shouldShowOnboarding, visitedPluginsKey } from '@/lib/onboarding';

// ─── Types ──────────────────────────────────────────────

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
  container: { hidden: {}, show: { transition: { staggerChildren: 0.04 } } },
  item: { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.2 } } },
};

// ─── Page ───────────────────────────────────────────────

/**
 * Dashboard home. Orients the user toward action: a primary "create a pipeline"
 * hero, then role-adaptive signal (sysadmin fleet ops / org-admin health), and
 * for members their personal action items (recent runs + inbox) BEFORE the
 * org-wide stats and trend. The old AWS-Console-style service tile grid was
 * removed — it duplicated the sidebar; navigation lives in one place now.
 */
export default function DashboardPage() {
  const { user, isReady, isAuthenticated, isSuperAdmin, isAdmin } = useAuthGuard();
  // Org admin = admin/owner WITHIN their org (not sysadmin). Sysadmin gets
  // a separate, operations-focused home; this gate keeps the org-admin
  // home from displacing the platform-admin one.
  const isOrgAdmin = isAdmin && !isSuperAdmin;
  const [gitUrl, setGitUrl] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [modalGitUrl, setModalGitUrl] = useState<string | undefined>();
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);

  // Stats
  const [executions, setExecutions] = useState<ExecutionCountRow[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  // Execution Trend window (days). Drives the getSuccessRate from/to range.
  const [trendRange, setTrendRange] = useState<7 | 30 | 90>(7);
  const [pluginSummary, setPluginSummary] = useState<PluginSummary | null>(null);
  const [pipelineCount, setPipelineCount] = useState<number | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [unreadMessageCount, setUnreadMessageCount] = useState(0);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [onboardingVisitedPlugins, setOnboardingVisitedPlugins] = useState(false);

  const fetchData = useCallback(async () => {
    // Org-admin/owner only: a cheap member-count probe (1-row page, read from
    // pagination.total) so a fresh account can be distinguished from an active
    // one — an owner who has invited a teammate has "started" and graduates to
    // the org-admin home. Gated so member-users don't 403 on the roster.
    const memberPromise = isOrgAdmin && user?.organizationId
      ? api.getOrganizationMembers(user.organizationId, { limit: 1 }).catch(() => null)
      : Promise.resolve(null);

    const [execRes, pluginRes, pipelineRes, unreadRes, memberRes] = await Promise.allSettled([
      api.getExecutionCount(),
      api.getPluginSummary(),
      api.listPipelines({ limit: '1' }),
      api.getUnreadCount(),
      memberPromise,
    ]);

    if (execRes.status === 'fulfilled') setExecutions(execRes.value.data?.pipelines || []);
    if (pluginRes.status === 'fulfilled') setPluginSummary(pluginRes.value.data?.summary || null);
    if (pipelineRes.status === 'fulfilled') setPipelineCount(pipelineRes.value.data?.pagination?.total ?? 0);
    if (unreadRes.status === 'fulfilled') setUnreadMessageCount(unreadRes.value.data?.count ?? 0);
    if (memberRes.status === 'fulfilled' && memberRes.value?.success && memberRes.value.data) {
      setMemberCount(memberRes.value.data.pagination?.total ?? memberRes.value.data.members.length);
    }
  }, [isOrgAdmin, user?.organizationId]);

  useEffect(() => {
    if (isAuthenticated) fetchData();
  }, [isAuthenticated, fetchData]);

  // Execution Trend timeline — fetched separately so changing the range window
  // only re-hits the success-rate report, not the whole dashboard. Guarded with a
  // `cancelled` flag so quickly toggling 7/30/90 can't let an earlier response
  // land after a later one (stale overwrite).
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    (async () => {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - trendRange);
      try {
        const res = await api.getSuccessRate({
          interval: 'day',
          from: from.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
        });
        if (!cancelled) setTimeline((res.data?.timeline || []).slice(-trendRange));
      } catch { /* best-effort — leave the previous timeline in place */ }
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated, trendRange]);

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
      // Prefer the actual pipeline total (includes never-run pipelines); fall
      // back to the count that appear in the executions report only until it loads.
      { label: 'Pipelines', value: String(pipelineCount ?? executions.length ?? 0), icon: GitBranch, color: 'text-blue-500' },
      { label: 'Total Executions', value: String(totalExec), icon: BarChart3, color: 'text-indigo-500' },
      { label: 'Failed Executions', value: String(totalFailed), icon: XCircle, color: totalFailed > 0 ? 'text-red-500' : 'text-gray-400' },
      { label: 'Success Rate', value: successRate !== null ? `${successRate}%` : '--', icon: CheckCircle2, color: successRate !== null && successRate >= 90 ? 'text-green-500' : successRate !== null && successRate >= 70 ? 'text-yellow-500' : 'text-red-500' },
      { label: 'Active Plugins', value: pluginSummary ? String(pluginSummary.active) : '--', icon: Puzzle, color: 'text-purple-500' },
    ];
  }, [executions, pluginSummary, pipelineCount]);

  const timelineMax = useMemo(
    () => Math.max(1, ...timeline.map(e => e.succeeded + e.failed + e.canceled)),
    [timeline],
  );

  // Shared onboarding inputs — one source of truth for both the member card and
  // the new-owner card below.
  const executionTotal = useMemo(() => executions.reduce((s, p) => s + p.total, 0), [executions]);
  const onboardingSignals = useMemo(() => ({
    visitedPlugins: onboardingVisitedPlugins,
    pipelineCount: pipelineCount ?? 0,
    executionCount: executionTotal,
  }), [onboardingVisitedPlugins, pipelineCount, executionTotal]);

  const dismissOnboarding = useCallback(() => {
    if (typeof window !== 'undefined' && user?.organizationId) {
      try { localStorage.setItem(dismissKey(user.organizationId), '1'); } catch { /* localStorage may be unavailable */ }
    }
    setOnboardingDismissed(true);
  }, [user?.organizationId]);

  // New owner/admin on a fresh, empty account: show the getting-started guide
  // (the org-admin home's quota/compliance/billing cards are all empty and
  // un-actionable on day one). Only decided once pipeline data has loaded, and
  // it graduates to <OrgAdminHome> as soon as the org has any activity.
  const showOwnerOnboarding = isOrgAdmin
    && pipelineCount !== null
    && isFreshAccount(
      { pipelineCount: pipelineCount ?? 0, executionCount: executionTotal, memberCount },
      onboardingDismissed,
    );

  if (!isReady || !user) return <LoadingPage />;

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
    <DashboardLayout title="Home" subtitle={`Welcome back, ${user.username}`}>
      <motion.div variants={stagger.container} initial="hidden" animate="show" className="page-section">

        {/* ─── Primary action: generate a pipeline from Git ─── */}
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
                  <Input
                    type="text"
                    value={gitUrl}
                    onChange={(e) => setGitUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleGenerateFromUrl(); }}
                    placeholder="https://github.com/owner/repo"
                    className="pl-9"
                  />
                </div>
                <Button onClick={handleGenerateFromUrl} disabled={!gitUrl.trim()}>
                  Generate
                  <ArrowRight className="w-4 h-4 ml-1.5" />
                </Button>
              </div>
              <div className="mt-2 flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                <button onClick={openModalTab} className="action-link-muted underline">
                  <Upload className="w-3 h-3 inline mr-0.5" /> Upload config
                </button>
                <button onClick={openModalTab} className="action-link-muted underline">
                  <Wand2 className="w-3 h-3 inline mr-0.5" /> Create manually
                </button>
                <Link href="/dashboard/templates" className="action-link-muted underline">
                  <Puzzle className="w-3 h-3 inline mr-0.5" /> Start from a template
                </Link>
              </div>
            </div>
          </div>
        </motion.div>

        {/* ─── Role-specific home view ─── */}
        {/* Sysadmin: operations-focused (fleet stats, RLS posture, recent audit).
            Org-admin: health-focused (quotas, compliance, billing, team).
            Member-user: continues with personal activity + stats + timeline below. */}
        {isSuperAdmin && (
          <motion.div variants={stagger.item}>
            <SysadminHome />
          </motion.div>
        )}
        {isOrgAdmin && (
          <motion.div variants={stagger.item}>
            {showOwnerOnboarding ? (
              <NewOrgWelcome signals={onboardingSignals} onDismiss={dismissOnboarding} />
            ) : (
              <OrgAdminHome organizationId={user.organizationId} />
            )}
          </motion.div>
        )}

        {/* ─── Member-only stack: onboarding → action items → stats → timeline ─── */}
        {/* Sysadmin and org-admin get richer signals from their role-home above;
            showing the generic org-wide stats too would be noise. */}
        {!isSuperAdmin && !isOrgAdmin && (<>

        {/* New-org onboarding (auto-hides once user has both pipelines and executions). */}
        {pipelineCount !== null && shouldShowOnboarding(onboardingSignals, onboardingDismissed) && (
          <motion.div variants={stagger.item}>
            <NewOrgWelcome signals={onboardingSignals} onDismiss={dismissOnboarding} />
          </motion.div>
        )}

        {/* Personal action items FIRST — the user lands on what's theirs (recent
            runs + inbox) before the generic org-wide numbers. */}
        <MyRecentActivity executions={executions} unreadCount={unreadMessageCount} />

        {/* Org-wide stats strip. */}
        <motion.div variants={stagger.item} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
          {stats.map((s) => {
            const Icon = s.icon;
            return (
              <Card key={s.label} className="py-3 px-4 flex items-center gap-3">
                <div className={`flex-shrink-0 ${s.color}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-xl font-bold text-gray-900 dark:text-gray-100 tabular-nums leading-tight">{s.value}</p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{s.label}</p>
                </div>
              </Card>
            );
          })}
        </motion.div>

        </>)}

        {/* ─── Execution Timeline (full width) ─── */}
        {/* Hidden for sysadmins (their cross-tenant feed already covers
            "is the platform busy"); org-admins still see it as a quick
            org-wide pipeline-health signal alongside their health cards. */}
        {!isSuperAdmin && timeline.length > 0 && (
          <motion.div variants={stagger.item} className="card mt-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                <Activity className="w-4 h-4 inline mr-1.5 text-gray-400" />
                Execution Trend (last {trendRange} days)
              </h3>
              <div className="flex items-center gap-3">
                <div className="inline-flex items-center gap-1" role="group" aria-label="Trend range">
                  {([7, 30, 90] as const).map((days) => (
                    <button
                      key={days}
                      type="button"
                      onClick={() => setTrendRange(days)}
                      aria-pressed={trendRange === days}
                      className={`px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${trendRange === days
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                    >
                      {days}d
                    </button>
                  ))}
                </div>
                <Link href="/dashboard/reports" className="action-link text-xs">
                  Full reports →
                </Link>
              </div>
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
        canCreatePublic={isSuperAdmin}
        initialGitUrl={modalGitUrl}
      />
    </DashboardLayout>
  );
}

/**
 * "My recent activity" strip — the user's own recent runs + unread messages,
 * surfaced first so the home leads with what's personally actionable. Sourced
 * entirely from data the home already loads (no extra round trips). Links to the
 * fuller Inbox and Executions pages.
 */
function MyRecentActivity({
  executions,
  unreadCount,
}: {
  executions: ExecutionCountRow[];
  unreadCount: number;
}) {
  const recent = [...executions]
    .filter((e) => !!e.last_execution)
    .sort((a, b) => (b.last_execution || '').localeCompare(a.last_execution || ''))
    .slice(0, 5);

  if (recent.length === 0 && unreadCount === 0) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
      <Card className="md:col-span-2">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
            <Activity className="w-4 h-4 text-gray-400" />
            Recent runs
          </h3>
          <Link href="/dashboard/executions" className="action-link text-xs">View all →</Link>
        </div>
        {recent.length === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400 py-2">No pipeline runs yet.</div>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {recent.map((e) => {
              const okPct = e.total > 0 ? Math.round((e.succeeded / e.total) * 100) : null;
              const failed = e.failed > 0;
              return (
                <li key={e.id} className="py-1.5 flex items-center justify-between gap-2 text-sm">
                  <Link
                    href={`/dashboard/pipelines/${encodeURIComponent(e.id)}`}
                    className="flex-1 truncate text-gray-800 dark:text-gray-200 hover:underline"
                    title={e.id}
                  >
                    {e.pipeline_name || e.project || e.id}
                  </Link>
                  <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2 whitespace-nowrap">
                    {failed
                      ? <span className="text-red-500 dark:text-red-400">{e.failed} failed</span>
                      : okPct !== null && <span className="text-green-600 dark:text-green-400">{okPct}% ok</span>}
                    <RelativeTime value={e.last_execution} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
            <Inbox className="w-4 h-4 text-gray-400" />
            Inbox
          </h3>
          <Link href="/dashboard/inbox" className="action-link text-xs">Open →</Link>
        </div>
        {unreadCount === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400 py-2">No unread messages.</div>
        ) : (
          <div className="py-2">
            <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{unreadCount}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">unread message{unreadCount === 1 ? '' : 's'}</div>
          </div>
        )}
      </Card>
    </div>
  );
}
