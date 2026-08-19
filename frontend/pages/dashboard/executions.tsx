// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Execution drill-down — landing target for the home page "Recent runs"
 * card and the sidebar / sidebar links. Member-users want to answer
 * "which of my pipelines is failing today" without scanning the full
 * Reports page; this is the narrow lane for that.
 *
 * The page reads the same `/api/reports/execution/count` endpoint the
 * home stats use, but renders all rows (not just the top 5) with
 * sortable columns + filters. Drilldown deep-links into the existing
 * pipeline detail page.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { EmptyState } from '@/components/ui/EmptyState';
import { Activity, Filter, RefreshCw, XCircle, CheckCircle2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterBar } from '@/components/ui/FilterBar';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { DateRangePicker } from '@/components/reports/ReportHelpers';
import { PostureHeadline } from '@/components/ui/PostureHeadline';
import { downloadCsv, datedFilename } from '@/lib/csv-export';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { ExecutionCountRow } from '@/types';

type StatusFilter = 'all' | 'failing' | 'succeeding';

export default function ExecutionsPage() {
  const { isReady, user, can } = useAuthGuard();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  // Date-range scope (empty = all-time). Both bounds are optional and forwarded
  // to the `getExecutionCount` fetch as `from`/`to`.
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Org → team rollup: only admins/owners can aggregate child-team data, and we
  // only surface the toggle when the org actually parents teams (so flat orgs
  // see no extra control). Backend independently gates the rollup to admins.
  const [includeDescendants, setIncludeDescendants] = useState(false);
  const [hasTeams, setHasTeams] = useState(false);
  // Gate on the `reports:rollup` permission, not a hardcoded role (parity with reports.tsx).
  const canRollup = can('reports:rollup');

  // Read-only fetch via the shared useFetch hook (loading/error/cancel-on-unmount
  // handled there). Refetches whenever the rollup toggle or auth-readiness changes.
  const { data, loading, error: fetchError, refetch } = useFetch(
    async (): Promise<ExecutionCountRow[]> => {
      if (!isReady || !user) return [];
      const params: { from?: string; to?: string; includeDescendants?: boolean } = {};
      if (dateFrom) params.from = dateFrom;
      if (dateTo) params.to = dateTo;
      if (includeDescendants) params.includeDescendants = true;
      const res = await api.getExecutionCount(Object.keys(params).length ? params : undefined);
      if (!res.success || !res.data) throw new Error(res.message || 'Failed to load executions');
      return res.data.pipelines;
    },
    [isReady, user?.id, includeDescendants, dateFrom, dateTo],
  );
  const rows = useMemo(() => data ?? [], [data]);
  const error = fetchError ? formatError(fetchError, 'Failed to load executions') : null;

  // Detect whether the active org parents any teams (subtree larger than self).
  useEffect(() => {
    if (!isReady || !user || !canRollup || !user.organizationId) return;
    let cancelled = false;
    void api.getOrganizationDescendants(user.organizationId)
      .then((res) => { if (!cancelled) setHasTeams((res.data?.orgIds?.length ?? 0) > 1); })
      .catch(() => { /* best-effort — no toggle if it fails */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, user, canRollup]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !(r.pipeline_name?.toLowerCase().includes(q) || r.project.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))) return false;
      if (status === 'failing' && r.failed === 0) return false;
      if (status === 'succeeding' && r.failed > 0) return false;
      return true;
    });
  }, [rows, search, status]);

  const summary = useMemo(() => {
    const totalRuns = filtered.reduce((s, r) => s + r.total, 0);
    const totalFailed = filtered.reduce((s, r) => s + r.failed, 0);
    const pipelinesWithFailures = filtered.filter((r) => r.failed > 0).length;
    return { totalRuns, totalFailed, pipelinesWithFailures };
  }, [filtered]);

  // Posture: single "how are runs doing?" headline — worst signal wins.
  const successRate = summary.totalRuns > 0 ? Math.round(((summary.totalRuns - summary.totalFailed) / summary.totalRuns) * 100) : 100;
  const posture = summary.totalRuns === 0
    ? { tone: 'gray' as const, Icon: Activity, title: 'No runs yet', detail: 'Pipeline run results will appear here' }
    : summary.totalFailed === 0
      ? { tone: 'green' as const, Icon: CheckCircle2, title: 'All clean', detail: `All ${summary.totalRuns} run${summary.totalRuns === 1 ? '' : 's'} passing` }
      : { tone: (successRate >= 80 ? 'yellow' : 'red') as 'yellow' | 'red', Icon: XCircle, title: `${summary.totalFailed} failed run${summary.totalFailed === 1 ? '' : 's'}`, detail: `across ${summary.pipelinesWithFailures} pipeline${summary.pipelinesWithFailures === 1 ? '' : 's'} · ${successRate}% passing` };

  const columns: Column<ExecutionCountRow>[] = useMemo(() => [
    {
      id: 'name',
      header: 'Pipeline',
      sortValue: (r) => r.pipeline_name || r.project,
      render: (r) => (
        <div>
          <Link
            href={`/dashboard/pipelines/${encodeURIComponent(r.id)}`}
            className="text-sm font-medium text-gray-900 dark:text-gray-100 hover:underline"
          >
            {r.pipeline_name || r.project}
          </Link>
          <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">{r.project}</div>
        </div>
      ),
    },
    {
      id: 'total',
      header: 'Runs',
      sortValue: (r) => r.total,
      cellClassName: 'text-sm text-gray-700 dark:text-gray-300',
      render: (r) => <>{r.total}</>,
    },
    {
      id: 'succeeded',
      header: 'Passed',
      sortValue: (r) => r.succeeded,
      cellClassName: 'text-sm text-green-600 dark:text-green-400',
      render: (r) => <>{r.succeeded}</>,
    },
    {
      id: 'failed',
      header: 'Failed',
      sortValue: (r) => r.failed,
      cellClassName: 'text-sm',
      render: (r) => (
        <span className={r.failed > 0 ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-500 dark:text-gray-400'}>
          {r.failed}
        </span>
      ),
    },
    {
      id: 'rate',
      header: 'Success rate',
      sortValue: (r) => (r.total > 0 ? r.succeeded / r.total : -1),
      cellClassName: 'text-sm',
      render: (r) => {
        if (r.total === 0) return <span className="text-gray-400">—</span>;
        const pct = Math.round((r.succeeded / r.total) * 100);
        return (
          <Badge color={pct >= 95 ? 'green' : pct >= 80 ? 'yellow' : 'red'}>{pct}%</Badge>
        );
      },
    },
    {
      id: 'last',
      header: 'Last run',
      sortValue: (r) => r.last_execution || '',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      render: (r) => <RelativeTime value={r.last_execution} />,
    },
  ], []);

  // "Pristine empty" = no runs at all AND no filters applied. In that case the
  // posture banner + 0-value stat cards + search are all noise (three ways of
  // saying "nothing here"), so collapse to a single empty state with a CTA.
  const anyFilterActive = Boolean(search || status !== 'all' || dateFrom || dateTo || includeDescendants);
  const pristineEmpty = !loading && !error && rows.length === 0 && !anyFilterActive;

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Executions"
      subtitle="Pipeline run health across the organization"
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => downloadCsv(
              filtered.map((r) => ({
                pipeline: r.pipeline_name || '',
                project: r.project,
                organization: r.organization,
                total: r.total,
                succeeded: r.succeeded,
                failed: r.failed,
                canceled: r.canceled,
                last_execution: r.last_execution ?? '',
              })),
              ['pipeline', 'project', 'organization', 'total', 'succeeded', 'failed', 'canceled', 'last_execution'],
              datedFilename('executions'),
            )}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1"
            title="Export current view as CSV"
          >
            CSV
          </Button>
          <Button variant="secondary" onClick={() => refetch()} className="inline-flex items-center gap-1" disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      }
    >
      <ErrorAlert message={error} />

      {pristineEmpty ? (
        <EmptyState
          icon={Activity}
          title="No executions yet"
          description="Run a pipeline to generate results — run history and pass/fail health show up here."
          action={<Button onClick={() => router.push('/dashboard/pipelines')}>Go to Pipelines</Button>}
        />
      ) : (
      <>
      {/* Posture headline — answers "how are runs doing?" at a glance */}
      <PostureHeadline
        tone={posture.tone}
        Icon={posture.Icon}
        title={posture.title}
        detail={posture.detail}
        rate={summary.totalRuns > 0 ? successRate : undefined}
        className="mb-4"
      />

      {/* Stat strip — at-a-glance health; cards double as filters */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <button
          type="button"
          onClick={() => setStatus('all')}
          aria-pressed={status === 'all'}
          title="Show all pipelines"
          className={`card text-center transition-colors hover:border-gray-300 dark:hover:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 ${status === 'all' ? 'ring-1 ring-blue-500' : ''}`}
        >
          <div className="text-xs text-gray-500 dark:text-gray-400">Total runs</div>
          <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{summary.totalRuns}</div>
        </button>
        <button
          type="button"
          onClick={() => setStatus(status === 'failing' ? 'all' : 'failing')}
          aria-pressed={status === 'failing'}
          title={status === 'failing' ? 'Clear filter' : 'Show failing pipelines'}
          className={`card text-center transition-colors hover:border-gray-300 dark:hover:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 ${status === 'failing' ? 'ring-1 ring-blue-500' : ''}`}
        >
          <div className="text-xs text-gray-500 dark:text-gray-400">Failed runs</div>
          <div className={`text-2xl font-semibold ${summary.totalFailed > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}`}>
            {summary.totalFailed}
          </div>
        </button>
        <button
          type="button"
          onClick={() => setStatus(status === 'failing' ? 'all' : 'failing')}
          aria-pressed={status === 'failing'}
          title={status === 'failing' ? 'Clear filter' : 'Show failing pipelines'}
          className={`card text-center transition-colors hover:border-gray-300 dark:hover:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 ${status === 'failing' ? 'ring-1 ring-blue-500' : ''}`}
        >
          <div className="text-xs text-gray-500 dark:text-gray-400">Pipelines with failures</div>
          <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-2">
            {summary.pipelinesWithFailures}
            {summary.pipelinesWithFailures > 0 ? <XCircle className="w-5 h-5 text-red-500" /> : <CheckCircle2 className="w-5 h-5 text-green-500" />}
          </div>
        </button>
      </div>

      <FilterBar
        sticky
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search pipelines... (press /)"
        showAdvanced={showAdvanced}
        onToggleAdvanced={() => setShowAdvanced(!showAdvanced)}
        advancedFilterCount={(status !== 'all' ? 1 : 0) + (includeDescendants ? 1 : 0) + (dateFrom || dateTo ? 1 : 0)}
        onClearAll={() => { setSearch(''); setStatus('all'); setIncludeDescendants(false); setDateFrom(''); setDateTo(''); }}
        advancedContent={
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-gray-400" />
              <FilterSelect
                value={status}
                onChange={(e) => setStatus(e.target.value as StatusFilter)}
                aria-label="Filter by pipeline status"
              >
                <option value="all">All pipelines</option>
                <option value="failing">Failing (≥1 fail)</option>
                <option value="succeeding">All-clean</option>
              </FilterSelect>
            </div>
            {/* Date-range scope — empty bounds mean all-time. */}
            <DateRangePicker from={dateFrom} to={dateTo} onFromChange={setDateFrom} onToChange={setDateTo} />
            {canRollup && hasTeams && (
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300" title="Aggregate executions across this organization and its teams">
                <Checkbox
                  checked={includeDescendants}
                  onChange={(e) => setIncludeDescendants(e.target.checked)}
                />
                Include child teams
              </label>
            )}
          </div>
        }
      />

      <DataTable
        data={filtered}
        columns={columns}
        isLoading={loading}
        emptyState={{
          icon: Activity,
          title: 'No executions yet',
          description: search || status !== 'all' || dateFrom || dateTo ? 'Try clearing filters.' : 'Run a pipeline to see results here.',
        }}
        getRowKey={(r) => r.id}
        defaultSortColumn="last"
        defaultSortDirection="desc"
      />
      </>
      )}
    </DashboardLayout>
  );
}
